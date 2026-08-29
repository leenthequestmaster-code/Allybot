import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from 'pino'
import { isJid } from './platform/validation.js'

export type DatabaseInstance = Database.Database

/**
 * Initialize a better-sqlite3 database with standard pragmas.
 * Creates the parent directory if needed.
 */
export function initSqliteDatabase(
  databasePath: string,
  options?: { foreignKeys?: boolean },
): Database.Database {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 })
  }
  const db = new Database(databasePath)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  if (options?.foreignKeys) db.pragma('foreign_keys = ON')
  return db
}

/**
 * Guard that a database instance is open and return it.
 */
export function requireDatabase(
  db: Database.Database | undefined,
  serviceName: string,
): Database.Database {
  if (!db?.open) throw new Error(`${serviceName} storage is not initialized`)
  return db
}

/**
 * SHA-256 hash, truncated to `length` hex characters.
 */
export function sha256(value: string, length = 32): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

/**
 * Validate that a value is a WhatsApp JID.
 */
export function validateJid(value: string, field: string): void {
  if (!isJid(value)) throw new Error(`${field} must be a valid JID`)
}

/**
 * Validate that a value is a group JID.
 */
export function validateGroupJid(value: string): void {
  if (!isJid(value) || !value.endsWith('@g.us')) {
    throw new Error('requires a group JID')
  }
}

/**
 * Normalize and bound text: trim, collapse whitespace, truncate to maxLength.
 * Returns undefined if the result is empty.
 */
export function normalizeBoundedText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized
}

/**
 * Validate and normalize text: trim, check non-empty, check length, check for secrets.
 */
export function validateBoundedText(
  value: string,
  maxLength: number,
  field: string,
): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > maxLength) throw new Error(`${field} is too long`)
  return normalized
}

/**
 * Validate a positive integer option with fallback.
 */
export function positiveIntegerOption(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return selected
}

/**
 * Validate a bounded integer option.
 */
export function boundedIntegerOption(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const selected = value ?? fallback
  if (!Number.isInteger(selected) || selected < min || selected > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return selected
}

/**
 * Safely execute a guardrail audit record, logging warnings on failure.
 */
export function auditBestEffort(
  guardrails: { recordAudit: (input: unknown) => void },
  logger: Logger,
  eventType: string,
  actorJid: string,
  resourceJid: string,
  outcome: 'changed' | 'failed' | 'allowed' | 'denied' | 'limited',
  metadata: Record<string, unknown>,
): void {
  try {
    guardrails.recordAudit({
      eventType,
      namespace: 'allybot',
      occurredAt: Date.now(),
      actorJid,
      resourceJid,
      outcome,
      metadata,
    })
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : 'UnknownError', eventType },
      'audit record unavailable',
    )
  }
}
