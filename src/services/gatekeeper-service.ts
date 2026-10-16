import type Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext, CoreMessage, WhatsAppPort, MessageGateResult } from '../framework/contracts.js'
import { initSqliteDatabase, requireDatabase, type DatabaseInstance } from '../storage-helpers.js'
import { isGroupJid } from '../framework/validation.js'
import type { RedisService } from '../redis.js'

export type GateMode = 'strict' | 'permissive' | 'strict_walled_garden'

export interface OfficialGroupRecord {
  readonly jid: string
  readonly name: string
  readonly isOocHub: boolean
  readonly remoteSilenced: boolean
  readonly sniffOnce: boolean
  readonly memberCount: number
  readonly addedAt: number
  readonly addedBy: string
}

export interface GuestTrialRecord {
  readonly canonicalId: string
  readonly phoneJid?: string
  readonly lidJid?: string
  readonly startedAt: number
  readonly expiresAt: number
  readonly commandCount: number
  readonly lastCommand?: string
  readonly lastSeenAt: number
}

export interface ShadowbanRecord {
  readonly targetJid: string
  readonly reason: string
  readonly bannedAt: number
}

export interface GatekeeperServiceOptions {
  readonly whatsapp?: WhatsAppPort
  readonly defaultTrialDurationSec?: number
  readonly redis?: RedisService
}

const EXEMPT_DM_COMMANDS = new Set<string>(['menfess', 'confess'])
const STRICT_MEMBER_DM_COMMANDS = new Set<string>(['suggest', 'report', 'saran', 'lapor'])

export class GatekeeperService implements Service {
  readonly name = 'gatekeeper'
  private db?: DatabaseInstance

  private readonly officialGroupsSet = new Set<string>()
  private readonly silencedGroupsSet = new Set<string>()
  private readonly officialMembersSet = new Set<string>()
  private readonly shadowbanSet = new Set<string>()
  private readonly lidToPhoneMap = new Map<string, string>()
  private readonly phoneToLidMap = new Map<string, string>()

  private gateMode: GateMode = 'strict'
  private oocGroupJid: string = ''
  private oocStaticLink: string = 'https://chat.whatsapp.com/AllysseaOfficialPlaceholder'
  private trialDurationSec: number = 43_200 // 12 hours

  constructor(
    private readonly databasePath: string,
    private readonly logger: Logger,
    private readonly ownerJid?: string,
    private readonly options: GatekeeperServiceOptions = {},
  ) {
    if (options.defaultTrialDurationSec) {
      this.trialDurationSec = options.defaultTrialDurationSec
    }
  }

  initialize(_context: ServiceContext): void {
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
    this.migrate()
    this.hydrateCaches()
    this.logger.info({ component: 'gatekeeper', gateMode: this.gateMode }, 'GatekeeperService initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) {
      this.db.close()
    }
    this.db = undefined
    this.officialGroupsSet.clear()
    this.silencedGroupsSet.clear()
    this.officialMembersSet.clear()
    this.shadowbanSet.clear()
  }

  private database(): DatabaseInstance {
    return requireDatabase(this.db, 'gatekeeper')
  }

  private migrate(): void {
    const db = this.database()
    db.exec(`
      CREATE TABLE IF NOT EXISTS community_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        added_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS community_blacklist (
        jid TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        banned_at INTEGER NOT NULL,
        banned_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trial_guests (
        canonical_id TEXT PRIMARY KEY,
        phone_jid TEXT,
        lid_jid TEXT,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        command_count INTEGER NOT NULL DEFAULT 1,
        last_command TEXT,
        last_seen_at INTEGER NOT NULL,
        notified_expiry INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS remote_inspect_sessions (
        group_jid TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        filter_mode TEXT NOT NULL DEFAULT 'all',
        owner_jid TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        forwarded_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS dev_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS identity_map (
        lid_jid TEXT PRIMARY KEY,
        phone_jid TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shadowbanned_users (
        target_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL DEFAULT 'Disruptive behavior',
        created_at INTEGER NOT NULL
      );
    `)

    // Upgrade community_groups columns if needed
    const cols = db.prepare('PRAGMA table_info(community_groups)').all() as Array<{ name: string }>
    const colNames = new Set(cols.map((c) => c.name))
    if (!colNames.has('is_ooc_hub')) db.exec('ALTER TABLE community_groups ADD COLUMN is_ooc_hub INTEGER NOT NULL DEFAULT 0')
    if (!colNames.has('remote_silenced')) db.exec('ALTER TABLE community_groups ADD COLUMN remote_silenced INTEGER NOT NULL DEFAULT 0')
    if (!colNames.has('sniff_once')) db.exec('ALTER TABLE community_groups ADD COLUMN sniff_once INTEGER NOT NULL DEFAULT 0')
    if (!colNames.has('member_count')) db.exec('ALTER TABLE community_groups ADD COLUMN member_count INTEGER NOT NULL DEFAULT 0')
    if (!colNames.has('updated_at')) db.exec('ALTER TABLE community_groups ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0')

    // Indexes
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_guests_phone ON trial_guests(phone_jid) WHERE phone_jid IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_guests_lid ON trial_guests(lid_jid) WHERE lid_jid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_trial_guests_expires ON trial_guests(expires_at);
      CREATE INDEX IF NOT EXISTS idx_identity_map_phone ON identity_map(phone_jid);

      INSERT OR IGNORE INTO dev_settings (key, value, updated_at) VALUES
        ('gate_mode', 'strict', unixepoch()),
        ('ooc_group_jid', '', unixepoch()),
        ('ooc_static_link', 'https://chat.whatsapp.com/AllysseaOfficialPlaceholder', unixepoch()),
        ('anticall_enabled', '1', unixepoch()),
        ('trial_duration_sec', '43200', unixepoch());
    `)
  }

  public hydrateCaches(): void {
    const db = this.database()
    this.officialGroupsSet.clear()
    this.silencedGroupsSet.clear()
    this.shadowbanSet.clear()

    const groups = db.prepare('SELECT jid, is_ooc_hub, remote_silenced FROM community_groups').all() as Array<{
      jid: string
      is_ooc_hub: number
      remote_silenced: number
    }>
    for (const g of groups) {
      this.officialGroupsSet.add(g.jid)
      if (g.remote_silenced === 1) this.silencedGroupsSet.add(g.jid)
      if (g.is_ooc_hub === 1) this.oocGroupJid = g.jid
    }

    const bans = db.prepare('SELECT target_id FROM shadowbanned_users').all() as Array<{ target_id: string }>
    for (const b of bans) this.shadowbanSet.add(b.target_id)

    const identities = db.prepare('SELECT lid_jid, phone_jid FROM identity_map').all() as Array<{
      lid_jid: string
      phone_jid: string
    }>
    for (const id of identities) {
      this.lidToPhoneMap.set(id.lid_jid, id.phone_jid)
      this.phoneToLidMap.set(id.phone_jid, id.lid_jid)
    }

    const settings = db.prepare('SELECT key, value FROM dev_settings').all() as Array<{ key: string; value: string }>
    for (const s of settings) {
      if (s.key === 'gate_mode') this.gateMode = s.value as GateMode
      if (s.key === 'ooc_group_jid' && s.value) this.oocGroupJid = s.value
      if (s.key === 'ooc_static_link') this.oocStaticLink = s.value
      if (s.key === 'trial_duration_sec') this.trialDurationSec = Number(s.value) || 43_200
    }
  }

  public isOwner(jid?: string): boolean {
    if (!jid || !this.ownerJid) return false
    const cleanId = (val: string): string => {
      const noDevice = val.split(':')[0] ?? val
      const atIndex = noDevice.indexOf('@')
      return atIndex >= 0 ? noDevice.slice(0, atIndex) : noDevice
    }

    const cleanOwner = cleanId(this.ownerJid)
    const cleanSender = cleanId(jid)
    if (cleanOwner === cleanSender) return true

    // Normalize JID lookups in identity maps
    const candidates = [
      jid,
      jid.split(':')[0],
      `${cleanSender}@lid`,
      `${cleanSender}@s.whatsapp.net`,
    ].filter((c): c is string => Boolean(c))

    for (const cand of candidates) {
      const mapped = this.lidToPhoneMap.get(cand) ?? this.phoneToLidMap.get(cand)
      if (mapped && cleanId(mapped) === cleanOwner) return true
    }

    return false
  }

  public isShadowbanned(jid?: string): boolean {
    if (!jid) return false
    const bare = jid.split(':')[0]
    if (this.shadowbanSet.has(jid) || this.shadowbanSet.has(bare)) return true
    const mapped = this.lidToPhoneMap.get(jid) ?? this.phoneToLidMap.get(jid)
    if (mapped && (this.shadowbanSet.has(mapped) || this.shadowbanSet.has(mapped.split(':')[0]))) return true
    return false
  }

  public shadowban(target: string, reason: string): void {
    const bare = target.split(':')[0]
    const db = this.database()
    db.prepare(`
      INSERT INTO shadowbanned_users (target_id, reason, created_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(target_id) DO UPDATE SET reason = excluded.reason
    `).run(bare, reason)
    this.shadowbanSet.add(bare)
  }

  public addShadowban(target: string, reason: string, _actor?: string): void {
    this.shadowban(target, reason)
  }

  public unshadowban(target: string): boolean {
    const bare = target.split(':')[0]
    const db = this.database()
    const result = db.prepare('DELETE FROM shadowbanned_users WHERE target_id = ?').run(bare)
    this.shadowbanSet.delete(bare)
    return result.changes > 0
  }

  public removeShadowban(target: string): boolean {
    return this.unshadowban(target)
  }

  public listShadowbans(): ShadowbanRecord[] {
    const db = this.database()
    const rows = db.prepare('SELECT target_id, reason, created_at FROM shadowbanned_users ORDER BY created_at DESC').all() as Array<{
      target_id: string
      reason: string
      created_at: number
    }>
    return rows.map((r) => ({
      targetJid: r.target_id,
      reason: r.reason,
      bannedAt: r.created_at,
    }))
  }

  public isGroupOfficial(groupJid: string): boolean {
    return this.officialGroupsSet.has(groupJid)
  }

  public isGroupSilenced(groupJid: string): boolean {
    return this.silencedGroupsSet.has(groupJid)
  }

  public setGroupSilenced(groupJid: string, silenced: boolean): void {
    const db = this.database()
    const val = silenced ? 1 : 0
    db.prepare('UPDATE community_groups SET remote_silenced = ?, updated_at = unixepoch() WHERE jid = ?').run(val, groupJid)
    if (silenced) {
      this.silencedGroupsSet.add(groupJid)
    } else {
      this.silencedGroupsSet.delete(groupJid)
    }
  }

  public silenceGroup(groupJid: string, silenced: boolean): void {
    this.setGroupSilenced(groupJid, silenced)
  }

  public isOfficialMember(jid?: string): boolean {
    if (!jid) return false
    const bare = jid.split(':')[0]
    if (this.officialMembersSet.has(jid) || this.officialMembersSet.has(bare)) return true
    const mapped = this.lidToPhoneMap.get(jid) ?? this.phoneToLidMap.get(jid)
    if (mapped && (this.officialMembersSet.has(mapped) || this.officialMembersSet.has(mapped.split(':')[0]))) return true
    return false
  }

  public addOfficialMembers(jids: readonly string[]): void {
    for (const jid of jids) {
      if (!jid) continue
      const bare = jid.split(':')[0]
      this.officialMembersSet.add(jid)
      this.officialMembersSet.add(bare)
      const mapped = this.lidToPhoneMap.get(jid) ?? this.phoneToLidMap.get(jid)
      if (mapped) {
        this.officialMembersSet.add(mapped)
        this.officialMembersSet.add(mapped.split(':')[0])
      }
    }
  }

  public removeOfficialMember(jid: string): void {
    const bare = jid.split(':')[0]
    this.officialMembersSet.delete(jid)
    this.officialMembersSet.delete(bare)
  }

  public getGateMode(): GateMode {
    return this.gateMode
  }

  public setGateMode(mode: GateMode): void {
    this.gateMode = mode
    const db = this.database()
    db.prepare(`
      INSERT INTO dev_settings (key, value, updated_at) VALUES ('gate_mode', ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
    `).run(mode)
  }

  public setOocGroup(groupJid: string): void {
    this.oocGroupJid = groupJid
    const db = this.database()
    db.prepare(`
      INSERT INTO dev_settings (key, value, updated_at) VALUES ('ooc_group_jid', ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
    `).run(groupJid)
    db.prepare('UPDATE community_groups SET is_ooc_hub = 0 WHERE is_ooc_hub = 1').run()
    db.prepare('UPDATE community_groups SET is_ooc_hub = 1 WHERE jid = ?').run(groupJid)
  }

  public setOocStaticLink(link: string): void {
    this.oocStaticLink = link
    const db = this.database()
    db.prepare(`
      INSERT INTO dev_settings (key, value, updated_at) VALUES ('ooc_static_link', ?, unixepoch())
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
    `).run(link)
  }

  public registerGroup(jid: string, name: string, addedBy: string): void {
    const db = this.database()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(`
      INSERT INTO community_groups (jid, name, added_at, added_by, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        updated_at = excluded.updated_at
    `).run(jid, name, now, addedBy, now)
    this.officialGroupsSet.add(jid)
  }

  public removeGroup(jid: string): boolean {
    const db = this.database()
    const result = db.prepare('DELETE FROM community_groups WHERE jid = ?').run(jid)
    this.officialGroupsSet.delete(jid)
    this.silencedGroupsSet.delete(jid)
    return result.changes > 0
  }

  public banGroup(jid: string, reason: string, bannedBy: string): void {
    const db = this.database()
    const now = Math.floor(Date.now() / 1000)
    db.transaction(() => {
      db.prepare('DELETE FROM community_groups WHERE jid = ?').run(jid)
      db.prepare(`
        INSERT INTO community_blacklist (jid, reason, banned_at, banned_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at
      `).run(jid, reason, now, bannedBy)
    })()
    this.officialGroupsSet.delete(jid)
    this.silencedGroupsSet.delete(jid)
  }

  public listOfficialGroups(): OfficialGroupRecord[] {
    const db = this.database()
    const rows = db.prepare(`
      SELECT jid, name, is_ooc_hub, remote_silenced, sniff_once, member_count, added_at, added_by
      FROM community_groups ORDER BY added_at ASC
    `).all() as Array<{
      jid: string
      name: string
      is_ooc_hub: number
      remote_silenced: number
      sniff_once: number
      member_count: number
      added_at: number
      added_by: string
    }>
    return rows.map((r) => ({
      jid: r.jid,
      name: r.name,
      isOocHub: r.is_ooc_hub === 1,
      remoteSilenced: r.remote_silenced === 1,
      sniffOnce: r.sniff_once === 1,
      memberCount: r.member_count,
      addedAt: r.added_at,
      addedBy: r.added_by,
    }))
  }

  public async syncGroupMembers(whatsapp: WhatsAppPort): Promise<number> {
    const nextMembers = new Set<string>()
    for (const groupJid of this.officialGroupsSet) {
      try {
        const metadata = await whatsapp.getGroupMetadata(groupJid)
        if (metadata && metadata.participants) {
          for (const p of metadata.participants) {
            if (p.jid) {
              const bare = p.jid.split(':')[0]
              nextMembers.add(p.jid)
              nextMembers.add(bare)
            }
          }
          this.database().prepare(
            'UPDATE community_groups SET name = ?, member_count = ?, updated_at = unixepoch() WHERE jid = ?',
          ).run(metadata.subject, metadata.participants.length, groupJid)
        }
      } catch (err) {
        this.logger.debug({ groupJid, err }, 'unable to sync group metadata for official group')
      }
    }
    this.officialMembersSet.clear()
    for (const m of nextMembers) {
      this.officialMembersSet.add(m)
    }
    return this.officialMembersSet.size
  }

  public async resolveLiveOocLink(whatsapp?: WhatsAppPort): Promise<string> {
    const wa = whatsapp ?? this.options.whatsapp
    if (this.options.redis) {
      try {
        const cached = await this.options.redis.cacheGet<string>('gate', 'ooc_link')
        if (cached) return cached
      } catch {}
    }

    if (this.oocGroupJid && isGroupJid(this.oocGroupJid)) {
      try {
        const liveLink = await wa?.getGroupInviteLink(this.oocGroupJid)
        if (liveLink && liveLink.startsWith('http')) {
          if (this.options.redis) {
            try {
              await this.options.redis.cacheSet<string>('gate', 'ooc_link', liveLink, 1800)
            } catch {}
          }
          return liveLink
        }
      } catch {}
    }

    return this.oocStaticLink
  }

  public async evaluateMessage(message: CoreMessage, whatsapp?: WhatsAppPort): Promise<MessageGateResult> {
    const wa = whatsapp ?? this.options.whatsapp
    const sender = message.senderJid ?? ''
    const remote = message.remoteJid
    const isGroup = isGroupJid(remote)

    // 0. Owner always allowed
    if (this.isOwner(sender)) {
      return { allowed: true }
    }

    // 1. Shadowban filter
    if (this.isShadowbanned(sender)) {
      return { allowed: false, reason: 'shadowbanned' }
    }

    // 2. Permissive mode
    if (this.gateMode === 'permissive') {
      if (isGroup && this.isGroupSilenced(remote)) {
        return { allowed: false, reason: 'remote_silenced' }
      }
      return { allowed: true }
    }

    // 3. Group messages (@g.us)
    if (isGroup) {
      if (!this.isGroupOfficial(remote)) {
        // Unofficial group -> Silent drop (Deaf Brick)
        return { allowed: false, reason: 'unauthorized_group' }
      }
      if (this.isGroupSilenced(remote)) {
        return { allowed: false, reason: 'remote_silenced' }
      }
      return { allowed: true }
    }

    // 4. DM messages (@s.whatsapp.net / @lid)
    if (this.isOfficialMember(sender)) {
      return { allowed: true }
    }

    // Sender is not in official member set
    const text = message.text?.trim() ?? ''
    const commandName = this.extractCommandName(text)

    // Regular DM chatter from non-member without command -> silent drop
    if (!commandName) {
      return { allowed: false, reason: 'dm_chatter_non_member' }
    }

    // Exemption: !menfess allowed without membership
    if (EXEMPT_DM_COMMANDS.has(commandName)) {
      return { allowed: true }
    }

    // Strict member commands (!suggest / !report) rejected immediately
    if (STRICT_MEMBER_DM_COMMANDS.has(commandName)) {
      await this.sendOocFunnel(wa, remote)
      return { allowed: false, reason: 'member_only_cmd' }
    }

    // 5. Evaluate 12-Hour Guest Trial in SQLite
    const now = Math.floor(Date.now() / 1000)
    const db = this.database()
    const trial = db.prepare(`
      SELECT canonical_id, phone_jid, lid_jid, started_at, expires_at, command_count
      FROM trial_guests
      WHERE canonical_id = ? OR phone_jid = ? OR lid_jid = ?
      LIMIT 1
    `).get(sender, sender, sender) as GuestTrialRecord | undefined

    if (!trial) {
      // First command -> activate 12-hour trial
      const expiresAt = now + this.trialDurationSec
      db.prepare(`
        INSERT INTO trial_guests (canonical_id, phone_jid, started_at, expires_at, command_count, last_command, last_seen_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(sender, sender, now, expiresAt, commandName, now)
      return { allowed: true }
    }

    if (now < trial.expiresAt) {
      // Active trial
      db.prepare(`
        UPDATE trial_guests
        SET command_count = command_count + 1, last_command = ?, last_seen_at = ?
        WHERE canonical_id = ?
      `).run(commandName, now, trial.canonicalId)
      return { allowed: true }
    }

    // Trial expired -> reject with OOC funnel message
    await this.sendOocFunnel(wa, remote)
    return { allowed: false, reason: 'trial_expired' }
  }

  private async sendOocFunnel(whatsapp: WhatsAppPort | undefined, targetJid: string): Promise<void> {
    const wa = whatsapp ?? this.options.whatsapp
    if (!wa) return
    if (this.options.redis) {
      try {
        const acquired = await this.options.redis.rememberOnce('gate', `reject_cd:${targetJid}`, 60)
        if (acquired === false) return // In 60s cooldown, silent drop
      } catch {}
    }

    const oocLink = await this.resolveLiveOocLink(whatsapp)
    const funnelText = [
      'Akses fitur privat Allybot khusus untuk anggota resmi Komunitas Allyssea. ✨',
      'Yuk bergabung di grup OOC resmi kami untuk membuka akses penuh tanpa batas:',
      oocLink,
    ].join('\n\n')

    try {
      await wa.sendText(targetJid, funnelText)
    } catch (err) {
      this.logger.debug({ targetJid, err }, 'failed sending OOC funnel message')
    }
  }

  private extractCommandName(text: string): string | undefined {
    if (!text.startsWith('!')) return undefined
    const parts = text.slice(1).trim().split(/\s+/)
    const cmd = parts[0]?.toLowerCase()
    return cmd && /^[a-z0-9_-]+$/.test(cmd) ? cmd : undefined
  }
}
