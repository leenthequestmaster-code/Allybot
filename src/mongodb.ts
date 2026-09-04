import { MongoClient, type Db, type Document } from 'mongodb'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from './framework/contracts.js'

export type MongoHealthStatus = 'disabled' | 'healthy' | 'unhealthy'

export interface MongoConfig {
  readonly uri: string
  readonly dbName: string
  readonly timeoutMs: number
}

export interface MongoHealth {
  readonly status: MongoHealthStatus
  readonly checkedAt: string
}

export function readMongoConfig(env: NodeJS.ProcessEnv = process.env): MongoConfig | undefined {
  const enabled = env.MONGODB_ENABLED === 'true'
  const uri = env.MONGODB_URI?.trim()
  if (!enabled && !uri) return undefined
  if (enabled && !uri) throw new Error('MONGODB_URI is required when MONGODB_ENABLED=true')
  if (!uri) return undefined

  return {
    uri,
    dbName: env.MONGODB_DB_NAME?.trim() || 'allybot',
    timeoutMs: Number(env.MONGODB_TIMEOUT_MS) || 5_000,
  }
}

export interface MongoServiceOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly clientFactory?: (uri: string) => MongoClient
}

export class MongoService implements Service {
  readonly name = 'mongodb'
  readonly id = 'mongodb'
  private readonly config?: MongoConfig
  private readonly clientFactory?: (uri: string) => MongoClient
  private client?: MongoClient
  private dbInstance?: Db
  private logger?: Logger
  private lastHealth: MongoHealth = {
    status: 'disabled',
    checkedAt: new Date(0).toISOString(),
  }

  constructor(options: MongoServiceOptions = {}) {
    const env = options.env ?? process.env
    this.config = readMongoConfig(env)
    this.clientFactory = options.clientFactory
  }

  async start(context: ServiceContext): Promise<void> {
    this.logger = context.logger
    if (!this.config) {
      this.lastHealth = { status: 'disabled', checkedAt: new Date().toISOString() }
      return
    }

    try {
      this.client = this.clientFactory
        ? this.clientFactory(this.config.uri)
        : new MongoClient(this.config.uri, {
            serverSelectionTimeoutMS: this.config.timeoutMs,
            connectTimeoutMS: this.config.timeoutMs,
          })

      await this.client.connect()
      this.dbInstance = this.client.db(this.config.dbName)
      await this.dbInstance.command({ ping: 1 })
      this.lastHealth = { status: 'healthy', checkedAt: new Date().toISOString() }
    } catch {
      this.lastHealth = { status: 'unhealthy', checkedAt: new Date().toISOString() }
    }
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {})
      this.client = undefined
      this.dbInstance = undefined
    }
  }

  getHealth(): MongoHealth {
    return this.lastHealth
  }

  isEnabled(): boolean {
    return Boolean(this.config)
  }

  getDb(): Db | undefined {
    return this.dbInstance
  }

  collection<T extends Document = any>(name: string) {
    if (!this.dbInstance) {
      throw new Error('MongoDB service is not connected')
    }
    return this.dbInstance.collection<T>(name)
  }
}
