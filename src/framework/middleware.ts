import type {
  CommandMiddleware,
  MiddlewareContext,
  CommandContext,
} from './contracts.js'
import { isGroupJid } from './validation.js'

export type PermissionResolver = (
  permission: string,
  context: CommandContext,
) => Promise<boolean> | boolean

export function composeMiddleware(
  middleware: readonly CommandMiddleware[],
): CommandMiddleware {
  return async (input, terminal) => {
    let cursor = -1
    const dispatch = async (index: number): Promise<void> => {
      if (index <= cursor) throw new Error('Middleware called next more than once')
      cursor = index
      const current = middleware[index]
      if (!current) return terminal()
      await current(input, () => dispatch(index + 1))
    }
    await dispatch(0)
  }
}

export function permissionDenialMessage(permission: string, context?: CommandContext): string {
  switch (permission) {
    case 'group.admin':
    case 'group.admin.or.bot.owner':
      return 'Command ini khusus admin'
    case 'group.owner':
      return 'Maaf, command ini hanya dapat digunakan oleh pembuat grup.'
    case 'bot.owner':
      return 'Maaf, command ini hanya tersedia untuk owner Allybot.'
    case 'developer.mode.observer':
      return context && isGroupJid(context.message.remoteJid)
        ? 'Maaf, Developer Mode hanya dapat digunakan melalui private chat.'
        : 'Maaf, Developer Mode belum aktif untuk akun ini.'
    case 'developer.mode.group.observer':
      return context && !isGroupJid(context.message.remoteJid)
        ? 'Maaf, command ini hanya dapat digunakan di dalam grup.'
        : 'Maaf, Developer Mode belum aktif untuk akun ini.'
    default:
      return 'Maaf, kamu belum memiliki izin untuk menggunakan command ini.'
  }
}

export function createPermissionMiddleware(
  resolve: PermissionResolver,
): CommandMiddleware {
  return async ({ command, context }, next) => {
    if (!command.permission) return next()
    const allowed = await resolve(command.permission, context)
    if (!allowed) {
      const permission = command.permission
      context.logger.warn({ command: command.name, permission }, 'command permission denied')
      await context.reply(permissionDenialMessage(permission, context))
      return
    }
    await next()
  }
}

export function createCooldownMiddleware(
  now: () => number = () => Date.now(),
): CommandMiddleware {
  const lastRun = new Map<string, number>()
  const lastNotice = new Map<string, number>()
  return async ({ command, context }, next) => {
    const cooldown = command.cooldownMs ?? context.config.defaultCooldownMs
    if (cooldown <= 0) return next()
    const key = `${command.name}:${context.message.senderJid ?? context.message.remoteJid}`
    const current = now()
    const previous = lastRun.get(key) ?? 0
    if (current - previous < cooldown) {
      context.logger.debug({ command: command.name }, 'command cooldown active')
      const remainingMs = cooldown - (current - previous)
      const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000))
      const previousNotice = lastNotice.get(key) ?? 0
      if (current - previousNotice >= 2500) {
        lastNotice.set(key, current)
        await context.reply(`⏳ Tunggu sebentar ya, command ini masih cooldown ${remainingSec} detik lagi~ 🙏`)
      }
      return
    }
    lastRun.set(key, current)
    for (const [oldKey, timestamp] of lastRun) {
      if (current - timestamp > Math.max(cooldown, 10 * 60 * 1000)) lastRun.delete(oldKey)
    }
    for (const [oldKey, timestamp] of lastNotice) {
      if (current - timestamp > Math.max(cooldown, 10 * 60 * 1000)) lastNotice.delete(oldKey)
    }
    await next()
  }
}

export const validationMiddleware: CommandMiddleware = async ({ command, context }, next) => {
  const error = command.validate?.(context)
  if (error) {
    context.logger.debug({ command: command.name, validationError: error }, 'command validation failed')
    await context.reply(error)
    return
  }
  await next()
}

export function createUserRateLimitMiddleware(
  maxCommands = 15,
  windowMs = 60_000,
  now: () => number = () => Date.now(),
): CommandMiddleware {
  const userTimestamps = new Map<string, number[]>()
  const lastNotice = new Map<string, number>()

  return async ({ command, context }, next) => {
    const sender = context.message.senderJid
    if (!sender) return next()

    // Bot Owner or admin-permission commands bypass standard member rate limit
    if (command.permission && command.permission.includes('admin') || command.permission?.includes('owner')) {
      return next()
    }

    if (context.config.botOwnerJid) {
      const bareSender = sender.split(':')[0]
      const bareOwner = context.config.botOwnerJid.split(':')[0]
      if (bareSender === bareOwner || `${bareSender}@s.whatsapp.net` === bareOwner) {
        return next()
      }
    }

    const current = now()
    const history = (userTimestamps.get(sender) ?? []).filter((t) => current - t <= windowMs)
    history.push(current)
    userTimestamps.set(sender, history)

    if (userTimestamps.size > 2000) {
      for (const [key, tsList] of userTimestamps) {
        if (tsList.every((t) => current - t > windowMs)) userTimestamps.delete(key)
      }
    }

    if (history.length > maxCommands) {
      context.logger.warn({ sender, command: command.name }, 'user rate limit exceeded')
      const prevNotice = lastNotice.get(sender) ?? 0
      if (current - prevNotice >= 15_000) {
        lastNotice.set(sender, current)
        await context.reply('⚠️ Kamu terlalu cepat mengetik perintah. Mohon istirahat sejenak 1 menit ya~ ⏳')
      }
      return
    }

    await next()
  }
}
