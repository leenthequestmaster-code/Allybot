import type { CommandContext, Plugin, PluginContext } from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid, isJid } from '../validation.js'
import {
  createEconomyOperationKey,
  EconomyOperationError,
  EconomyService,
  EconomyUnavailableError,
  type EconomyAccountSnapshot,
  type EconomyHistoryEntry,
  type EconomyMembershipTier,
  type TaxStatus,
  type TaxFrozenScope,
} from '../../services/economy-service.js'

// Backend stub refusal (PENDING: no RPC backend exists). The command names stay
// reachable so users who already know them get one clear Indonesian refusal
// instead of silence, but every surface is hidden so no menu advertises the
// feature as active while the backend is empty. No service method is ever called.
const ECONOMY_BACKEND_PENDING_TEXT = 'Fitur ekonomi belum tersedia — backend sedang disiapkan.'

const ECONOMY_COMMAND_NAMES: readonly { readonly name: string; readonly aliases?: readonly string[] }[] = [
  { name: 'vela', aliases: ['wallet'] },
  { name: 'bank' },
  { name: 'bankpolicy', aliases: ['economypolicy'] },
  { name: 'bankreward' },
  { name: 'banksweep' },
  { name: 'tax' },
  { name: 'taxbayar', aliases: ['bayarpajak'] },
]

function registerEconomyRefusalSurface(context: PluginContext): void {
  for (const { name, aliases } of ECONOMY_COMMAND_NAMES) {
    context.commands.register({
      name,
      ...(aliases ? { aliases } : {}),
      description: 'Fitur belum tersedia',
      hidden: true,
      cooldownMs: 5_000,
      handler: async (commandContext) => {
        await commandContext.reply(ECONOMY_BACKEND_PENDING_TEXT)
      },
    })
  }
}

function economyService(context: CommandContext): EconomyService {
  return context.services.get<EconomyService>('economy')
}

function actorJid(context: CommandContext): string | undefined {
  return context.message.senderJid ?? context.whatsapp.userJid
}

function formatVela(value: number): string {
  return new Intl.NumberFormat('id-ID').format(value)
}

function safeTier(value: EconomyAccountSnapshot['membershipTier']): string {
  return value === 'star' ? 'Star Vault' : value.charAt(0).toUpperCase() + value.slice(1)
}

function safeStatus(value: EconomyAccountSnapshot['safeStatus']): string {
  switch (value) {
    case 'active': return 'Aktif'
    case 'pending': return 'Menunggu pembukaan'
    case 'frozen': return 'Dibekukan'
    default: return 'Belum dibuka'
  }
}

function renderSnapshot(snapshot: EconomyAccountSnapshot): string {
  if (!snapshot.economyEnabled) {
    return [
      '🪙 *Status Vela*',
      'Ekonomi Vela belum diaktifkan di grup ini.',
      'Admin grup bisa mengaktifkannya dengan `!bankpolicy on`.',
    ].join('\n')
  }

  const walletAvailable = snapshot.walletBalance - snapshot.restrictedWalletBalance - snapshot.reservedWalletBalance
  const safeLimit = snapshot.safeLimit >= 2_000_000_000 ? 'Tanpa batas' : `${formatVela(snapshot.safeLimit)} Vela`
  const total = snapshot.walletBalance + snapshot.safeBalance

  const lines = [
    '🪙 *Status Akun Vela*',
    `Wallet: ${formatVela(walletAvailable)} Vela · Safe: ${formatVela(snapshot.safeBalance)} Vela`,
    '',
    '💰 *Wallet*',
    `• Saldo tersedia: ${formatVela(walletAvailable)} Vela`,
    '• Batas wallet: 20.000 Vela',
  ]

  if (snapshot.restrictedWalletBalance > 0) {
    lines.push(`• Tertahan limit: ${formatVela(snapshot.restrictedWalletBalance)} Vela`)
  }
  if (snapshot.reservedWalletBalance > 0) {
    lines.push(`• Dikunci transfer: ${formatVela(snapshot.reservedWalletBalance)} Vela`)
  }

  lines.push(
    '',
    '🏦 *Safe*',
    `• Status: ${safeStatus(snapshot.safeStatus)}`,
    `• Saldo safe: ${formatVela(snapshot.safeBalance)} Vela`,
    `• Kapasitas: ${safeLimit}`,
    `• Membership: ${safeTier(snapshot.membershipTier)}`,
    '',
    `📊 *Total Saldo:* ${formatVela(total)} Vela`,
  )

  return lines.join('\n')
}

function bankHelp(prefix: string): string {
  return [
    '🏦 *Bank Vela*',
    'Kelola saldo Wallet dan Safe Vela kamu.',
    '',
    `• \`${prefix}vela\` — Cek saldo Wallet & Safe`,
    `• \`${prefix}bank status\` — Status rekening & kapasitas Safe`,
    `• \`${prefix}bank open\` — Buka rekening Safe`,
    `• \`${prefix}bank setor <jumlah>\` — Simpan Vela ke Safe`,
    `• \`${prefix}bank tarik <jumlah>\` — Tarik Vela dari Safe ke Wallet`,
    `• \`${prefix}bank kirim @orang <jumlah>\` — Kirim Vela ke anggota lain`,
    `• \`${prefix}bank terima <ID>\` — Terima transfer masuk`,
    `• \`${prefix}bank tolak <ID>\` — Tolak transfer masuk`,
    `• \`${prefix}bank membership <tier>\` — Upgrade tier (bronze, silver, gold, star)`,
    `• \`${prefix}bank riwayat [jumlah]\` — Lihat riwayat transaksi`,
    '',
    '_Catatan: Saldo transfer dikunci sementara sampai penerima menerima atau menolak._',
  ].join('\n')
}

function bankRewardUsage(prefix: string): string {
  return [
    `Format: ${prefix}bankreward @orang <jumlah>`,
    `Contoh: ${prefix}bankreward @orang 1000`,
  ].join('\n')
}

function adminHelp(prefix: string): string {
  return [
    '🛡️ *Pengelolaan Ekonomi Vela*',
    '',
    `• ${prefix}bankpolicy on|off — Aktifkan atau nonaktifkan ekonomi grup`,
    `• ${prefix}bankreward @orang <jumlah> — Berikan reward Vela`,
    bankRewardUsage(prefix),
    `• ${prefix}banksweep @orang — Sita saldo wallet yang melebihi batas (jatuh tempo)`,
  ].join('\n')
}

function unavailableText(): string {
  return 'Sistem Vela sedang mengalami kendala. Saldo kamu tetap aman. Coba lagi nanti ya.'
}

function groupOnlyText(command: string): string {
  return `Perintah ${command} hanya bisa digunakan di dalam grup WhatsApp.`
}

function parseAmount(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{1,10}$/.test(raw)) return undefined
  const amount = Number(raw)
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined
}

function amountFromArgs(args: readonly string[]): { amount?: number; raw?: string } {
  for (const raw of args) {
    const amount = parseAmount(raw)
    if (amount !== undefined) return { amount, raw }
  }
  return {}
}

function targetFromMessage(context: CommandContext): string | undefined {
  const mentioned = context.message.mentionedJids?.filter(isJid) ?? []
  if (mentioned.length > 0) return mentioned[0]
  return context.message.quotedSenderJid && isJid(context.message.quotedSenderJid)
    ? context.message.quotedSenderJid
    : undefined
}

async function requireGroup(context: CommandContext, command = 'Bank'): Promise<string | undefined> {
  if (!isGroupJid(context.message.remoteJid)) {
    await context.reply(groupOnlyText(command))
    return undefined
  }
  return context.message.remoteJid
}

async function requireActor(context: CommandContext): Promise<string | undefined> {
  const actor = actorJid(context)
  if (!actor || !isJid(actor)) {
    await context.reply('Identitas pengirim tidak terbaca. Perintah tidak bisa diproses.')
    return undefined
  }
  return actor
}

function formatOperationError(message: string): string {
  if (message.includes('saldo atau kapasitas tidak mencukupi')) {
    return '❌ Saldo atau kapasitas Safe tidak mencukupi untuk transaksi ini.'
  }
  if (message.includes('status rekening belum memenuhi syarat')) {
    return '❌ Rekening belum aktif atau sedang dibekukan. Cek status lewat `!bank status`.'
  }
  if (message.includes('belum diaktifkan di grup')) {
    return '❌ Ekonomi Vela belum aktif di grup ini. Hubungi admin grup.'
  }
  if (message.includes('Transfer ke diri sendiri')) {
    return '❌ Tidak bisa mentransfer Vela ke diri sendiri.'
  }
  if (message.includes('Transfer tidak ditemukan')) {
    return '❌ Transfer tidak ditemukan, sudah kedaluwarsa, atau bukan untuk kamu.'
  }
  if (message.includes('angka bulat antara')) {
    return '❌ Jumlah Vela harus berupa angka bulat antara 1 dan 1.000.000.000.'
  }
  if (message.includes('Jumlah riwayat')) {
    return '❌ Jumlah riwayat harus antara 1 sampai 50.'
  }
  if (message.includes('Pilihan membership')) {
    return '❌ Pilihan tier membership tidak valid. Pilih: bronze, silver, gold, atau star.'
  }
  if (message.includes('Tidak ada pajak')) {
    return '✅ Tidak ada tagihan pajak yang perlu dibayar saat ini.'
  }
  if (message.includes('Operasi ditolak')) {
    return '❌ Transaksi tidak dapat diproses. Cek kembali saldo dan status rekening kamu.'
  }
  return `❌ ${message}`
}

async function runEconomyAction(context: CommandContext, action: () => Promise<string>): Promise<void> {
  try {
    await context.reply(await action())
  } catch (error) {
    if (error instanceof EconomyOperationError) {
      await context.reply(formatOperationError(error.message))
      return
    }
    if (error instanceof EconomyUnavailableError) {
      await context.reply(unavailableText())
      return
    }
    context.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'economy command failed')
    await context.reply(unavailableText())
  }
}

function mutationStatus(result: Record<string, unknown>): string {
  return typeof result.status === 'string' ? result.status : 'applied'
}

function resultAmount(result: Record<string, unknown>): number | undefined {
  const value = result.amount
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return undefined
}

function renderMutation(action: string, result: Record<string, unknown>): string {
  const amount = resultAmount(result)
  const transferId = typeof result.transfer_id === 'string' ? result.transfer_id : undefined
  const expiresAt = typeof result.expires_at === 'string' ? result.expires_at : undefined
  const rawStatus = mutationStatus(result)
  const statusLabel = rawStatus === 'applied' ? undefined : rawStatus === 'pending' ? 'Menunggu konfirmasi' : rawStatus
  const lines = [`✅ *${action}*`]
  if (amount !== undefined) lines.push(`• Jumlah: *${formatVela(amount)} Vela*`)
  if (statusLabel) lines.push(`• Status: ${statusLabel}`)
  if (transferId) lines.push(`• ID Transfer: \`${transferId}\``)
  if (expiresAt) lines.push(`• Berlaku sampai: ${expiresAt}`)
  return lines.join('\n')
}

function renderHistory(entries: readonly EconomyHistoryEntry[]): string {
  if (entries.length === 0) return '📒 Belum ada riwayat transaksi Vela.'
  const labels: Record<string, string> = {
    safe_open: 'Buka Rekening Safe',
    reward: 'Hadiah / Reward',
    deposit: 'Setor ke Safe',
    withdraw: 'Tarik dari Safe',
    membership_purchase: 'Upgrade Membership',
    transfer_debit: 'Transfer Keluar',
    transfer_credit: 'Transfer Masuk',
    transfer_reserve: 'Kunci Saldo Transfer',
    transfer_release: 'Lepas Kunci Transfer',
    seizure: 'Penyitaan Batas Saldo',
    reversal: 'Pembatalan Transaksi',
    admin_adjustment: 'Penyesuaian Admin',
  }
  return [
    '📒 *Riwayat Transaksi Vela*',
    '',
    ...entries.map((entry) => {
      const deltas: string[] = []
      if (entry.walletDelta !== 0) {
        deltas.push(`Wallet ${entry.walletDelta > 0 ? '+' : ''}${formatVela(entry.walletDelta)}`)
      }
      if (entry.safeDelta !== 0) {
        deltas.push(`Safe ${entry.safeDelta > 0 ? '+' : ''}${formatVela(entry.safeDelta)}`)
      }
      if (entry.reservedWalletDelta !== 0) {
        deltas.push(`Kunci ${entry.reservedWalletDelta > 0 ? '+' : ''}${formatVela(entry.reservedWalletDelta)}`)
      }
      const deltaStr = deltas.length > 0 ? ` (${deltas.join(', ')})` : ''
      const label = labels[entry.entryType] ?? 'Transaksi'
      return `• *${label}*${deltaStr}\n  _${entry.reason}_`
    }),
  ].join('\n')
}

function membershipTier(value: string | undefined): EconomyMembershipTier | undefined {
  return value && ['bronze', 'silver', 'gold', 'star'].includes(value) ? value as EconomyMembershipTier : undefined
}

function operationKey(context: CommandContext, prefix: string): string {
  return createEconomyOperationKey(prefix, context.message.id)
}

async function handleBank(context: CommandContext): Promise<void> {
  const groupJid = await requireGroup(context)
  if (!groupJid) return
  const actor = await requireActor(context)
  if (!actor) return
  const service = economyService(context)
  const action = context.args[0]?.toLowerCase() ?? 'help'

  if (action === 'help') {
    await context.reply(bankHelp(context.prefix))
    return
  }
  if (action === 'status') {
    await runEconomyAction(context, async () => {
      const { snapshot } = await service.getAccountSnapshot(groupJid, actor)
      if (!snapshot.economyEnabled) return '🏦 Ekonomi Vela belum aktif di grup ini.'
      const limitStr = snapshot.safeLimit >= 2_000_000_000 ? 'Tanpa batas' : `${formatVela(snapshot.safeLimit)} Vela`
      return [
        '🏦 *Status Rekening Safe*',
        '',
        `• Status: *${safeStatus(snapshot.safeStatus)}*`,
        `• Membership: *${safeTier(snapshot.membershipTier)}*`,
        `• Saldo Safe: *${formatVela(snapshot.safeBalance)} Vela*`,
        `• Kapasitas Safe: *${limitStr}*`,
        '',
        snapshot.safeStatus === 'not_open'
          ? `Gunakan \`${context.prefix}bank open\` untuk membuka rekening Safe.`
          : `Ketik \`${context.prefix}vela\` untuk melihat ringkasan saldo kamu.`,
      ].join('\n')
    })
    return
  }
  if (action === 'open') {
    await runEconomyAction(context, async () => renderMutation('Rekening Safe berhasil dibuka.', await service.openSafe(groupJid, actor, actor, operationKey(context, 'bank-open'), 'Pembukaan Safe')))
    return
  }
  if (action === 'setor' || action === 'deposit') {
    const { amount } = amountFromArgs(context.args.slice(1))
    if (amount === undefined) {
      await context.reply(`Format: ${context.prefix}bank setor <jumlah>\nContoh: ${context.prefix}bank setor 1000`)
      return
    }
    await runEconomyAction(context, async () => renderMutation('Setoran berhasil.', await service.deposit(groupJid, actor, amount, actor, operationKey(context, 'bank-deposit'))))
    return
  }
  if (action === 'tarik' || action === 'withdraw') {
    const { amount } = amountFromArgs(context.args.slice(1))
    if (amount === undefined) {
      await context.reply(`Format: ${context.prefix}bank tarik <jumlah>\nContoh: ${context.prefix}bank tarik 1000`)
      return
    }
    await runEconomyAction(context, async () => renderMutation('Penarikan berhasil.', await service.withdraw(groupJid, actor, amount, actor, operationKey(context, 'bank-withdraw'))))
    return
  }
  if (action === 'kirim' || action === 'transfer') {
    const target = targetFromMessage(context)
    const { amount, raw } = amountFromArgs(context.args.slice(1))
    if (!target || !amount || !raw) {
      await context.reply(`Format: ${context.prefix}bank kirim @orang <jumlah>\nContoh: ${context.prefix}bank kirim @orang 100`)
      return
    }
    const note = context.args.slice(1).filter((arg) => arg !== raw && !arg.startsWith('@')).join(' ').slice(0, 500)
    await runEconomyAction(context, async () => renderMutation('Transfer berhasil dibuat dan saldo dikunci.', await service.createTransfer(groupJid, actor, target, amount, actor, operationKey(context, 'bank-transfer'), note)))
    return
  }
  if (action === 'terima' || action === 'accept') {
    const transferId = context.args[1]
    if (!transferId || !/^[0-9a-f-]{36}$/i.test(transferId)) {
      await context.reply(`Format: ${context.prefix}bank terima <ID-transfer>`)
      return
    }
    await runEconomyAction(context, async () => renderMutation('Transfer berhasil diterima.', await service.acceptTransfer(groupJid, transferId, actor, actor, operationKey(context, 'bank-accept'))))
    return
  }
  if (action === 'tolak' || action === 'reject') {
    const transferId = context.args[1]
    if (!transferId || !/^[0-9a-f-]{36}$/i.test(transferId)) {
      await context.reply(`Format: ${context.prefix}bank tolak <ID-transfer>`)
      return
    }
    await runEconomyAction(context, async () => renderMutation('Transfer ditolak dan saldo dikembalikan.', await service.rejectTransfer(groupJid, transferId, actor, actor, operationKey(context, 'bank-reject'))))
    return
  }
  if (action === 'membership') {
    const tier = membershipTier(context.args[1]?.toLowerCase())
    if (!tier) {
      await context.reply(`Format: ${context.prefix}bank membership <bronze|silver|gold|star>`)
      return
    }
    await runEconomyAction(context, async () => renderMutation(`Membership berhasil ditingkatkan ke ${tier}.`, await service.upgradeMembership(groupJid, actor, tier, actor, operationKey(context, 'bank-membership'))))
    return
  }
  if (action === 'riwayat' || action === 'history') {
    const requested = context.args[1] ? Number(context.args[1]) : 20
    const limit = Number.isSafeInteger(requested) ? requested : 20
    await runEconomyAction(context, async () => renderHistory(await service.getHistory(groupJid, actor, limit)))
    return
  }
  await context.reply(bankHelp(context.prefix))
}

function formatDueDate(dueAt: string): string {
  try {
    const d = new Date(dueAt)
    if (Number.isNaN(d.getTime())) return dueAt
    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Jakarta',
    }).format(d) + ' WIB'
  } catch {
    return dueAt
  }
}

function taxStatusLabel(status: TaxStatus): string {
  switch (status) {
    case 'current': return 'Lunas'
    case 'warning': return 'Peringatan (Minggu 1)'
    case 'penalty_1': return 'Denda +2% (Minggu 2)'
    case 'penalty_2': return 'Denda +4% & Safe Dibekukan (Minggu 3)'
    case 'penalty_3_plus': return 'Denda +6% & Rekening Dibekukan Total (Minggu 4+)'
    default: return status
  }
}

function frozenScopeLabel(scope: TaxFrozenScope): string {
  switch (scope) {
    case 'safe': return 'Safe dibekukan'
    case 'total': return 'Wallet & Safe dibekukan total'
    default: return 'Tidak ada'
  }
}

export const economyPlugin: Plugin = {
  name: 'economy',
  version: '0.2.0',
  load(context) {
    const service = context.services.get<EconomyService>('economy')
    // Explicit disable ladder:
    // 1. flag false  → plugin registers nothing at all (no commands, no reaction)
    // 2. flag true + stub backend → hidden refusal surface; commands always answer
    //    with ECONOMY_BACKEND_PENDING_TEXT and never call the service
    // 3. flag true + real backend → the full live command surface
    if (!service.isEnabled) return
    if (!service.hasBackend) {
      registerEconomyRefusalSurface(context)
      context.logger.info('Economy plugin loaded in backend-pending refusal mode')
      return
    }

    context.commands.register({
      name: 'vela',
      aliases: ['wallet'],
      description: 'Lihat saldo Wallet dan Safe Vela',
      category: 'your-character',
      menuOrder: 35,
      cooldownMs: 3_000,
      handler: async (commandContext) => {
        const groupJid = await requireGroup(commandContext, 'Vela')
        if (!groupJid) return
        const actor = await requireActor(commandContext)
        if (!actor) return
        await runEconomyAction(commandContext, async () => {
          const result = await economyService(commandContext).getAccountSnapshot(groupJid, actor)
          return renderSnapshot(result.snapshot)
        })
      },
    })

    context.commands.register({
      name: 'bank',
      description: 'Kelola rekening Wallet dan Safe Vela',
      category: 'your-character',
      menuOrder: 36,
      cooldownMs: 3_000,
      handler: handleBank,
    })

    context.commands.register({
      name: 'bankpolicy',
      aliases: ['economypolicy'],
      description: 'Aktifkan atau nonaktifkan Economy untuk grup',
      category: 'owner',
      hidden: true,
      permission: permissionNames.groupAdminOrBotOwner,
      cooldownMs: 5_000,
      handler: async (commandContext) => {
        const groupJid = await requireGroup(commandContext, 'Bank Policy')
        if (!groupJid) return
        const actor = await requireActor(commandContext)
        if (!actor) return
        const enabled = commandContext.args[0]?.toLowerCase()
        if (enabled !== 'on' && enabled !== 'off') {
          await commandContext.reply(`Format: ${commandContext.prefix}bankpolicy on|off\n\n${adminHelp(commandContext.prefix)}`)
          return
        }
        await runEconomyAction(commandContext, async () => renderMutation(`Ekonomi grup ${enabled === 'on' ? 'berhasil diaktifkan' : 'dinonaktifkan'}.`, await service.setGroupPolicy(groupJid, enabled === 'on', actor, operationKey(commandContext, 'bank-policy'), 'Perubahan kebijakan oleh admin')))
      },
    })

    context.commands.register({
      name: 'bankreward',
      description: 'Berikan reward Vela kepada anggota',
      category: 'owner',
      hidden: true,
      permission: permissionNames.groupAdminOrBotOwner,
      cooldownMs: 5_000,
      handler: async (commandContext) => {
        const groupJid = await requireGroup(commandContext, 'Bank Reward')
        if (!groupJid) return
        const actor = await requireActor(commandContext)
        if (!actor) return
        const target = targetFromMessage(commandContext)
        const { amount } = amountFromArgs(commandContext.args)
        if (!target) {
          await commandContext.reply(`${bankRewardUsage(commandContext.prefix)}\nTag anggota dari daftar mention WhatsApp atau balas pesannya.`)
          return
        }
        if (!amount) {
          await commandContext.reply(bankRewardUsage(commandContext.prefix))
          return
        }
        await runEconomyAction(commandContext, async () => renderMutation('Reward berhasil diberikan.', await service.grantReward(groupJid, target, amount, actor, operationKey(commandContext, 'bank-reward'), 'Reward dari admin')))
      },
    })

    context.commands.register({
      name: 'banksweep',
      description: 'Proses overage Wallet yang telah jatuh tempo',
      category: 'owner',
      hidden: true,
      permission: permissionNames.groupAdminOrBotOwner,
      cooldownMs: 5_000,
      handler: async (commandContext) => {
        const groupJid = await requireGroup(commandContext, 'Bank Sweep')
        if (!groupJid) return
        const actor = await requireActor(commandContext)
        if (!actor) return
        const target = targetFromMessage(commandContext)
        if (!target) {
          await commandContext.reply(`Format: ${commandContext.prefix}banksweep @orang`)
          return
        }
        await runEconomyAction(commandContext, async () => renderMutation('Pemeriksaan overage selesai.', await service.sweepOverage(groupJid, target, actor, operationKey(commandContext, 'bank-sweep'))))
      },
    })

    context.commands.register({
      name: 'tax',
      description: 'Lihat status pajak Vela',
      category: 'your-character',
      menuOrder: 40,
      cooldownMs: 3_000,
      handler: async (commandContext) => {
        const groupJid = await requireGroup(commandContext, 'Tax')
        if (!groupJid) return
        const actor = await requireActor(commandContext)
        if (!actor) return
        await runEconomyAction(commandContext, async () => {
          const summary = await economyService(commandContext).getTaxSummary(groupJid, actor)
          if (!summary) return '🏦 Sistem pajak belum tersedia untuk akun ini.'
          const lines = [
            '💰 *Pajak Vela Kerajaan Velseus*',
            '',
            `• Total Kekayaan: *${formatVela(summary.totalWealth)} Vela*`,
            `• Tarif Pajak Dasar: *${(summary.baseTaxRate * 100).toFixed(0)}%* (${formatVela(summary.currentTax)} Vela)`,
          ]
          if (summary.penaltyRate > 0) {
            lines.push(`• Denda Keterlambatan: *${(summary.penaltyRate * 100).toFixed(0)}%*`)
          }
          lines.push(
            `• Total Tagihan: *${formatVela(summary.totalDue)} Vela*`,
            `• Status: *${taxStatusLabel(summary.status)}*`,
          )
          if (summary.frozenScope !== 'none') {
            lines.push(`• Pembekuan: *${frozenScopeLabel(summary.frozenScope)}*`)
          }
          lines.push(
            `• Periode: *Minggu ke-${summary.weekNumber}*`,
            `• Batas Waktu: *${formatDueDate(summary.dueAt)}*`,
          )
          if (summary.isOverdue) {
            lines.push('', '🚨 *TERLAMBAT* — Segera bayar untuk menghindari penalti & pembekuan rekening!')
          }
          if (summary.totalDue > 0) {
            lines.push('', `Ketik \`${commandContext.prefix}taxbayar\` untuk melunasi pajak.`)
          } else {
            lines.push('', '✅ Tagihan pajak kamu saat ini sudah lunas.')
          }
          return lines.join('\n')
        })
      },
    })

    context.commands.register({
      name: 'taxbayar',
      aliases: ['bayarpajak'],
      description: 'Bayar pajak Vela yang tertunggak',
      category: 'your-character',
      menuOrder: 41,
      cooldownMs: 5_000,
      handler: async (commandContext) => {
        const groupJid = await requireGroup(commandContext, 'Tax Bayar')
        if (!groupJid) return
        const actor = await requireActor(commandContext)
        if (!actor) return
        await runEconomyAction(commandContext, async () => {
          const summary = await economyService(commandContext).getTaxSummary(groupJid, actor)
          if (!summary) return '🏦 Sistem pajak belum tersedia untuk akun ini.'
          if (summary.totalDue <= 0) return '✅ Tidak ada tagihan pajak yang perlu dibayar saat ini.'
          return renderMutation('Pajak berhasil dibayar.', await economyService(commandContext).payTax(groupJid, actor, actor, operationKey(commandContext, 'tax-pay'), `Pembayaran pajak minggu ke-${summary.weekNumber}`))
        })
      },
    })
  },
}

export default economyPlugin
