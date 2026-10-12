import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const MAX_MEDIA_BYTES = 50 * 1024 * 1024
function fixture(rel, overrides = {}) {
  const state = { calls: [], exec: 0 }
  const safe = {
    MAX_MEDIA_BYTES, MAX_JSON_BYTES: 1024 * 1024,
    assertPublicHttpUrl: async raw => {
      const u = new URL(raw)
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || ['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('Unsafe URL')
      return u
    },
    safeFetch: async (url, init = {}, options = {}) => {
      state.calls.push({url, init: { ...init, headers: init.headers ? { ...init.headers } : undefined }, options})
      return overrides.reply ? overrides.reply(url, init, state) : new Response('media')
    },
    boundedBuffer: async (res, cap) => { const b = Buffer.from(await res.arrayBuffer()); if (b.length > cap) throw new Error('Body too large'); return b },
  }
  const file = resolve(root, rel)
  const source = readFileSync(file, 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const module = { exports: {} }
  function mockRequire(id) {
    if (id.endsWith('safe-fetch.js')) return safe
    if (id.endsWith('circuit.js')) return { CircuitBreaker: class { execute(fn) { return fn() } }, CircuitOpenError: class extends Error {} }
    if (id.includes('/adapters/')) {
      const text = readFileSync(resolve(dirname(file), id.replace(/\.js$/, '.ts')), 'utf8')
      const name = /name: '([^']+)'/.exec(text)?.[1]
      const regex = /const (?:MATCH|PD_REGEX|VIDEY_REGEX) = (\/.*\/i)/.exec(text)?.[1]
      if (!name) return {}
      const symbol = name + 'Adapter'
      return { [symbol]: { name, match: vm.runInNewContext(regex), resolve: async () => ({ media: [{ size: overrides.size ?? null }], meta: {} }) } }
    }
    if (id === 'node:child_process') return { execFile: (...args) => { state.exec++; args.at(-1)(null, '{}', '') } }
    if (id.startsWith('.') || id === 'pino') return {}
    return require(id)
  }
  vm.runInNewContext(compiled, { module, exports: module.exports, require: mockRequire, URL, URLSearchParams, Headers, Response, Buffer, AbortSignal, AbortController, setTimeout, clearTimeout, console }, { filename: file })
  return { api: module.exports, state }
}
test('every in-repo downloader fetch is locally bound to safeFetch', () => {
  function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(resolve(dir,e.name)) : [resolve(dir,e.name)]) }
  const files = [...walk(resolve(root,'src/services/downloader')), resolve(root,'src/services/multidl.ts')].filter(f => f.endsWith('.ts') && !f.endsWith('/safe-fetch.ts'))
  for (const file of files) {
    const text = readFileSync(file,'utf8')
    if (/\bfetch\(/.test(text)) assert.match(text, /import\s*\{[^}]*safeFetch as fetch[^}]*\}\s*from/, file)
    assert.doesNotMatch(text, /globalThis\.fetch\s*=/, file)
  }
})
test('facade rejects hostile path/query/authority platform substrings', async () => {
  const {api} = fixture('src/services/downloader/index.ts')
  for (const raw of ['https://evil.test/twitter.com/u/status/123', 'https://evil.test/?url=https://instagram.com/p/xx', 'https://twitter.com.evil.test/u/status/123', 'https://twitter.com@evil.test/u/status/123']) assert.equal(api.detectPlatform(raw), null, raw)
  assert.equal(api.detectPlatform('https://x.com/u/status/123')?.name, 'twitter')
  await assert.rejects(api.resolveWith('twitter','https://evil.test/twitter.com/u/status/123'), /PLATFORM_UNSUPPORTED/)
})
test('facade defaults/clamps to 50MiB and enforces known and buffered sizes', async () => {
  const {api} = fixture('src/services/downloader/index.ts', {size: MAX_MEDIA_BYTES + 1})
  assert.equal(api.boundedResolveOptions().maxSizeMB, 50)
  assert.throws(() => api.enforceResultLimit({media:[{size:null}],meta:{size:'51 MB'}}, {maxSizeMB:50}), /melebihi/)
  assert.equal(api.boundedResolveOptions({maxSizeMB: 500}).maxSizeMB, 50)
  assert.equal(api.boundedResolveOptions({maxSizeMB: 4}).maxSizeMB, 4)
  await assert.rejects(api.resolveDownload('https://x.com/u/status/123'), /melebihi batas/)
  assert.throws(() => api.enforceResultLimit({media:[{size:null,buffer:new Uint8Array(2)}]}, {maxSizeMB:1/1048576}), /melebihi/)
})
test('multidl enforces real hostname before yt-dlp or TikWM and retains 25MiB default', async () => {
  const {api,state} = fixture('src/services/multidl.ts')
  assert.equal(api.detectPlatform('https://evil.test/?next=https://youtube.com/watch?v=x'), null)
  assert.equal(await api.resolveYtDlp('http://127.0.0.1/video'), null)
  assert.equal(await api.resolveTikWm('https://evil.test/tiktok.com/x'), null)
  assert.equal(state.exec, 0)
  assert.equal((await api.fetchMediaBuffer('https://cdn.example/file')).toString(), 'media')
  assert.equal(state.calls[0].options.maxBytes, 25*1024*1024)
  await api.fetchMediaBuffer('https://cdn.example/file', 100*1024*1024)
  assert.equal(state.calls[1].options.maxBytes, MAX_MEDIA_BYTES)
  assert.equal(await api.fetchMediaBuffer('https://cdn.example/file', 0), null)
})
test('TikWM JSON uses explicit 1MiB cap and validates input first', async () => {
  const {api,state} = fixture('src/services/multidl.ts', {reply: () => new Response(JSON.stringify({code:0,data:{play:'https://cdn.example/a'}}))})
  assert.equal((await api.resolveTikWm('https://www.tiktok.com/@u/video/123'))?.platform, 'tiktok')
  assert.equal(state.calls[0].options.maxBytes, 1024*1024)
})
test('Safelinku cookies never cross origin and derived form cannot POST elsewhere', async () => {
  const {api,state} = fixture('src/services/downloader/resolvers/safelinku.ts', {reply: (url,init,state) => state.calls.length === 1
    ? new Response('', {status:302,headers:{location:'https://other.example/end','set-cookie':'secret=one; Path=/'}})
    : new Response('done') })
  await api.resolveSafelinku('https://sfl.gl/a',false)
  assert.equal(state.calls[1].init.headers.Cookie, undefined)
  const hostile = fixture('src/services/downloader/resolvers/safelinku.ts', {reply: () => new Response('<form action="https://evil.test/redirect.php"><input name="ray_id" value="a"><input name="alias" value="b"></form>')})
  await assert.rejects(hostile.api.resolveSafelinku('https://sfl.gl/a',false), /Unexpected Safelinku form origin/)
  assert.equal(hostile.state.calls.length, 1)
})
test('Safelinku combined redirect/meta chains stop at finite total request budget', async () => {
  const {api,state} = fixture('src/services/downloader/resolvers/safelinku.ts', {reply: (url,init,state) => state.calls.length % 6
    ? new Response('', {status:302,headers:{location:`/hop-${state.calls.length}`}})
    : new Response(`<meta http-equiv="refresh" content="0;url=/next-${state.calls.length}">`) })
  await assert.rejects(api.resolveSafelinku('https://sfl.gl/a',false), /request budget/)
  assert.equal(state.calls.length, 40)
})
test('delivery protects oversized audio/image buffers before send', async () => {
  const {api} = fixture('src/services/downloader/deliver.ts')
  let sent = 0
  const logger = { warn(){}, info(){} }
  const huge = new Uint8Array(MAX_MEDIA_BYTES+1)
  for (const mime of ['audio/mpeg','image/png']) await api.deliverMedia({sendMedia:async()=>{sent++}}, 'jid', {type:'audio',title:'',author:'',meta:{},media:[{url:'https://cdn.example/a',mime,ext:'mp3',size:null,buffer:huge}]}, logger)
  assert.equal(sent,0)
})
test('delivery allows three active plus twelve queued and rejects overflow', async () => {
  const {api} = fixture('src/services/downloader/deliver.ts')
  let active = 0, peak = 0
  const releases = []
  const port = { sendMedia: async () => { active++; peak=Math.max(peak,active); await new Promise(r=>releases.push(r)); active-- } }
  const result={type:'image',title:'',author:'',meta:{},media:[{url:'https://cdn.example/a',mime:'image/png',ext:'png',size:1,buffer:new Uint8Array(1)}]}
  const logger={warn(){},info(){}}
  const jobs=Array.from({length:15},()=>api.deliverMedia(port,'jid',result,logger))
  await assert.rejects(api.deliverMedia(port,'jid',result,logger), /queue full/)
  for(let i=0;i<15;i++){ await new Promise(r=>setImmediate(r)); releases.shift()?.() }
  await Promise.all(jobs)
  assert.equal(peak,3)
})
