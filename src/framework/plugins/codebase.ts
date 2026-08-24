import { lstat, readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { CommandContext, Plugin } from '../contracts.js'
import { permissionNames } from '../../permissions.js'

const DEFAULT_EXPORT_PATH = './Codebase/allybot-codebase-latest.zip'
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b])

function safeError(_error: unknown): string {
  return 'Codebase export belum tersedia. Pastikan artifact CI terbaru sudah terpasang.'
}

function exportPath(context: CommandContext): string {
  const configured = context.config.codebaseExportPath?.trim() || DEFAULT_EXPORT_PATH
  if (configured.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(configured) || configured.split(/[\\/]/u).includes('..')) throw new Error('Codebase export path is invalid')
  const absolute = resolve(process.cwd(), configured)
  const root = resolve(process.cwd())
  if (!absolute.startsWith(`${root}${sep}`)) throw new Error('Codebase export path is invalid')
  return absolute
}

function maxBytes(context: CommandContext): number {
  const configured = context.config.codebaseExportMaxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 4 * 1024 * 1024) throw new Error('Codebase export size limit is invalid')
  return configured
}

async function sendCodebaseExport(context: CommandContext): Promise<void> {
  if (!context.config.codebaseExportEnabled) {
    await context.reply('Codebase export sedang dinonaktifkan. Aktifkan feature flag melalui konfigurasi production terlebih dahulu.')
    return
  }
  const sendMedia = context.whatsapp.sendMedia
  if (!sendMedia) {
    await context.reply('Pengiriman file belum tersedia pada adapter WhatsApp ini.')
    return
  }

  const path = exportPath(context)
  const entry = await lstat(path).catch(() => undefined)
  const data = entry?.isFile() && !entry.isSymbolicLink() ? await readFile(path).catch(() => undefined) : undefined
  const limit = maxBytes(context)
  if (!data || data.length === 0 || data.length > limit || !data.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) {
    throw new Error('Codebase export is unavailable')
  }

  await sendMedia.call(context.whatsapp, context.message.remoteJid, {
    kind: 'document',
    data,
    mimeType: 'application/zip',
    fileName: 'allybot-codebase-latest.zip',
    caption: `Allybot Codebase Intelligence Export\nUkuran: ${data.length} bytes\nSumber: artifact CI tersanitasi`,
  })
}

export const codebasePlugin: Plugin = {
  name: 'codebase-export-commands',
  version: '0.1.0',
  load(context) {
    context.commands.register({
      name: 'codebase',
      description: 'Send the latest sanitized Codebase Intelligence Export',
      category: 'developer',
      hidden: true,
      permission: permissionNames.developerModeObserver,
      cooldownMs: 30_000,
      handler: async (commandContext) => {
        try {
          await sendCodebaseExport(commandContext)
        } catch (error) {
          commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'codebase export delivery failed')
          await commandContext.reply(safeError(error))
        }
      },
    })
  },
}

export default codebasePlugin
