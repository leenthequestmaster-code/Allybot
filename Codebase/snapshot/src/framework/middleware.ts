import type {
  CommandMiddleware,
  MiddlewareContext,
  CommandContext,
} from './contracts.js'
import { isGroupJid } from '../platform/validation.js'

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
      return 'Maaf, command ini hanya dapat digunakan oleh admin grup.'
    case 'group.admin.or.bot.owner':
      return 'Maaf, command ini hanya dapat digunakan oleh Owner Allybot atau admin grup.'
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
  return async ({ command, context }, next) => {
    const cooldown = command.cooldownMs ?? context.config.defaultCooldownMs
    if (cooldown <= 0) return next()
    const key = `${command.name}:${context.message.senderJid ?? context.message.remoteJid}`
    const current = now()
    const previous = lastRun.get(key) ?? 0
    if (current - previous < cooldown) {
      context.logger.debug({ command: command.name }, 'command cooldown active')
      return
    }
    lastRun.set(key, current)
    for (const [oldKey, timestamp] of lastRun) {
      if (current - timestamp > Math.max(cooldown, 10 * 60 * 1000)) lastRun.delete(oldKey)
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
