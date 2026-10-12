import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib'
import type { Readable, Transform } from 'node:stream'

export const MAX_REDIRECTS = 5
export const MAX_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_JSON_BYTES = 1024 * 1024
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024

class SafeFetchError extends Error {}
function failure(message: string): Error { return new SafeFetchError(message) }

// Positive IPv6 global-unicast policy; IPv4 special-purpose ranges are denied.
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
  }
  if (isIP(ip) !== 6) return true
  const parts = ip.toLowerCase().split('::')
  const left = parts[0] ? parts[0].split(':') : []
  const right = parts.length > 1 && parts[1] ? parts[1].split(':') : []
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].map(x => Number.parseInt(x, 16))
  const [a, b] = groups
  return a < 0x2000 || a > 0x3fff || a === 0x2002 ||
    (a === 0x2001 && (b <= 0x1ff || b === 0xdb8)) || (a === 0x3fff && b <= 0xfff)
}

function parseUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw failure('Invalid URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw failure('Forbidden protocol')
  if (url.username || url.password) throw failure('Credentialed URLs are rejected')
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host || (!isIP(host) && (!host.includes('.') ||
    /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion|home\.arpa)$/.test(host)))) {
    throw failure('Blocked local host')
  }
  if (isIP(host) && isPrivateIp(host)) throw failure('Blocked private IP target')
  return url
}

type Address = { address: string; family: number }
async function resolve(url: URL): Promise<Address> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return { address: host, family: isIP(host) }
  let addresses: Address[]
  try { addresses = await lookup(host, { all: true, verbatim: true }) }
  catch { throw failure('DNS resolution failed') }
  if (!addresses.length || addresses.some(a => isPrivateIp(a.address) || isIP(a.address) !== a.family)) {
    throw failure('Blocked private or special DNS address')
  }
  return addresses[0]
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const url = parseUrl(raw)
  await resolve(url)
  return url
}

export interface SafeFetchOptions {
  readonly maxRedirects?: number
  readonly timeoutMs?: number
  readonly maxBytes?: number
}

function withinDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((ok, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); ok(value) }, error => {
      signal.removeEventListener('abort', abort); reject(error)
    })
  })
}

function requestBounded(url: URL, address: Address, method: string, headers: Headers,
  body: Buffer | undefined, signal: AbortSignal, maxBytes: number): Promise<Response> {
  return new Promise((ok, reject) => {
    let settled = false
    let input: Readable | undefined
    let decoded: Readable | undefined
    const finish = (error?: Error, value?: Response) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      if (error) {
        input?.destroy(); decoded?.destroy(); req.destroy()
        reject(error)
      } else ok(value!)
    }
    const abort = () => finish(failure(signal.aborted && signal.reason instanceof Error ? signal.reason.message : 'Request aborted'))
    const opts: RequestOptions = {
      protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined, path: url.pathname + url.search, method,
      headers: Object.fromEntries(headers.entries()), agent: false,
      lookup: ((_: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (signal.aborted) callback(failure('Request aborted'))
        else if (options.all) callback(null, [address])
        else callback(null, address.address, address.family)
      }) as RequestOptions['lookup'],
    }
    if (url.protocol === 'https:' && !isIP(opts.hostname!)) Object.assign(opts, { servername: opts.hostname })
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(opts, res => {
      input = res
      if (signal.aborted) { abort(); return }
      const responseHeaders = new Headers()
      for (let i = 0; i < res.rawHeaders.length; i += 2) responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1])
      const encoding = (responseHeaders.get('content-encoding') || 'identity').trim().toLowerCase()
      const length = responseHeaders.get('content-length')
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        finish(failure('Response exceeds byte limit')); return
      }
      decoded = res
      if (encoding !== 'identity') {
        if (encoding === 'gzip') decoded = createGunzip()
        else if (encoding === 'br') decoded = createBrotliDecompress()
        else if (encoding === 'deflate') decoded = createInflate()
        else { finish(failure('Unsupported content encoding')); return }
        decoded.on('error', () => finish(failure('Invalid compressed response')))
      }
      let wireBytes = 0
      res.on('data', (chunk: Buffer) => { wireBytes += chunk.length; if (wireBytes > maxBytes) finish(failure('Response exceeds byte limit')) })
      res.on('error', () => finish(failure('Response transport failed')))
      res.on('aborted', () => finish(failure('Response transport failed')))
      res.on('close', () => { if (!res.readableEnded) finish(failure('Response transport failed')) })
      const chunks: Buffer[] = []
      let total = 0
      decoded.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) { finish(failure('Response exceeds byte limit')); return }
        chunks.push(Buffer.from(chunk))
      })
      decoded.on('end', () => {
        if (settled) return
        if (encoding !== 'identity') { responseHeaders.delete('content-encoding'); responseHeaders.delete('content-length') }
        const status = res.statusCode || 502
        try {
          const value = new Response(method === 'HEAD' || status === 204 || status === 205 || status === 304 ? null : Buffer.concat(chunks, total),
            { status, statusText: res.statusMessage, headers: responseHeaders })
          Object.defineProperty(value, 'url', { value: url.href })
          finish(undefined, value)
        } catch { finish(failure('Invalid HTTP response')) }
      })
      if (decoded !== res) res.pipe(decoded as Transform)
    })
    req.on('error', () => finish(failure('Request transport failed')))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else req.end(body)
  })
}

export async function safeFetch(raw: string, init: RequestInit = {}, options: SafeFetchOptions = {}): Promise<Response> {
  const maxBytes = options.maxBytes ?? MAX_TEXT_BYTES
  const timeoutMs = options.timeoutMs ?? 15_000
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
    !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > MAX_REDIRECTS) throw failure('Invalid safe fetch limits')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(failure('Request deadline exceeded')), timeoutMs)
  const callerAbort = () => controller.abort(failure('Request aborted'))
  init.signal?.addEventListener('abort', callerAbort, { once: true })
  if (init.signal?.aborted) callerAbort()
  try {
    let url = parseUrl(raw)
    let method = (init.method || 'GET').toUpperCase()
    if (!/^[A-Z]+$/.test(method) || ['CONNECT', 'TRACE', 'TRACK'].includes(method)) throw failure('Unsupported request method')
    let body: Buffer | undefined
    const headers = new Headers(init.headers)
    if (init.body != null) {
      if (typeof init.body === 'string') { body = Buffer.from(init.body); if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8') }
      else if (init.body instanceof URLSearchParams) { body = Buffer.from(init.body.toString()); if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8') }
      else if (init.body instanceof ArrayBuffer) body = Buffer.from(init.body)
      else if (ArrayBuffer.isView(init.body)) body = Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength)
      else throw failure('Unsupported request body')
    }
    if (body && (method === 'GET' || method === 'HEAD')) throw failure('Request body not allowed')
    for (const name of ['host', 'connection', 'transfer-encoding', 'content-length', 'upgrade', 'proxy-connection']) headers.delete(name)
    headers.set('accept-encoding', 'identity')
    let address = await withinDeadline(resolve(url), controller.signal)
    for (let hop = 0; ; hop++) {
      const response = await requestBounded(url, address, method, headers, body, controller.signal, maxBytes)
      const location = response.headers.get('location')
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        Object.defineProperty(response, 'redirected', { value: hop > 0 }); return response
      }
      let next: URL
      try { next = parseUrl(new URL(location, url).href) } catch { throw failure('Blocked redirect target') }
      const nextAddress = await withinDeadline(resolve(next), controller.signal)
      if (init.redirect === 'error') throw failure('Redirect not allowed')
      if (init.redirect === 'manual') return response
      if (hop >= maxRedirects) throw failure('Exceeded maximum redirect limit')
      if (url.origin !== next.origin) {
        for (const name of ['authorization', 'cookie', 'cookie2', 'proxy-authorization', 'x-api-key', 'api-key', 'x-auth-token', 'x-access-token', 'referer', 'origin']) headers.delete(name)
      }
      if ((response.status === 303 && method !== 'HEAD') || ([301, 302].includes(response.status) && method === 'POST')) {
        method = 'GET'; body = undefined
        for (const name of ['content-type', 'content-encoding', 'content-language', 'content-location', 'content-length']) headers.delete(name)
      }
      url = next; address = nextAddress
    }
  } catch (error) {
    if (error instanceof SafeFetchError) throw error
    throw failure('Safe fetch request failed')
  } finally {
    clearTimeout(timer); init.signal?.removeEventListener('abort', callerAbort)
  }
}

export async function boundedBuffer(res: Response, maxBytes = MAX_MEDIA_BYTES): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw failure('Invalid byte limit')
  const length = res.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await res.body?.cancel().catch(() => {})
    throw failure('Response exceeds maximum allowed buffer size')
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, total)
      total += value.byteLength
      if (total > maxBytes) { await reader.cancel().catch(() => {}); throw failure('Response exceeds byte limit') }
      chunks.push(Buffer.from(value))
    }
  } catch {
    await reader.cancel().catch(() => {})
    throw failure('Response exceeds byte limit or stream failed')
  } finally { reader.releaseLock() }
}
export async function boundedText(res: Response, maxBytes = MAX_TEXT_BYTES): Promise<string> {
  return (await boundedBuffer(res, maxBytes)).toString('utf8')
}
export async function boundedJson<T = unknown>(res: Response, maxBytes = MAX_JSON_BYTES): Promise<T> {
  try { return JSON.parse(await boundedText(res, maxBytes)) as T }
  catch { throw failure('Invalid or oversized JSON response') }
}
