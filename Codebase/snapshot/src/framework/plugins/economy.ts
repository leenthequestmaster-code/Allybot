import type { CommandContext, Plugin } from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid, isJid } from '../../platform/validation.js'
import {
  createEconomyOperationKey,
  EconomyOperationError,
  EconomyService,
  EconomyUnavailableError,
  type EconomyAccountSnapshot,
  type EconomyHistoryEntry,
  type EconomyMembershipTier,
} from '../../services/economy-service.js'

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
      'Vela Status',
      'Status: Belum diaktifkan di grup ini',
      'Keterangan: Aktivasi dilakukan oleh pengelola grup melalui policy yang sah.',
    ].join('\n')
  }

  const walletAvailable = snapshot.walletBalance - snapshot.restrictedWalletBalance - snapshot.reservedWalletBalance
  const safeLimit = snapshot.safeLimit >= 2_000_000_000 ? 'Tidak terbatas' : `${formatVela(snapshot.safeLimit)} Vela`
  return [
    'Vela Status',
    'Wallet:',
    `Saldo tersedia: ${formatVela(walletAvailable)} Vela`,
    'Limit: 20.000 Vela',
    `Tertahan karena limit: ${formatVela(snapshot.restrictedWalletBalance)} Vela`,
    `Ditahan untuk transfer: ${formatVela(snapshot.reservedWalletBalance)} Vela`,
    'Safe:',
    `Status: ${safeStatus(snapshot.safeStatus)}`,
    `Saldo: ${formatVela(snapshot.safeBalance)} Vela`,
    `Kapasitas: ${safeLimit}`,
    `Membership: ${safeTier(snapshot.membershipTier)}`,
    `Total tercatat: ${formatVela(snapshot.walletBalance + snapshot.safeBalance)} Vela`,
  ].join('\n')
}

function bankHelp(prefix: string): string {
  return [
    '🏦 *Bank Vela*',
    '',
    `• ${prefix}vela — lihat saldo Wallet dan Safe`,
    `• ${prefix}bank status — lihat status rekening`,
    `• ${prefix}bank open — buka rekening Safe`,
    `• ${prefix}bank setor <jumlah> — pindahkan Wallet ke Safe`,
    `• ${prefix}bank tarik <jumlah> — pindahkan Safe ke Wallet`,
    `• ${prefix}bank kirim @orang <jumlah> — buat transfer Vela`,
    `• ${prefix}bank terima <ID> — terima transfer`,
    `• ${prefix}bank tolak <ID> — tolak transfer`,
    `• ${prefix}bank membership <tier> — naikkan membership`,
    `• ${prefix}bank riwayat [jumlah] — lihat riwayat transaksi`,
    '',
    'Tier membership: bronze, silver, gold, atau star.',
    'Transfer yang belum diterima akan mengunci saldo pengirim sampai diterima, ditolak, atau kedaluwarsa.',
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
    '🛡️ *Pengelolaan Economy Vela*',
    '',
    `• ${prefix}bankpolicy on|off — aktifkan/nonaktifkan Economy grup`,
    `• ${prefix}bankreward @orang <jumlah> — berikan reward`,
    bankRewardUsage(prefix),
    `• ${prefix}banksweep @orang — proses overage yang sudah jatuh tempo`,
  ].join('\n')
}

function unavailableText(): string {
  return 'Sistem Vela sedang tidak tersedia. Saldo tidak diubah. Coba lagi nanti.'
}

function groupOnlyText(command: string): string {
  return `Command ${command} hanya dapat digunakan di dalam grup WhatsApp.`
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
    await context.reply('Identitas pengguna tidak tersedia; operasi tidak dapat diproses.')
    return undefined
  }
  return actor
}

async function runEconomyAction(context: CommandContext, action: () => Promise<string>): Promise<void> {
  try {
    await context.reply(await action())
  } catch (error) {
    if (error instanceof EconomyOperationError || error instanceof EconomyUnavailableError) {
      await context.reply(error instanceof EconomyOperationError ? error.message : unavailableText())
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
  const lines = [`✅ ${action}`, `Status: ${mutationStatus(result)}`]
  if (amount !== undefined) lines.push(`Jumlah: ${formatVela(amount)} Vela`)
  if (transferId) lines.push(`ID transfer: ${transferId}`)
  if (expiresAt) lines.push(`Berlaku sampai: ${expiresAt}`)
  return lines.join('\n')
}

function renderHistory(entries: readonly EconomyHistoryEntry[]): string {
  if (entries.length === 0) return '📒 Belum ada riwayat transaksi Vela.'
  const labels: Record<string, string> = {
    safe_open: 'Buka Safe',
    reward: 'Reward',
    deposit: 'Setor ke Safe',
    withdraw: 'Tarik dari Safe',
    membership_purchase: 'Membership',
    transfer_debit: 'Transfer keluar',
    transfer_credit: 'Transfer masuk',
    transfer_reserve: 'Saldo dikunci untuk transfer',
    transfer_release: 'Kunci transfer dilepas',
    seizure: 'Penyitaan overage',
    reversal: 'Pembalikan transaksi',
    admin_adjustment: 'Penyesuaian admin',
  }
  return [
    '📒 *Riwayat Vela*',
    '',
    ...entries.map((entry) => {
      const wallet = entry.walletDelta === 0 ? '' : ` | Wallet ${entry.walletDelta > 0 ? '+' : ''}${formatVela(entry.walletDelta)}`
      const safe = entry.safeDelta === 0 ? '' : ` | Safe ${entry.safeDelta > 0 ? '+' : ''}${formatVela(entry.safeDelta)}`
      const reserved = entry.reservedWalletDelta === 0 ? '' : ` | Kunci ${entry.reservedWalletDelta > 0 ? '+' : ''}${formatVela(entry.reservedWalletDelta)}`
      return `• ${labels[entry.entryType] ?? 'Transaksi'}${wallet}${safe}${reserved}\n  ${entry.reason}`
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
      if (!snapshot.economyEnabled) return '🏦 Economy Vela belum diaktifkan di grup ini.'
      return [
        '🏦 *Status Rekening Vela*',
        '',
        `Status Safe: ${safeStatus(snapshot.safeStatus)}`,
        `Membership: ${safeTier(snapshot.membershipTier)}`,
        `Saldo Safe: ${formatVela(snapshot.safeBalance)} Vela`,
        `Kapasitas Safe: ${snapshot.safeLimit >= 2_000_000_000 ? 'Tidak terbatas' : `${formatVela(snapshot.safeLimit)} Vela`}`,
        '',
        snapshot.safeStatus === 'not_open'
          ? `Buka rekening melalui ${context.prefix}bank open.`
          : `Lihat ringkasan saldo melalui ${context.prefix}vela.`,
      ].join('\n')
    })
    return
  }
  if (action === 'open') {
    await runEconomyAction(context, async () => renderMutation('Rekening Safe berhasil dibuka.', await service.openSafe(groupJid, actor, actor, operationKey(context, 'bank-open'), 'Pembukaan Safe oleh pengguna')))
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
    await runEconomyAction(context, async () => renderMutation('Transfer dibuat dan saldo dikunci.', await service.createTransfer(groupJid, actor, target, amount, actor, operationKey(context, 'bank-transfer'), note)))
    return
  }
  if (action === 'terima' || action === 'accept') {
    const transferId = context.args[1]
    if (!transferId || !/^[0-9a-f-]{36}$/i.test(transferId)) {
      await context.reply(`Format: ${context.prefix}bank terima <ID-transfer>`)
      return
    }
    await runEconomyAction(context, async () => renderMutation('Transfer diterima.', await service.acceptTransfer(groupJid, transferId, actor, actor, operationKey(context, 'bank-accept'))))
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
    await runEconomyAction(context, async () => renderMutation(`Membership ${tier} berhasil diproses.`, await service.upgradeMembership(groupJid, actor, tier, actor, operationKey(context, 'bank-membership'))))
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

export const economyPlugin: Plugin = {
  name: 'economy',
  version: '0.2.0',
  load(context) {
    const service = context.services.get<EconomyService>('economy')
    if (!service.isEnabled) return

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
        await runEconomyAction(commandContext, async () => renderMutation(`Economy grup ${enabled === 'on' ? 'diaktifkan' : 'dinonaktifkan'}.`, await service.setGroupPolicy(groupJid, enabled === 'on', actor, operationKey(commandContext, 'bank-policy'), 'Perubahan policy oleh pengelola grup')))
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
        await runEconomyAction(commandContext, async () => renderMutation('Reward berhasil diberikan.', await service.grantReward(groupJid, target, amount, actor, operationKey(commandContext, 'bank-reward'), 'Reward dari pengelola grup')))
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
  },
}

export default economyPlugin
