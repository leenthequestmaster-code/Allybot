import OpenAI from 'openai'
import { buildPersonaSystemPrompt, DEFAULT_ALLY_PERSONA } from './services/ai-persona-engine.js'

/**
 * Generic OpenAI-compatible AI provider.
 *
 * Everything is env-driven so the bot can talk to any provider that speaks
 * the Chat Completions API (OpenAI, xAI, Gemini via OpenAI-compat endpoint,
 * OpenRouter, a self-hosted gateway, ...):
 *   AI_ENABLED=true
 *   AI_BASE_URL=https://api.example.com/v1
 *   AI_API_KEY=sk-...
 *   AI_MODEL=primary-model-id
 *   AI_FALLBACK_MODEL=optional-model-id   (needs AI_FALLBACK_ENABLED=true)
 */
export const AI_BASE_URL = 'https://api.openai.com/v1'
export const PRIMARY_MODEL = 'gemini-3.5-flash-lite'
export const FALLBACK_MODEL = 'gemini-3.8-flash'
export const MAX_AI_INPUT_LENGTH = 1_200
export const MAX_AI_OUTPUT_LENGTH = 2_000
export const MAX_AI_CONTEXT_TOKENS = 120_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 1_000
export const AI_REQUEST_TIMEOUT_MS = 25_000

export const AI_SYSTEM_PROMPT = [
  DEFAULT_ALLY_PERSONA.coreIdentity,
  ...DEFAULT_ALLY_PERSONA.voiceAndCadence,
  ...DEFAULT_ALLY_PERSONA.socialDynamics,
  ...DEFAULT_ALLY_PERSONA.antiAiRules,
].join(' ')

type AiAttempt = 'primary' | 'fallback'

export interface AiConversationMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface AiCallOptions {
  readonly history?: readonly AiConversationMessage[]
  readonly systemPrompt?: string
}

export type CompletionRequest = {
  readonly model: string
  readonly userMessage: string
  readonly history?: readonly AiConversationMessage[]
  readonly systemPrompt?: string
}

type CompletionResponse = {
  readonly content?: string | null
}

export type AiTransport = (request: CompletionRequest) => Promise<CompletionResponse>

export interface AiLogger {
  warn(metadata: Record<string, unknown>, message: string): void
}

export interface AiHandlerOptions {
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly primaryModel?: string
  readonly fallbackModel?: string
  readonly transport?: AiTransport
  readonly logger?: AiLogger
  readonly fallbackEnabled?: boolean
  readonly systemPrompt?: string
  readonly maxInputLength?: number
  readonly preserveNewlines?: boolean
}

export type AiErrorCode = 'missing_api_key' | 'invalid_input' | 'provider_unavailable'

export class AiHandlerError extends Error {
  constructor(readonly code: AiErrorCode, message: string) {
    super(message)
    this.name = 'AiHandlerError'
  }
}

function normalizeInput(message: string, preserveNewlines = false): string {
  if (preserveNewlines) {
    return message.replace(/[^\S\r\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  }
  return message.replace(/\s+/g, ' ').trim()
}

function boundedOutput(content: string): string {
  const normalized = content.trim()
  if (normalized.length <= MAX_AI_OUTPUT_LENGTH) return normalized
  return `${normalized.slice(0, MAX_AI_OUTPUT_LENGTH - 1)}…`
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError'
}

function safeErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined
}

export function createOpenAiCompatibleTransport(options: { apiKey: string; baseUrl?: string; systemPrompt?: string }): AiTransport {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseUrl ?? process.env.AI_BASE_URL ?? AI_BASE_URL,
    timeout: AI_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  })

  const configuredSystemPrompt = options.systemPrompt

  return async ({ model, userMessage, history, systemPrompt: callSystemPrompt }) => {
    const activeSystemPrompt = callSystemPrompt ?? configuredSystemPrompt ?? buildPersonaSystemPrompt()
    const historyLength = (history ?? []).reduce((sum, item) => sum + item.content.length, 0)
    const estimatedContextTokens = Math.ceil((userMessage.length + activeSystemPrompt.length + historyLength) / 3.5)
    if (estimatedContextTokens > MAX_AI_CONTEXT_TOKENS) {
      throw new AiHandlerError('invalid_input', `Konteks input melebihi batas maksimal ${MAX_AI_CONTEXT_TOKENS.toLocaleString()} token.`)
    }
    const maxTokens = Math.min(Number(process.env.AI_MAX_OUTPUT_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS, 4_000)
    const historyMessages = (history ?? []).map((entry) => ({
      role: entry.role,
      content: entry.content,
    }))
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: activeSystemPrompt },
        ...historyMessages,
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokens,
      stream: false,
    })
    return { content: response.choices[0]?.message?.content }
  }
}

export function createAiHandler(options: AiHandlerOptions = {}): (message: string, callOptions?: AiCallOptions) => Promise<string> {
  const configuredKey = options.apiKey ?? process.env.AI_API_KEY
  const apiKey = configuredKey?.trim()
  const primaryModel = options.primaryModel ?? process.env.AI_MODEL ?? PRIMARY_MODEL
  const configuredFallback = options.fallbackModel ?? process.env.AI_FALLBACK_MODEL
  const fallbackModel = configuredFallback?.trim() || primaryModel
  const transport = options.transport
    ?? (apiKey ? createOpenAiCompatibleTransport({ apiKey, baseUrl: options.baseUrl, systemPrompt: options.systemPrompt }) : undefined)
  const fallbackEnabled = options.fallbackEnabled ?? false
  const maxInputLength = options.maxInputLength ?? MAX_AI_INPUT_LENGTH
  const preserveNewlines = options.preserveNewlines ?? false

  return async (message: string, callOptions?: AiCallOptions): Promise<string> => {
    const input = normalizeInput(message, preserveNewlines)
    if (!input) throw new AiHandlerError('invalid_input', 'Pesan AI kosong.')
    if (input.length > maxInputLength) {
      throw new AiHandlerError('invalid_input', `Pesan AI terlalu panjang. Batasnya ${maxInputLength} karakter.`)
    }
    if (!transport) throw new AiHandlerError('missing_api_key', 'AI provider belum dikonfigurasi.')

    const extraPayload: Partial<CompletionRequest> = {
      ...(callOptions?.history && callOptions.history.length > 0 ? { history: callOptions.history } : {}),
      ...(callOptions?.systemPrompt ? { systemPrompt: callOptions.systemPrompt } : {}),
    }

    let primaryError: unknown
    try {
      const primary = boundedOutput((await transport({ model: primaryModel, userMessage: input, ...extraPayload })).content ?? '')
      if (primary) return primary
      primaryError = new Error('EmptyProviderResponse')
    } catch (error) {
      if (error instanceof AiHandlerError && error.code === 'invalid_input') {
        throw error
      }
      primaryError = error
    }
    options.logger?.warn({ attempt: 'primary' satisfies AiAttempt, errorName: safeErrorName(primaryError), status: safeErrorStatus(primaryError) }, 'AI provider attempt failed')

    if (!fallbackEnabled) throw new AiHandlerError('provider_unavailable', 'AI provider tidak tersedia.')

    try {
      const fallback = boundedOutput((await transport({ model: fallbackModel, userMessage: input, ...extraPayload })).content ?? '')
      if (fallback) return fallback
      throw new Error('EmptyProviderResponse')
    } catch (fallbackError) {
      if (fallbackError instanceof AiHandlerError && fallbackError.code === 'invalid_input') {
        throw fallbackError
      }
      options.logger?.warn({ attempt: 'fallback' satisfies AiAttempt, errorName: safeErrorName(fallbackError), status: safeErrorStatus(fallbackError) }, 'AI provider fallback failed')
      throw new AiHandlerError('provider_unavailable', 'AI provider tidak tersedia.')
    }
  }
}

/** Default handler instance; configured lazily from env (AI_API_KEY, AI_MODEL, ...). */
export const chatCompletion = createAiHandler()

export async function describeImageWithAi(
  dataUrl: string,
  prompt?: string,
  options: { apiKey?: string; baseUrl?: string; model?: string; maxTokens?: number } = {},
): Promise<string> {
  const configuredKey = options.apiKey ?? process.env.AI_API_KEY
  const apiKey = configuredKey?.trim()
  if (!apiKey) throw new AiHandlerError('missing_api_key', 'AI provider belum dikonfigurasi.')

  const baseUrl = options.baseUrl ?? process.env.AI_BASE_URL ?? AI_BASE_URL
  const model = options.model ?? process.env.AI_VISION_MODEL ?? 'gemini-3.5-flash-lite'

  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout: 25_000,
    maxRetries: 0,
  })

  const userPrompt = prompt?.trim() || 'Deskripsikan isi gambar ini secara singkat, padat, dan akurat dalam bahasa Indonesia yang santai dan natural.'
  const response = await client.chat.completions.create({
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: buildPersonaSystemPrompt(),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: options.maxTokens ?? 1_200,
  })

  return boundedOutput(response.choices[0]?.message?.content ?? 'Tidak ada deskripsi yang dihasilkan.')
}
