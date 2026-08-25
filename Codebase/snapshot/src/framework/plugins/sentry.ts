import type { Plugin } from '../contracts.js'
import type { SentryReporter } from '../../sentry.js'

export function createSentryPlugin(reporter: SentryReporter): Plugin {
  return {
    name: 'sentry',

    initialize(context): void {
      if (!reporter.isEnabled) return

      context.events.on('framework.error', ({ source, error }) => {
        reporter.captureError(source, error)
      })
      context.events.on('plugin.failed', ({ name, error }) => {
        reporter.captureError(`plugin:${name}`, error)
      })
      context.events.on('connection.changed', ({ status }) => {
        if (status === 'failed' || status === 'needs_auth') {
          reporter.captureMessage(`connection:${status}`, 'failed')
        }
      })
    },
  }
}
