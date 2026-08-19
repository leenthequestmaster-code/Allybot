import Groq from 'groq-sdk'

const GROQ_MODEL = 'openai/gpt-oss-20b'
const MAX_TOKENS = 100
const DEFAULT_TIMEOUT_MS = 15_000

export interface ChatGroqOptions {
  readonly timeoutMs?: number
}

const ALLYBOT_AI_INSTRUCTIONS = [
  'Anda adalah Allybot AI.',
  'Jangan pernah menyebutkan atau mengungkapkan nama model, provider, SDK, versi model, atau detail implementasi internal.',
  'Jika pengguna menanyakan identitas teknis Anda, jawab: Saya adalah Allybot AI.',
  'Jawab secara ringkas, membantu, dan sesuai bahasa pengguna.',
].join(' ')

const MODEL_DISCLOSURE_PATTERN = /\b(?:llama|gpt(?:[-\s]?\d+(?:\.\d+)?)?|chatgpt|groq|openai|mixtral|deepseek|qwen|gemma|claude|anthropic)\b/i
const TECHNICAL_IDENTITY_QUESTION = /(?:siapa kamu|kamu (?:pakai|menggunakan) (?:model|llm|provider|sdk)|model apa yang kamu gunakan|provider apa yang kamu gunakan|versi teknis apa|what model do you use|which model are you using)/i

function createGroqClient(timeoutMs: number): Groq {
  const apiKey = process.env.GROQ_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not configured')
  }

  return new Groq({
    apiKey,
    timeout: timeoutMs,
    maxRetries: 0,
    logLevel: 'off',
  })
}

function enforceIdentityBoundary(input: string, output: string): string {
  if (MODEL_DISCLOSURE_PATTERN.test(output) || TECHNICAL_IDENTITY_QUESTION.test(input)) {
    return 'Saya adalah Allybot AI.'
  }

  return output
}

/**
 * Sends one user message to Allybot AI and returns the assistant text.
 * The API key is read only from process.env.GROQ_API_KEY.
 */
export async function chatGroq(message: string, options: ChatGroqOptions = {}): Promise<string> {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new TypeError('message must be a non-empty string')
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive integer')
  }

  const groq = createGroqClient(timeoutMs)
  const completion = await groq.chat.completions.create({
    messages: [
      { role: 'system', content: ALLYBOT_AI_INSTRUCTIONS },
      { role: 'user', content: message.trim() },
    ],
    model: GROQ_MODEL,
    max_tokens: MAX_TOKENS,
  })

  const content = completion.choices[0]?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('Groq returned an empty response')
  }

  return enforceIdentityBoundary(message, content.trim())
}
