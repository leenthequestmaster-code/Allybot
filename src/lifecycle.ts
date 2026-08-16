import type { AppConfig } from './config.js'
import { errorMessage } from './errors.js'
import type { AppLogger } from './logger.js'
import { SqliteStorage } from './storage.js'
import { WhatsAppConnection } from './whatsapp.js'
import type { ApplicationFramework } from './framework/application.js'

export class AppLifecycle {
  private shuttingDown = false
  private maintenanceKeepalive?: ReturnType<typeof setInterval>

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly storage: SqliteStorage,
    private readonly whatsapp: WhatsAppConnection,
    private readonly framework?: ApplicationFramework,
  ) {}

  async start(): Promise<void> {
    this.installProcessHandlers()
    this.logger.info('Allybot core foundation starting')
    if (this.framework) await this.framework.start()
    else await this.whatsapp.start()
    this.logger.info({ status: this.whatsapp.currentStatus }, 'Allybot application framework started')

    if (!this.config.WHATSAPP_ENABLED) {
      this.maintenanceKeepalive = setInterval(() => undefined, 60_000)
      this.logger.info('Allybot maintenance mode keepalive active')
    }
  }

  async shutdown(reason: string, exitCode = 0): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.logger.info({ reason, exitCode }, 'graceful shutdown started')

    const timeout = setTimeout(() => {
      this.logger.error('graceful shutdown timed out; forcing process exit')
      process.exit(exitCode === 0 ? 1 : exitCode)
    }, this.config.SHUTDOWN_TIMEOUT_MS)
    timeout.unref?.()

    try {
      if (this.maintenanceKeepalive) {
        clearInterval(this.maintenanceKeepalive)
        this.maintenanceKeepalive = undefined
      }
      if (this.framework) await this.framework.stop()
      else await this.whatsapp.close()
      this.storage.close()
      clearTimeout(timeout)
      this.logger.info('graceful shutdown completed')
      process.exit(exitCode)
    } catch (error) {
      clearTimeout(timeout)
      this.logger.error({ err: errorMessage(error) }, 'graceful shutdown failed')
      process.exit(exitCode === 0 ? 1 : exitCode)
    }
  }

  private installProcessHandlers(): void {
    process.once('SIGINT', () => void this.shutdown('SIGINT'))
    process.once('SIGTERM', () => void this.shutdown('SIGTERM'))

    process.on('uncaughtException', (error) => {
      this.logger.fatal({ err: errorMessage(error) }, 'uncaught exception')
      void this.shutdown('uncaughtException', 1)
    })

    process.on('unhandledRejection', (reason) => {
      this.logger.fatal({ err: errorMessage(reason) }, 'unhandled rejection')
      void this.shutdown('unhandledRejection', 1)
    })
  }
}
