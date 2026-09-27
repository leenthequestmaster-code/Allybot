/**
 * Image Upscaler Service for Allybot
 * Integrates directly with PicWish Cloud API using native Node.js crypto and fetch.
 * Includes in-memory SHA-256 caching (TTL 1 hour) and input/output bounds.
 */

import crypto from 'node:crypto'

export interface UpscaleResult {
  readonly buffer: Buffer
  readonly latencyMs: number
  readonly fromCache: boolean
}

const PICWISH_BASE_URL = 'https://gw.aoscdn.com/app/picwish'
const PICWISH_API_VERSION = 'v2'
const PICWISH_PRODUCT_ID = 482
const PICWISH_LANGUAGE = 'en'

const MAX_INPUT_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024 // 20 MB

const UPSCALE_CACHE_TTL_MS = 3600_000 // 1 hour
const UPSCALE_CACHE_MAX = 200
const _upscaleCache = new Map<string, { ts: number; data: Buffer }>()

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function getCachedUpscale(hash: string): Buffer | null {
  const entry = _upscaleCache.get(hash)
  if (!entry) return null
  if (Date.now() - entry.ts > UPSCALE_CACHE_TTL_MS) {
    _upscaleCache.delete(hash)
    return null
  }
  return entry.data
}

function putCachedUpscale(hash: string, data: Buffer): void {
  if (_upscaleCache.size >= UPSCALE_CACHE_MAX) {
    const oldestKey = _upscaleCache.keys().next().value
    if (oldestKey) _upscaleCache.delete(oldestKey)
  }
  _upscaleCache.set(hash, { ts: Date.now(), data })
}

function generatePicWishToken(): string {
  const randNum = Math.floor(10_000_000 + Math.random() * 90_000_000)
  const uuid = crypto.randomUUID().replace(/-/g, '')
  return `${PICWISH_API_VERSION},${randNum},${PICWISH_PRODUCT_ID},${uuid}`
}

export async function upscaleImage(
  imageBuffer: Buffer,
  options?: { mimeType?: string; timeoutMs?: number },
): Promise<UpscaleResult> {
  const t0 = Date.now()

  if (imageBuffer.length === 0) {
    throw new Error('Gambar kosong.')
  }
  if (imageBuffer.length > MAX_INPUT_BYTES) {
    throw new Error(`Gambar terlalu besar (maksimal ${MAX_INPUT_BYTES / (1024 * 1024)} MB).`)
  }

  const hash = sha256(imageBuffer)
  const cached = getCachedUpscale(hash)
  if (cached) {
    return {
      buffer: cached,
      latencyMs: Date.now() - t0,
      fromCache: true,
    }
  }

  const mimeType = options?.mimeType || 'image/png'
  const token = generatePicWishToken()
  const headers = {
    'Authorization': `Bearer ${token}`,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Content-Type': 'application/json',
  }

  const filename = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'image.jpg' : 'image.png'

  // 1. Authorize OSS upload
  const ossRes = await fetch(
    `${PICWISH_BASE_URL}/authorizations/oss?product_id=${PICWISH_PRODUCT_ID}&language=${PICWISH_LANGUAGE}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ filenames: [filename] }),
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!ossRes.ok) {
    throw new Error(`Gagal otorisasi upload PicWish (${ossRes.status})`)
  }
  const ossJson = (await ossRes.json()) as any
  const oss = ossJson?.data
  if (!oss || !oss.credential) {
    throw new Error('Respons otorisasi PicWish tidak valid.')
  }

  const cred = oss.credential
  const accessKeyId = cred.access_key_id
  const accessKeySecret = cred.access_key_secret
  const securityToken = cred.security_token
  const accelerate = oss.accelerate
  const bucket = oss.bucket
  const objectKey = Object.values(oss.objects)[0] as string
  const dateStr = new Date().toUTCString()

  const callbackPayload = Buffer.from(
    JSON.stringify({
      callbackUrl: oss.callback.url,
      callbackBody: oss.callback.body,
      callbackBodyType: oss.callback.type,
    }),
  ).toString('base64')

  const ossHeaders: Record<string, string> = {
    'content-type': mimeType,
    'x-oss-callback': callbackPayload,
    'x-oss-date': dateStr,
    'x-oss-security-token': securityToken,
  }

  const canonicalOssHeaders = Object.keys(ossHeaders)
    .filter((k) => k.startsWith('x-oss-'))
    .sort()
    .map((k) => `${k}:${ossHeaders[k]}`)
    .join('\n')

  const canonicalResource = `/${bucket}/${objectKey}`
  const stringToSign = ['PUT', '', ossHeaders['content-type'], ossHeaders['x-oss-date'], canonicalOssHeaders, canonicalResource].join('\n')

  const signature = crypto.createHmac('sha1', accessKeySecret).update(stringToSign, 'utf8').digest('base64')

  const putHeaders = {
    'Authorization': `OSS ${accessKeyId}:${signature}`,
    'Content-Type': mimeType,
    'X-Oss-Date': dateStr,
    'X-Oss-Security-Token': securityToken,
    'X-Oss-Callback': callbackPayload,
  }

  const putUrl = `https://${bucket}.${accelerate}/${objectKey}`
  const putRes = await fetch(putUrl, {
    method: 'PUT',
    headers: putHeaders,
    body: imageBuffer,
    signal: AbortSignal.timeout(30_000),
  })

  if (!putRes.ok) {
    throw new Error(`Upload gambar ke PicWish gagal (${putRes.status})`)
  }
  const putJson = (await putRes.json()) as any
  const resourceId = putJson?.data?.resource_id
  if (!resourceId) {
    throw new Error('Resource ID PicWish tidak ditemukan.')
  }

  // 2. Create enhance task (type 2 = face enhancement)
  const taskRes = await fetch(
    `${PICWISH_BASE_URL}/tasks/login/scale?product_id=${PICWISH_PRODUCT_ID}&language=${PICWISH_LANGUAGE}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        website: 'en',
        source_resource_id: resourceId,
        type: 2,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!taskRes.ok) {
    throw new Error(`Pembuatan tugas HD PicWish gagal (${taskRes.status})`)
  }
  const taskJson = (await taskRes.json()) as any
  const taskId = taskJson?.data?.task_id
  if (!taskId) {
    throw new Error('Task ID PicWish tidak ditemukan.')
  }

  // 3. Poll for completion (up to ~30 seconds)
  let isDone = false
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 800))
    const pollRes = await fetch(
      `${PICWISH_BASE_URL}/tasks/login/scale/${taskId}?product_id=${PICWISH_PRODUCT_ID}&language=${PICWISH_LANGUAGE}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    )
    if (pollRes.ok) {
      const pollJson = (await pollRes.json()) as any
      if (pollJson?.data?.progress === 100 || pollJson?.data?.image) {
        isDone = true
        break
      }
    }
  }

  if (!isDone) {
    throw new Error('Waktu proses HD habis (timeout). Coba lagi nanti ya~')
  }

  // 4. Get final image URL without watermark
  const imgUrlRes = await fetch(
    `${PICWISH_BASE_URL}/tasks/login/image-url/scale/${taskId}?product_id=${PICWISH_PRODUCT_ID}&language=${PICWISH_LANGUAGE}&pic_quality=free`,
    { headers, signal: AbortSignal.timeout(15_000) },
  )
  if (!imgUrlRes.ok) {
    throw new Error('Gagal mengambil link hasil HD dari PicWish.')
  }
  const imgUrlJson = (await imgUrlRes.json()) as any
  const finalUrl = imgUrlJson?.data?.image
  if (!finalUrl) {
    throw new Error('Link hasil gambar HD tidak tersedia.')
  }

  // 5. Download final enhanced image buffer
  const dlRes = await fetch(finalUrl, { signal: AbortSignal.timeout(20_000) })
  if (!dlRes.ok) {
    throw new Error('Gagal mengunduh gambar hasil HD.')
  }
  const arrayBuffer = await dlRes.arrayBuffer()
  if (arrayBuffer.byteLength > MAX_OUTPUT_BYTES) {
    throw new Error('Ukuran hasil HD melebihi batas 20 MB.')
  }

  const resultBuffer = Buffer.from(arrayBuffer)
  putCachedUpscale(hash, resultBuffer)

  return {
    buffer: resultBuffer,
    latencyMs: Date.now() - t0,
    fromCache: false,
  }
}
