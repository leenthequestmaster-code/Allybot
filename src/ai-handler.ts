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


export interface GenerateImageOptions {
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly model?: string
  readonly timeoutMs?: number
  readonly imageBuffer?: Buffer
  readonly negativePrompt?: string
}

export interface GeneratedImageResult {
  readonly buffer: Buffer
  readonly mimeType: string
  readonly source: '9router-gemini' | 'pollinations-flux'
}

export function cleanImagePrompt(raw: string): string {
  let p = raw.trim()

  // 1. Strip WhatsApp mentions e.g. @628... or @2688484...
  p = p.replace(/@\d+(?::\d+)?(?:@s\.whatsapp\.net|@lid)?/g, ' ')

  // 2. Strip bot names & conversational particles
  const noiseRegex =
    /\b(?:chlona|allybot|ally|bot|dong|ya|tolong|coba|nih|sih|deh|kan|aja|saja|menurut\s+imajinasi\s+(?:kamu|mu)?|imajinasimu|imajinasi\s+kamu|bikinin|bikin(?:kan)?|buat(?:in|kan)?|gambarin|gambar(?:in|kan)?|lukis(?:in|kan)?|generate\s+image|foto|picture|t2i|text2img)\b/gi
  p = p.replace(noiseRegex, ' ')

  // 3. Collapse punctuation & extra whitespace
  p = p.replace(/[!?,.:;~#*_]/g, ' ').replace(/\s+/g, ' ').trim()

  // 4. Special handling for Allyssea
  if (/^allyssea$/i.test(p) || p.length === 0) {
    p = 'Allyssea fantasy kingdom landscape with magnificent castles, glowing crystal towers, lush enchanted forests, vibrant skies, highly detailed cinematic digital art'
  } else if (p.toLowerCase().includes('allyssea')) {
    p = p.replace(/\ballyssea\b/gi, 'Allyssea enchanted fantasy kingdom')
  }

  // 5. Expand single person/subject names for better photorealism
  if (/^prabowo(?:\s+subianto)?$/i.test(p)) {
    p = 'Prabowo Subianto in a dark formal suit, smiling, realistic detailed photographic portrait, professional studio lighting'
  }

  return p
}

export async function generateImageWithAi(
  prompt: string,
  options: GenerateImageOptions = {},
): Promise<GeneratedImageResult> {
  const rawPrompt = prompt.trim()
  if (!rawPrompt) throw new AiHandlerError('invalid_input', 'Prompt gambar tidak boleh kosong.')

  const cleanPrompt = cleanImagePrompt(rawPrompt)
  const effectivePrompt = options.negativePrompt ? `${cleanPrompt}. Avoid: ${options.negativePrompt}` : cleanPrompt

  const apiKey = (options.apiKey ?? process.env.AI_API_KEY)?.trim()
  const baseUrl = options.baseUrl ?? process.env.AI_BASE_URL ?? AI_BASE_URL
  const model = options.model ?? process.env.AI_IMAGE_MODEL ?? 'ag/gemini-3.1-flash-image'
  // Generous 120s timeout for high-resolution 1024x1024 generation during peak loads
  const timeoutMs = options.timeoutMs ?? 120_000

  // 1. Primary: 9Router / OpenAI-compatible /images/generations endpoint
  if (apiKey && baseUrl) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()

      const endpoint = `${baseUrl.replace(/\/+$/, '')}/images/generations`
      const res = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt: effectivePrompt,
          n: 1,
          size: 'auto',
          quality: 'auto',
          background: 'auto',
          image_detail: 'high',
          output_format: 'png',
        }),
      })
      clearTimeout(timer)

      if (res.ok) {
        const data: any = await res.json()
        const b64 = data.data?.[0]?.b64_json
        if (typeof b64 === 'string' && b64.length > 500) {
          return {
            buffer: Buffer.from(b64, 'base64'),
            mimeType: 'image/png',
            source: '9router-gemini',
          }
        }
        const imgUrl = data.data?.[0]?.url
        if (typeof imgUrl === 'string' && imgUrl.startsWith('http')) {
          const dlRes = await fetch(imgUrl, { signal: AbortSignal.timeout(20_000) })
          if (dlRes.ok) {
            return {
              buffer: Buffer.from(await dlRes.arrayBuffer()),
              mimeType: 'image/png',
              source: '9router-gemini',
            }
          }
        }
      }
    } catch {
      // Fallback to secondary provider
    }
  }

  // 2. Secondary Fallback: Pollinations.ai (using fast turboflux endpoint)
  try {
    const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(effectivePrompt)}?width=1024&height=1024&nologo=true&seed=${Date.now()}`
    const res = await fetch(fallbackUrl, { signal: AbortSignal.timeout(45_000) })
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length > 1000 && !buffer.slice(0, 100).toString('utf8').includes('FREE_LIMIT')) {
        return {
          buffer,
          mimeType: 'image/jpeg',
          source: 'pollinations-flux',
        }
      }
    }
  } catch (err) {
    throw new AiHandlerError('provider_unavailable', `Gagal menghasilkan gambar: ${String(err)}`)
  }

  throw new AiHandlerError('provider_unavailable', 'Layanan generate gambar sedang sibuk atau timeout. Coba ulangi sebentar lagi ya~')
}
