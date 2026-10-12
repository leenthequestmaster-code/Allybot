import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib'
const require = createRequire(import.meta.url)
const dns = require('node:dns/promises')
const http = require('node:http')
const https = require('node:https')
const moduleUrl = process.env.SAFE_FETCH_DIST || '../dist/services/downloader/safe-fetch.js'
const { safeFetch, assertPublicHttpUrl, isPrivateIp, boundedText, boundedBuffer,
  MAX_TEXT_BYTES, MAX_JSON_BYTES, MAX_MEDIA_BYTES, MAX_REDIRECTS } = await import(moduleUrl)

// Scoped transport fixture: no sockets and no internal services. The native
// request spy invokes the production lookup callback before supplying bytes.
async function fixture(run, { answers = ['93.184.216.34'], replies = [{ body: 'ok' }] } = {}) {
  const originals = { lookup: dns.lookup, http: http.request, https: https.request, fetch: globalThis.fetch }
  const state = { dns: 0, requests: [], streams: [], timers: [], consumed: [] }
  dns.lookup = async () => {
    const answer = answers[Math.min(state.dns++, answers.length - 1)]
    if (answer === 'stall') return new Promise(() => {})
    return (Array.isArray(answer) ? answer : [answer]).map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  function transport(protocol, options, callback) {
    const req = new EventEmitter()
    req.destroyed = false
    req.setTimeout = () => req
    req.destroy = error => {
      if (req.destroyed) return req
      req.destroyed = true
      req.response?.destroy()
      if (error) queueMicrotask(() => req.emit('error', error))
      return req
    }
    req.end = body => {
      state.consumed.push(body)
      queueMicrotask(async () => {
        if (req.destroyed) return
        const connected = (error, address, family) => {
          if (error) return req.emit('error', error)
          state.requests.push({ protocol, options, address, family, req })
          const reply = replies[Math.min(state.requests.length - 1, replies.length - 1)]
          const res = new PassThrough()
          req.response = res
          state.streams.push(res)
          res.statusCode = reply.status || 200
          res.statusMessage = 'OK'
          res.headers = reply.headers || {}
          res.rawHeaders = Object.entries(res.headers).flatMap(([key, value]) =>
            (Array.isArray(value) ? value : [value]).flatMap(item => [key, String(item)]))
          callback(res)
          if (reply.error) return res.destroy(new Error(reply.error))
          if (reply.stall) { res.write('x'); return }
          if (reply.chunks) reply.chunks.forEach(chunk => res.write(chunk))
          else if (reply.body != null) res.write(reply.body)
          res.end()
        }
        if (options.lookup) options.lookup(options.hostname, { all: false }, connected)
        else { const [entry] = await dns.lookup(options.hostname, { all: true }); connected(null, entry.address, entry.family) }
      })
    }
    return req
  }
  http.request = (options, callback) => transport('http:', options, callback)
  https.request = (options, callback) => transport('https:', options, callback)
  // Model naive fetch's independent resolution, without sending any traffic.
  globalThis.fetch = async (url, init) => {
    const [entry] = await dns.lookup(new URL(url).hostname, { all: true })
    state.requests.push({ address: entry.address, options: init })
    const reply = replies[Math.min(state.requests.length - 1, replies.length - 1)]
    return new Response(reply.stall ? new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])) } }) : reply.body || 'ok',
      { status: reply.status || 200, headers: reply.headers })
  }
  syncBuiltinESMExports()
  try { await run(state) } finally {
    dns.lookup = originals.lookup; http.request = originals.http; https.request = originals.https; globalThis.fetch = originals.fetch
    syncBuiltinESMExports()
    state.streams.forEach(stream => stream.destroy())
    state.timers.forEach(clearTimeout)
  }
}

test('DNS rebinding cannot change the validated connection address', async () => fixture(async state => {
  const response = await safeFetch('https://public.example/path')
  assert.equal(await response.text(), 'ok')
  assert.equal(state.dns, 1, 'transport must not perform an independent DNS resolution')
  assert.equal(state.requests[0].address, '93.184.216.34')
}, { answers: ['93.184.216.34', '127.0.0.1'] }))
test('private, special, hex-mapped and non-global addresses are rejected', async () => {
  for (const ip of ['0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.31.0.1','192.0.0.8','192.0.2.1','192.168.1.1','192.88.99.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','240.0.0.1','::','::1','::ffff:7f00:1','::ffff:a00:1','64:ff9b::7f00:1','100::1','2001:db8::1','2002:7f00:1::','fc00::1','fe80::1','ff02::1','3fff::1']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
  for (const ip of ['8.8.8.8','1.1.1.1','93.184.216.34','2001:4860:4860::8888','2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip)
  for (const url of ['http://2130706433','http://0177.0.0.1','http://0x7f000001','http://127.1','http://[::ffff:7f00:1]','ftp://example.com','http://u:secret@example.com','http://localhost.','http://foo.local','http://foo.internal','http://printer']) {
    await assert.rejects(assertPublicHttpUrl(url))
  }
})

test('public HTTPS pins address and keeps TLS SNI, final URL, cookies and body', async () => fixture(async state => {
  const response = await safeFetch('https://public.example:8443/path?x=1')
  assert.equal(await boundedText(response), 'hello')
  assert.equal(response.url, 'https://public.example:8443/path?x=1')
  assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/'])
  const request = state.requests[0]
  assert.equal(request.protocol, 'https:')
  assert.equal(request.options.hostname, 'public.example')
  assert.equal(request.options.servername, 'public.example')
  assert.equal(request.options.path, '/path?x=1')
  assert.equal(request.options.headers['accept-encoding'], 'identity')
  assert.equal(request.options.agent, false)
}, { replies: [{ body: 'hello', headers: { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] } }] }))

test('mixed DNS answers never reach the transport', async () => fixture(async state => {
  await assert.rejects(safeFetch('http://public.example/'), /private|special/i)
  assert.equal(state.requests.length, 0)
}, { answers: [['93.184.216.34', '127.0.0.1']] }))

test('malicious redirects are rejected before a second connection including manual mode', async () => {
  for (const redirect of ['follow','manual']) await fixture(async state => {
    await assert.rejects(safeFetch('https://public.example/', { redirect }), /redirect|private/i)
    assert.equal(state.requests.length, 1)
  }, { replies: [{ status: 302, headers: { location: 'http://[::ffff:7f00:1]/secret?token=hidden' } }] })
})

test('DNS redirect rebinding is pinned and cross-origin credentials are stripped', async () => fixture(async state => {
  const response = await safeFetch('https://public.example/start', { method: 'POST', body: new URLSearchParams({ q: 'a b' }),
    headers: { authorization: 'Bearer secret', cookie: 'sid=secret', 'x-api-key': 'secret', 'proxy-authorization': 'secret' } })
  assert.equal(response.url, 'https://other.example/final')
  assert.equal(response.redirected, true)
  assert.equal(state.requests.length, 2)
  assert.equal(state.requests[1].address, '1.1.1.1')
  assert.equal(state.requests[1].options.method, 'GET')
  for (const name of ['authorization','cookie','x-api-key','proxy-authorization','content-type']) assert.equal(state.requests[1].options.headers[name], undefined)
  assert.equal(state.requests[0].options.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8')
  assert.equal(state.consumed[0].toString(), 'q=a+b')
  assert.equal(state.consumed[1], undefined)
}, { answers: ['93.184.216.34','1.1.1.1','127.0.0.1'], replies: [
  { status: 302, headers: { location: 'https://other.example/final' } }, { body: 'ok' }
] }))

test('307 and 308 preserve POST and body on same-origin hops', async () => {
  for (const status of [307,308]) await fixture(async state => {
    await safeFetch('http://public.example/start', { method: 'POST', body: 'payload', headers: { authorization: 'secret' } })
    assert.equal(state.requests[1].options.method, 'POST')
    assert.equal(state.requests[1].options.headers.authorization, 'secret')
    assert.equal(state.consumed[1].toString(), 'payload')
  }, { replies: [{ status, headers: { location: '/final' } }, { body: 'ok' }] })
})

test('303 switches non-HEAD to GET and preserves HEAD', async () => {
  for (const method of ['PUT','HEAD']) await fixture(async state => {
    await safeFetch('http://public.example/start', { method, ...(method === 'PUT' ? { body: 'payload' } : {}) })
    assert.equal(state.requests[1].options.method, method === 'HEAD' ? 'HEAD' : 'GET')
    assert.equal(state.consumed[1], undefined)
  }, { replies: [{ status: 303, headers: { location: '/final' } }, { body: 'ok' }] })
})

test('manual returns a validated redirect without follow and error mode rejects', async () => {
  await fixture(async state => {
    const response = await safeFetch('http://public.example/start', { redirect: 'manual' })
    assert.equal(response.status, 302)
    assert.equal(state.requests.length, 1)
  }, { replies: [{ status: 302, headers: { location: '/final' } }] })
  await fixture(async state => {
    await assert.rejects(safeFetch('http://public.example/start', { redirect: 'error' }), /redirect/i)
    assert.equal(state.requests.length, 1)
  }, { replies: [{ status: 302, headers: { location: '/final' } }] })
})

test('five redirects maximum is enforced', async () => fixture(async state => {
  await assert.rejects(safeFetch('http://public.example/'), /redirect limit/i)
  assert.equal(state.requests.length, 6)
}, { replies: [{ status: 302, headers: { location: '/loop' } }] }))

test('stalled body is terminated within the total deadline', async () => fixture(async state => {
  const started = Date.now()
  await assert.rejects(safeFetch('http://public.example/secret?token=hidden', {}, { timeoutMs: 40 }), /deadline/i)
  assert.ok(Date.now() - started < 500)
  assert.equal(state.requests[0].req.destroyed, true)
  assert.equal(state.streams[0].destroyed, true)
}, { replies: [{ stall: true }] }))

test('stalled DNS is included in the deadline', async () => fixture(async state => {
  await assert.rejects(safeFetch('http://public.example/', {}, { timeoutMs: 30 }), /deadline/i)
  assert.equal(state.requests.length, 0)
}, { answers: ['stall'] }))

test('caller cancellation destroys an in-flight request and is sanitized', async () => fixture(async state => {
  const controller = new AbortController()
  state.timers.push(setTimeout(() => controller.abort(new Error('TOKEN_SECRET http://private/')), 20))
  await assert.rejects(safeFetch('http://public.example/', { signal: controller.signal }), error => {
    assert.match(error.message, /aborted/i)
    assert.doesNotMatch(error.message, /TOKEN_SECRET|http:/)
    return true
  })
  assert.equal(state.requests[0].req.destroyed, true)
}, { replies: [{ stall: true }] }))

test('pre-aborted caller never reaches transport', async () => fixture(async state => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(safeFetch('http://public.example/', { signal: controller.signal }), /aborted/i)
  assert.equal(state.requests.length, 0)
}))

test('chunked response is capped before safeFetch resolves', async () => fixture(async state => {
  await assert.rejects(safeFetch('http://public.example/', {}, { maxBytes: 8 }), /byte limit/i)
  assert.equal(state.requests[0].req.destroyed, true)
}, { replies: [{ chunks: ['12345','67890'] }] }))

test('content length exceeding cap destroys transport', async () => fixture(async state => {
  await assert.rejects(safeFetch('http://public.example/', {}, { maxBytes: 8 }), /byte limit/i)
  assert.equal(state.requests[0].req.destroyed, true)
}, { replies: [{ headers: { 'content-length': '100' }, body: 'x' }] }))

test('compressed expansion is bounded for gzip, br and deflate', async () => {
  for (const [encoding, compress] of [['gzip',gzipSync],['br',brotliCompressSync],['deflate',deflateSync]]) await fixture(async state => {
    await assert.rejects(safeFetch('http://public.example/', {}, { maxBytes: 128 }), /byte limit/i)
    assert.equal(state.requests[0].req.destroyed, true)
  }, { replies: [{ headers: { 'content-encoding': encoding }, body: compress(Buffer.alloc(4096, 65)) }] })
})

test('supported small compressed body decodes and unsupported encoding rejects', async () => {
  await fixture(async () => {
    const response = await safeFetch('http://public.example/')
    assert.equal(await response.text(), 'hello')
    assert.equal(response.headers.get('content-encoding'), null)
  }, { replies: [{ headers: { 'content-encoding': 'gzip' }, body: gzipSync('hello') }] })
  await fixture(async () => {
    await assert.rejects(safeFetch('http://public.example/'), /encoding/i)
  }, { replies: [{ headers: { 'content-encoding': 'zstd' }, body: 'x' }] })
})

test('default cap is 2 MiB and explicit media cap accepts larger bodies', async () => {
  assert.equal(MAX_REDIRECTS, 5); assert.equal(MAX_TEXT_BYTES, 2 * 1024 * 1024)
  assert.equal(MAX_JSON_BYTES, 1024 * 1024); assert.equal(MAX_MEDIA_BYTES, 50 * 1024 * 1024)
  await fixture(async () => {
    await assert.rejects(safeFetch('http://public.example/'), /byte limit/i)
  }, { replies: [{ body: Buffer.alloc(MAX_TEXT_BYTES + 1) }] })
  await fixture(async () => {
    const response = await safeFetch('http://public.example/', {}, { maxBytes: MAX_MEDIA_BYTES, timeoutMs: 60000 })
    assert.equal((await boundedBuffer(response)).length, MAX_TEXT_BYTES + 1)
  }, { replies: [{ body: Buffer.alloc(MAX_TEXT_BYTES + 1) }] })
})

test('bounded readers cancel untrusted streaming bodies on overflow', async () => {
  for (const reader of [boundedText,boundedBuffer]) {
    let cancelled = false
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(9)) }, cancel() { cancelled = true } }))
    await assert.rejects(reader(response, 8), /limit/i)
    assert.equal(cancelled, true)
  }
  assert.equal(await boundedText(new Response('hello')), 'hello')
  assert.deepEqual(await boundedBuffer(new Response(new Uint8Array([1,2]))), Buffer.from([1,2]))
})

test('errors never disclose URLs, DNS details or transport tokens', async () => {
  await assert.rejects(assertPublicHttpUrl('not-a-url-TOKEN_SECRET'), error => !error.message.includes('TOKEN_SECRET'))
  await fixture(async () => {
    await assert.rejects(safeFetch('http://public.example/?token=TOKEN_SECRET'), error => !/TOKEN_SECRET|public.example/.test(error.message))
  }, { replies: [{ error: 'TOKEN_SECRET http://private/' }] })
})

