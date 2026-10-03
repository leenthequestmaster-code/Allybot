// Mock server untuk development !verify plugin.
// Meniru response shape service produksi.
// Jalankan: node --experimental-strip-types scripts/mock-verify-server.mts
// Atau: PORT=3001 node --experimental-strip-types scripts/mock-verify-server.mts

import http from 'node:http'

const PORT = Number(process.env.PORT ?? 3000)

// email → { link, verified }
const sessions = new Map<string, { link: string; verified: boolean }>()

function json(
  res: http.ServerResponse,
  status: number,
  body: { status: boolean; message: string; data: unknown },
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || 'null')) }
      catch { resolve(null) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  const method = req.method ?? 'GET'

  // ── POST /api/send ──────────────────────────────────────────────────────
  // body: { email: string }
  // response: { status, message, data: { email, link, token } }
  if (method === 'POST' && url.pathname === '/api/send') {
    const body = await readBody(req) as Record<string, string> | null
    const email = body?.email ?? ''

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return json(res, 400, { status: false, message: 'Format email tidak valid.', data: null })
    }

    const token = Math.random().toString(36).slice(2, 18)
    const link = `http://localhost:${PORT}/verify?token=${token}&email=${encodeURIComponent(email)}`
    sessions.set(email, { link, verified: false })

    console.log(`[mock] send → ${email} → ${link}`)
    await new Promise(r => setTimeout(r, 300))
    return json(res, 200, {
      status: true,
      message: `Link verifikasi terkirim ke ${email}.`,
      data: { email, link, token },
    })
  }

  // ── POST /api/verify ────────────────────────────────────────────────────
  // body: { email: string, link: string }
  // response: { status, message, data: { email, verified_at } }
  if (method === 'POST' && url.pathname === '/api/verify') {
    const body = await readBody(req) as Record<string, string> | null
    const email = body?.email ?? ''
    const link = body?.link ?? ''

    if (!email || !link) {
      return json(res, 400, { status: false, message: 'Email dan link wajib diisi.', data: null })
    }

    const session = sessions.get(email)
    if (!session) {
      return json(res, 404, {
        status: false,
        message: 'Sesi tidak ditemukan. Mulai dari !verify <email>.',
        data: null,
      })
    }

    if (session.verified) {
      return json(res, 200, {
        status: true,
        message: 'Akun sudah diverifikasi sebelumnya.',
        data: { email, verified_at: new Date().toISOString() },
      })
    }

    if (link !== session.link) {
      return json(res, 400, {
        status: false,
        message: 'Link verifikasi tidak cocok.',
        data: null,
      })
    }

    session.verified = true
    console.log(`[mock] verify → ${email} → OK`)
    await new Promise(r => setTimeout(r, 300))
    return json(res, 200, {
      status: true,
      message: 'Verifikasi berhasil. Akun aktif.',
      data: { email, verified_at: new Date().toISOString() },
    })
  }

  // ── GET /verify ─────────────────────────────────────────────────────────
  // Landing page — user copy URL ini dan paste ke bot.
  if (method === 'GET' && url.pathname === '/verify') {
    const email = url.searchParams.get('email') ?? '-'
    const token = url.searchParams.get('token') ?? '-'
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:600px">
        <h2>Verifikasi Email</h2>
        <p>Email: <b>${email}</b></p>
        <p>Token: <code>${token}</code></p>
        <p>Copy URL di address bar ini, paste ke bot WhatsApp.</p>
      </body></html>
    `)
  }

  // ── Failure simulation ──────────────────────────────────────────────────
  if (url.pathname === '/__fail/timeout') return // never respond — trigger client timeout
  if (url.pathname === '/__fail/500') return json(res, 500, { status: false, message: 'Internal error.', data: null })
  if (url.pathname === '/__fail/reset') {
    sessions.clear()
    return json(res, 200, { status: true, message: 'Sessions cleared.', data: null })
  }

  json(res, 404, { status: false, message: 'Not found.', data: null })
})

server.listen(PORT, () => {
  console.log(`[mock] running on http://localhost:${PORT}`)
  console.log(`[mock] endpoints: POST /api/send  POST /api/verify  GET /verify`)
  console.log(`[mock] fail sims: GET /__fail/timeout  /__fail/500  /__fail/reset`)
})
