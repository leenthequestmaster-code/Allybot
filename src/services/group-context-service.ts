import { createHash, randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { isGroupJid, isJid } from '../framework/validation.js'

export const GROUP_MODES = ['normal', 'ooc', 'guide', 'ic'] as const
export type GroupMode = (typeof GROUP_MODES)[number]

export const IC_SUBTYPES = [
  'bank',
  'market',
  'miningplace',
  'fishingplace',
  'divingplace',
  'gatheringplace',
  'dungeon',
  'other',
  'story_event',
] as const
export type IcSubtype = (typeof IC_SUBTYPES)[number]

export const OOC_POLICIES = ['disabled', 'strict', 'permissive'] as const
export type OocPolicy = (typeof OOC_POLICIES)[number]
export type AllowlistRole = 'narrator' | 'moderator' | 'admin' | 'custom'

export interface GroupContextRecord {
  readonly groupKey: string
  readonly mode: GroupMode
  readonly icSubtype?: IcSubtype
  readonly oocPolicy: OocPolicy
  readonly revision: number
  readonly updatedAt?: string
  readonly enabled: boolean
}

export interface GroupAllowlistEntry {
  readonly memberKey: string
  readonly role: AllowlistRole
  readonly reasonCode: string
  readonly expiresAt?: string
}

export interface GroupContextRpcClient {
  rpc(functionName: string, args: Record<string, string | number | boolean | null>): PromiseLike<{
    data: unknown
    error: { code?: unknown; message?: unknown } | null
  }>
}

export interface GroupContextServiceOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly createClient?: (config: any) => GroupContextRpcClient
  readonly clock?: () => number
}

const DEFAULT_CONTEXT: Omit<GroupContextRecord, 'groupKey'> = {
  mode: 'normal',
  oocPolicy: 'disabled',
  revision: 0,
  enabled: false,
}

function canonicalJid(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+(?=@)/u, '')
}

function hashIdentity(value: string): string {
  return createHash('sha256').update(canonicalJid(value)).digest('hex')
}

function operationKey(prefix: string): string {
  return `${prefix}:${randomUUID().replaceAll('-', '')}`
}

function requestHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function asMode(value: unknown): GroupMode | undefined {
  return typeof value === 'string' && (GROUP_MODES as readonly string[]).includes(value) ? value as GroupMode : undefined
}

function asSubtype(value: unknown): IcSubtype | undefined {
  return typeof value === 'string' && (IC_SUBTYPES as readonly string[]).includes(value) ? value as IcSubtype : undefined
}

function asPolicy(value: unknown): OocPolicy {
  return typeof value === 'string' && (OOC_POLICIES as readonly string[]).includes(value) ? value as OocPolicy : 'disabled'
}

function resultRecord(groupKey: string, value: unknown, enabled: boolean): GroupContextRecord {
  const raw = asRecord(value)
  const mode = asMode(raw?.mode) ?? 'normal'
  const subtype = asSubtype(raw?.ic_subtype)
  const revisionValue = Number(raw?.revision)
  return {
    groupKey,
    mode,
    ...(mode === 'ic' && subtype ? { icSubtype: subtype } : {}),
    oocPolicy: asPolicy(raw?.ooc_policy),
    revision: Number.isSafeInteger(revisionValue) && revisionValue >= 0 ? revisionValue : 0,
    ...(typeof raw?.updated_at === 'string' ? { updatedAt: raw.updated_at } : {}),
    enabled,
  }
}

function assertGroup(value: string): void {
  if (!isGroupJid(value)) throw new Error('groupJid must be a valid group JID')
}

function assertMember(value: string): void {
  if (!isJid(value)) throw new Error('memberJid must be a valid JID')
}

export class GroupContextService implements Service {
  readonly name = 'group-context'

  private readonly env: NodeJS.ProcessEnv
  private readonly createClient: (config: any) => GroupContextRpcClient
  private readonly clock: () => number
  private enabled = false
  private client: GroupContextRpcClient | undefined

  constructor(
    private readonly logger: Logger,
    options: GroupContextServiceOptions = {},
  ) {
    this.env = options.env ?? process.env
    this.createClient = options.createClient ?? (() => ({ rpc: async () => ({ data: null, error: null }) }))
    this.clock = options.clock ?? (() => Date.now())
  }

  initialize(_context: ServiceContext): void {
    this.enabled = this.env.GROUP_CONTEXT_ENABLED?.trim().toLowerCase() === 'true'
    if (!this.enabled) return
    this.client = this.createClient({})
    this.logger.info('Group context service initialized')
  }

  shutdown(_context: ServiceContext): void {
    this.client = undefined
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get isReady(): boolean {
    return this.enabled && this.client !== undefined
  }

  async get(groupJid: string): Promise<GroupContextRecord> {
    assertGroup(groupJid)
    const groupKey = hashIdentity(groupJid)
    if (!this.client) return { groupKey, ...DEFAULT_CONTEXT }
    const result = await this.call('group_context_get', { p_group_key: groupKey })
    return resultRecord(groupKey, result, true)
  }

  async set(
    groupJid: string,
    mode: GroupMode,
    subtype: IcSubtype | undefined,
    oocPolicy: OocPolicy,
    actorJid: string,
  ): Promise<GroupContextRecord> {
    assertGroup(groupJid)
    assertMember(actorJid)
    if (mode === 'ic' && !subtype) throw new Error('IC context requires a subtype')
    if (mode !== 'ic' && subtype) throw new Error('Only IC context may have a subtype')
    const groupKey = hashIdentity(groupJid)
    const actorKey = hashIdentity(actorJid)
    const normalizedPolicy: OocPolicy = mode === 'ic' ? oocPolicy : 'disabled'
    const result = await this.call('group_context_set', {
      p_group_key: groupKey,
      p_mode: mode,
      p_ic_subtype: subtype ?? null,
      p_ooc_policy: normalizedPolicy,
      p_actor_key: actorKey,
      p_operation_key: operationKey('context'),
      p_request_hash: requestHash([groupKey, mode, subtype ?? '', normalizedPolicy, actorKey, String(this.clock())]),
    })
    const raw = asRecord(result)
    if (raw?.ok !== true) throw new Error(renderContextError(raw?.code))
    return resultRecord(groupKey, result, true)
  }

  memberKeyForJid(memberJid: string): string {
    assertMember(memberJid)
    return hashIdentity(memberJid)
  }

  async isOocAllowed(groupJid: string, memberJid: string): Promise<boolean> {
    assertGroup(groupJid)
    assertMember(memberJid)
    if (!this.client) return false
    const result = await this.call('group_ooc_allowlist_check', {
      p_group_key: hashIdentity(groupJid),
      p_member_key: hashIdentity(memberJid),
    })
    return asRecord(result)?.allowed === true
  }

  async listAllowlist(groupJid: string): Promise<readonly GroupAllowlistEntry[]> {
    assertGroup(groupJid)
    if (!this.client) return []
    const result = await this.call('group_ooc_allowlist_list', { p_group_key: hashIdentity(groupJid) })
    const raw = asRecord(result)
    if (!Array.isArray(raw?.entries)) return []
    return raw.entries.flatMap((candidate): GroupAllowlistEntry[] => {
      const entry = asRecord(candidate)
      const memberKey = typeof entry?.member_key === 'string' ? entry.member_key : undefined
      const role = typeof entry?.role === 'string' && ['narrator', 'moderator', 'admin', 'custom'].includes(entry.role)
        ? entry.role as AllowlistRole
        : undefined
      const reasonCode = typeof entry?.reason_code === 'string' ? entry.reason_code : undefined
      if (!memberKey || !role || !reasonCode) return []
      return [{
        memberKey,
        role,
        reasonCode,
        ...(typeof entry?.expires_at === 'string' ? { expiresAt: entry.expires_at } : {}),
      }]
    })
  }

  async addAllowlist(
    groupJid: string,
    memberJid: string,
    actorJid: string,
    role: AllowlistRole = 'narrator',
    reasonCode = 'narrator_access',
    expiresAt?: string,
  ): Promise<void> {
    assertGroup(groupJid)
    assertMember(memberJid)
    assertMember(actorJid)
    const groupKey = hashIdentity(groupJid)
    const memberKey = hashIdentity(memberJid)
    const actorKey = hashIdentity(actorJid)
    const result = await this.call('group_ooc_allowlist_set', {
      p_group_key: groupKey,
      p_member_key: memberKey,
      p_role: role,
      p_reason_code: reasonCode,
      p_expires_at: expiresAt ?? null,
      p_actor_key: actorKey,
      p_operation_key: operationKey('oocallow'),
      p_request_hash: requestHash([groupKey, memberKey, role, reasonCode, expiresAt ?? '', actorKey, String(this.clock())]),
    })
    if (asRecord(result)?.ok !== true) throw new Error(renderContextError(asRecord(result)?.code))
  }

  async clearAllowlist(groupJid: string, actorJid: string): Promise<void> {
    assertGroup(groupJid)
    assertMember(actorJid)
    const groupKey = hashIdentity(groupJid)
    const actorKey = hashIdentity(actorJid)
    const result = await this.call('group_ooc_allowlist_clear', {
      p_group_key: groupKey,
      p_actor_key: actorKey,
      p_operation_key: operationKey('oocclear'),
      p_request_hash: requestHash([groupKey, actorKey, String(this.clock())]),
    })
    if (asRecord(result)?.ok !== true) throw new Error(renderContextError(asRecord(result)?.code))
  }

  async removeAllowlist(groupJid: string, memberJid: string, actorJid: string): Promise<void> {
    assertGroup(groupJid)
    assertMember(memberJid)
    assertMember(actorJid)
    const groupKey = hashIdentity(groupJid)
    const memberKey = hashIdentity(memberJid)
    const actorKey = hashIdentity(actorJid)
    const result = await this.call('group_ooc_allowlist_remove', {
      p_group_key: groupKey,
      p_member_key: memberKey,
      p_actor_key: actorKey,
      p_operation_key: operationKey('oocremove'),
      p_request_hash: requestHash([groupKey, memberKey, actorKey, String(this.clock())]),
    })
    if (asRecord(result)?.ok !== true) throw new Error(renderContextError(asRecord(result)?.code))
  }

  private async call(functionName: string, args: Record<string, string | number | boolean | null>): Promise<unknown> {
    if (!this.client) throw new Error('Group Context belum aktif atau konfigurasi Supabase belum tersedia.')
    const { data, error } = await this.client.rpc(functionName, args)
    if (error) {
      this.logger.warn({ functionName, code: typeof error.code === 'string' ? error.code : undefined }, 'group context RPC failed')
      throw new Error('Konfigurasi grup belum dapat diproses. Coba lagi nanti.')
    }
    return data
  }
}

function renderContextError(code: unknown): string {
  switch (code) {
    case 'invalid_mode': return 'Mode grup tidak dikenali.'
    case 'invalid_ic_subtype': return 'Konteks IC tidak dikenali.'
    case 'subtype_requires_ic': return 'Subtype hanya dapat digunakan pada mode IC.'
    case 'invalid_ooc_policy': return 'Policy OOC tidak dikenali.'
    default: return 'Konfigurasi grup ditolak oleh validasi server.'
  }
}
