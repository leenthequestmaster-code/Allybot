import type { Plugin } from '../contracts.js'

export const diagnosticsPlugin: Plugin = {
  name: 'diagnostics',
  version: '0.1.0',
  load(context) {
    context.commands.register({
      name: 'diag',
      aliases: ['health'],
      description: 'Show a minimal non-sensitive framework health snapshot',
      category: 'system',
      menuOrder: 2,
      cooldownMs: 3000,
      handler: async (commandContext) => {
        const services = context.services.list().join(',') || 'no-services'
        await commandContext.reply(
          `Allybot framework ready | connected=${commandContext.whatsapp.isConnected} | services=${services}`,
        )
      },
    })
  },
}
