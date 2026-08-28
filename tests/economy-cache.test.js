import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EconomyService,
  EconomyOperationError,
  EconomyUnavailableError,
  createEconomyOperationKey,
} from '../dist/services/economy-service.js'
import { economyPlugin } from '../dist/framework/plugins/economy.js'

function loggerFor(events = []) {
  return {
    info(fields, message) {
      events.push({ level: 'info', fields, message })
    },
    warn(fields, message) {
      events.push({ level: 'warn', fields, message })
    },
    debug(fields, message) {
      events.push({ level: 'debug', fields, message })
    },
  }
}

function servicesFor(service) {
  return {
    has(name) {
      return name === 'upstash-redis'
    },
    get(name) {
      if (name === 'economy') return service
      throw new Error(`unexpected service: ${name}`)
    },
  }
}

function contextFor(service, redis) {
  return {
    logger: loggerFor(),
    config: {},
    services: {
      has(name) {
        return name === 'upstash-redis'
      },
      get(name) {
        if (name === 'upstash-redis') return redis
        if (name === 'economy') return service
        throw new Error(`unexpected service: ${name}`)
      },
    },
  }
}

function createFixture({ redisEnabled = true, rpcData, rpcError = null } = {}) {
  const calls = []
  const cache = new Map()
  const redis = {
    isEnabled: redisEnabled,
    async cacheGet(_scope, identity) {
      calls.push({ operation: 'cacheGet', identity })
      return cache.get(identity)
    },
    async cacheSet(_scope, identity, value, ttlSeconds) {
      calls.push({ operation: 'cacheSet', identity, value, ttlSeconds })
      cache.set(identity, value)
      return true
    },
    async cacheDelete(_scope, identity) {
      calls.push({ operation: 'cacheDelete', identity })
      cache.delete(identity)
      return true
    },
  }
  const rpcClient = {
    async rpc(functionName, args) {
      calls.push({ operation: 'rpc', functionName, args })
      return { data: rpcData ?? {
        economy_enabled: true,
        wallet_balance: 1250,

        safe_balance: 4000,
        safe_limit: 50000,
        restricted_wallet_balance: 0,
        reserved_wallet_balance: 0,
        membership_tier: 'basic',
        safe_status: 'active',
        revision: 2,
        as_of: '2026-08-24T00:00:00.000Z',
      }, error: rpcError }
    },
  }
  const service = new EconomyService(loggerFor(), {
    env: {
      SUPABASE_ECONOMY_ENABLED: 'true',
      SUPABASE_URL: 'https://project.example.test',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
    },
    cacheTtlSeconds: 15,
    createClient: () => rpcClient,
    redis,
  })
  service.initialize(contextFor(service, redis))
  return { service, redis, calls, cache }
}

const GROUP_JID = 'economy-test-group@g.us'
const SUBJECT_JID = 'economy-test-user@s.whatsapp.net'

// The fake Redis stores test values locally; production keys are hashed by UpstashRedisService.
test('Economy read-through uses Supabase on miss and Redis on subsequent hit', async () => {
  const fixture = createFixture()

  const first = await fixture.service.getAccountSnapshot(GROUP_JID, SUBJECT_JID)
  assert.equal(first.source, 'postgres')
  assert.equal(first.snapshot.walletBalance, 1250)
  assert.equal(fixture.calls.filter((call) => call.operation === 'rpc').length, 1)
  assert.equal(fixture.calls.filter((call) => call.operation === 'cacheSet').length, 1)
  assert.equal(fixture.calls.find((call) => call.operation === 'cacheSet').ttlSeconds, 15)

  const second = await fixture.service.getAccountSnapshot(GROUP_JID, SUBJECT_JID)
  assert.equal(second.source, 'cache')
  assert.equal(second.snapshot.safeBalance, 4000)
  assert.equal(fixture.calls.filter((call) => call.operation === 'rpc').length, 1)
})

test('Economy RPC receives hashed scope and subject keys, never raw JIDs', async () => {
  const fixture = createFixture()
  await fixture.service.getAccountSnapshot(GROUP_JID, SUBJECT_JID)

  const rpcCall = fixture.calls.find((call) => call.operation === 'rpc')
  assert.equal(rpcCall.args.p_scope_key.length, 64)
  assert.equal(rpcCall.args.p_subject_key.length, 64)
  assert.match(rpcCall.args.p_scope_key, /^[0-9a-f]{64}$/)
  assert.match(rpcCall.args.p_subject_key, /^[0-9a-f]{64}$/)
  assert.equal(rpcCall.args.p_scope_key.includes(GROUP_JID), false)
  assert.equal(rpcCall.args.p_subject_key.includes(SUBJECT_JID), false)
})

test('Economy bypasses Redis when disabled and still reads authoritative Supabase', async () => {
  const fixture = createFixture({ redisEnabled: false })
  const result = await fixture.service.getAccountSnapshot(GROUP_JID, SUBJECT_JID)

  assert.equal(result.source, 'postgres')
  assert.equal(fixture.calls.filter((call) => call.operation === 'cacheGet').length, 0)
  assert.equal(fixture.calls.filter((call) => call.operation === 'cacheSet').length, 0)
  assert.equal(fixture.calls.filter((call) => call.operation === 'rpc').length, 1)
})

test('Economy rejects invalid authoritative snapshot instead of showing unsafe data', async () => {
  const fixture = createFixture({ rpcData: {
    wallet_balance: -1,
    safe_balance: 0,
    safe_limit: 50000,
    restricted_wallet_balance: 0,
    membership_tier: 'basic',
    safe_status: 'active',
    revision: 0,
    as_of: '2026-08-24T00:00:00.000Z',
  } })

  await assert.rejects(
    () => fixture.service.getAccountSnapshot(GROUP_JID, SUBJECT_JID),
    EconomyUnavailableError,
  )
})

test('Economy invalidation removes the account cache entry', async () => {
  const fixture = createFixture()
  await fixture.service.getAccountSnapshot(GROUP_JID, SUBJECT_JID)
  assert.equal(fixture.cache.size, 1)

  assert.equal(await fixture.service.invalidateAccount(GROUP_JID, SUBJECT_JID), true)
  assert.equal(fixture.cache.size, 0)
})

test('Economy plugin renders the authoritative snapshot to the user', async () => {
  const fixture = createFixture()
  const commands = []
  economyPlugin.load({
    logger: loggerFor(),
    config: {},
    events: {},
    commands: {
      register(command) {
        commands.push(command)
        return () => undefined
      },
    },
    services: servicesFor(fixture.service),
  })

  const vela = commands.find((command) => command.name === 'vela')
  assert.ok(vela)
  const replies = []
  await vela.handler({
    message: { remoteJid: GROUP_JID, senderJid: SUBJECT_JID },
    args: [],
    commandName: 'vela',
    prefix: '!',
    config: {},
    logger: loggerFor(),
    services: servicesFor(fixture.service),
    whatsapp: { userJid: SUBJECT_JID },
    reply: async (text) => replies.push(text),
  })

  assert.equal(replies.length, 1)
  assert.equal(replies[0], [
    'Vela Status',
    'Wallet:',
    'Saldo tersedia: 1.250 Vela',
    'Limit: 20.000 Vela',
    'Tertahan karena limit: 0 Vela',
    'Ditahan untuk transfer: 0 Vela',
    'Safe:',
    'Status: Aktif',
    'Saldo: 4.000 Vela',
    'Kapasitas: 50.000 Vela',
    'Membership: Basic',
    'Total tercatat: 5.250 Vela',
  ].join('\n'))
})

test('Economy renders a plain disabled status with activation guidance', async () => {
  const fixture = createFixture({ rpcData: {
    economy_enabled: false,
    wallet_balance: 0,
    safe_balance: 0,
    safe_limit: 50000,
    restricted_wallet_balance: 0,
    reserved_wallet_balance: 0,
    membership_tier: 'basic',
    safe_status: 'not_open',
    revision: 0,
    as_of: '2026-08-24T00:00:00.000Z',
  } })
  const commands = []
  economyPlugin.load({
    logger: loggerFor(),
    config: {},
    events: {},
    commands: {
      register(command) {
        commands.push(command)
        return () => undefined
      },
    },
    services: servicesFor(fixture.service),
  })

  const vela = commands.find((command) => command.name === 'vela')
  const replies = []
  await vela.handler({
    message: { remoteJid: GROUP_JID, senderJid: SUBJECT_JID },
    args: [],
    commandName: 'vela',
    prefix: '!',
    config: {},
    logger: loggerFor(),
    services: servicesFor(fixture.service),
    whatsapp: { userJid: SUBJECT_JID },
    reply: async (text) => replies.push(text),
  })

  assert.equal(replies.length, 1)
  assert.equal(replies[0], [
    'Vela Status',
    'Status: Belum diaktifkan di grup ini',
    'Keterangan: Aktivasi dilakukan oleh pengelola grup melalui policy yang sah.',
  ].join('\n'))
})

test('Economy falls back to Supabase when Redis cache operations fail', async () => {
  const calls = []
  const redis = {
    isEnabled: true,
    async cacheGet() {
      calls.push('cacheGet')
      throw new Error('synthetic redis outage')
    },
    async cacheSet() {
      calls.push('cacheSet')
      throw new Error('synthetic redis outage')
    },
    async cacheDelete() {
      calls.push('cacheDelete')
      throw new Error('synthetic redis outage')
    },
  }
  const rpcClient = {
    async rpc() {
      calls.push('rpc')
      return {
        data: {
          economy_enabled: true,
          wallet_balance: 100,

          safe_balance: 0,
          safe_limit: 50000,
          restricted_wallet_balance: 0,
          reserved_wallet_balance: 0,
          membership_tier: 'basic',
          safe_status: 'not_open',
          revision: 0,
          as_of: '2026-08-24T00:00:00.000Z',
        },
        error: null,
      }
    },
  }
  const service = new EconomyService(loggerFor(), {
    env: {
      SUPABASE_ECONOMY_ENABLED: 'true',
      SUPABASE_URL: 'https://project.example.test',
      SUPABASE_SERVICE_ROLE_KEY: 'server-only-key',
    },
    createClient: () => rpcClient,
    redis,
  })
  service.initialize(contextFor(service, redis))

  const result = await service.getAccountSnapshot(GROUP_JID, SUBJECT_JID)
  assert.equal(result.source, 'postgres')
  assert.deepEqual(calls, ['cacheGet', 'rpc', 'cacheSet'])
})

test('Economy plugin registers no commands when the feature flag is disabled', () => {
  const disabledService = new EconomyService(loggerFor(), { env: {} })
  disabledService.initialize(contextFor(disabledService, { isEnabled: false }))
  const commands = []
  economyPlugin.load({
    logger: loggerFor(),
    config: {},
    events: {},
    commands: {
      register(command) {
        commands.push(command)
        return () => undefined
      },
    },
    services: servicesFor(disabledService),
  })
  assert.deepEqual(commands, [])
})

test('Economy deposit calls authoritative RPC and invalidates the account cache', async () => {
  const fixture = createFixture({ rpcData: { status: 'applied', amount: 1000 } })
  const result = await fixture.service.deposit(
    GROUP_JID,
    SUBJECT_JID,
    1000,
    SUBJECT_JID,
    createEconomyOperationKey('bank-deposit', 'message-deposit-1'),
  )

  assert.equal(result.status, 'applied')
  const rpcCall = fixture.calls.find((call) => call.operation === 'rpc')
  assert.equal(rpcCall.functionName, 'economy_deposit')
  assert.equal(rpcCall.args.p_amount, 1000)
  assert.match(rpcCall.args.p_scope_key, /^[0-9a-f]{64}$/)
  assert.match(rpcCall.args.p_subject_key, /^[0-9a-f]{64}$/)
  assert.equal(fixture.calls.filter((call) => call.operation === 'cacheDelete').length, 1)
})

test('Economy maps authoritative mutation rejection to a safe user error', async () => {
  const fixture = createFixture({ rpcError: { code: 'P0001', message: 'available Wallet balance is insufficient' } })
  await assert.rejects(
    () => fixture.service.deposit(
      GROUP_JID,
      SUBJECT_JID,
      1000,
      SUBJECT_JID,
      createEconomyOperationKey('bank-deposit', 'message-deposit-2'),
    ),
    (error) => error instanceof EconomyOperationError && error.message === 'Operasi ditolak karena saldo atau kapasitas tidak mencukupi.',
  )
})

test('Economy operation keys are bounded and do not contain source identifiers', () => {
  const key = createEconomyOperationKey('bank transfer', 'a potentially sensitive message identifier')
  assert.match(key, /^[a-z0-9-]{8,56}$/)
  assert.equal(key.includes('potentially'), false)
})

test('Economy registers operational bank commands and handles a deposit command', async () => {
  const fixture = createFixture({ rpcData: { status: 'applied', amount: 1000 } })
  const commands = []
  economyPlugin.load({
    logger: loggerFor(),
    config: {},
    events: {},
    commands: {
      register(command) {
        commands.push(command)
        return () => undefined
      },
    },
    services: servicesFor(fixture.service),
  })

  assert.deepEqual(commands.map((command) => command.name), ['vela', 'bank', 'bankpolicy', 'bankreward', 'banksweep', 'tax', 'taxbayar'])
  assert.equal(commands.find((command) => command.name === 'bankpolicy').permission, 'group.admin.or.bot.owner')

  const replies = []
  await commands.find((command) => command.name === 'bank').handler({
    message: { id: 'deposit-message', remoteJid: GROUP_JID, senderJid: SUBJECT_JID },
    args: ['setor', '1000'],
    commandName: 'bank',
    prefix: '!',
    config: {},
    logger: loggerFor(),
    services: servicesFor(fixture.service),
    whatsapp: { userJid: SUBJECT_JID },
    reply: async (text) => replies.push(text),
  })

  assert.equal(replies.length, 1)
  assert.match(replies[0], /Setoran berhasil/)
  assert.equal(fixture.calls.find((call) => call.operation === 'rpc').functionName, 'economy_deposit')
})

test('Economy admin bank help includes the bankreward format and example', async () => {
  const fixture = createFixture()
  const commands = []
  economyPlugin.load({
    logger: loggerFor(),
    config: {},
    events: {},
    commands: {
      register(command) {
        commands.push(command)
        return () => undefined
      },
    },
    services: servicesFor(fixture.service),
  })

  const replies = []
  await commands.find((command) => command.name === 'bankpolicy').handler({
    message: { id: 'bank-help-message', remoteJid: GROUP_JID, senderJid: SUBJECT_JID },
    args: ['invalid'],
    commandName: 'bankpolicy',
    prefix: '!',
    config: {},
    logger: loggerFor(),
    services: servicesFor(fixture.service),
    whatsapp: { userJid: SUBJECT_JID },
    reply: async (text) => replies.push(text),
  })

  assert.equal(replies.length, 1)
  assert.match(replies[0], /Format: !bankreward @orang <jumlah>\nContoh: !bankreward @orang 1000/)
})

test('Economy bankreward accepts a real mention with pipe-separated display text', async () => {
  const fixture = createFixture({ rpcData: { status: 'applied', amount: 99999 } })
  const commands = []
  economyPlugin.load({
    logger: loggerFor(),
    config: {},
    events: {},
    commands: {
      register(command) {
        commands.push(command)
        return () => undefined
      },
    },
    services: servicesFor(fixture.service),
  })

  const replies = []
  await commands.find((command) => command.name === 'bankreward').handler({
    message: {
      id: 'reward-message',
      remoteJid: GROUP_JID,
      senderJid: SUBJECT_JID,
      mentionedJids: ['reward-target@s.whatsapp.net'],
    },
    args: ['@Ran', '|', 'Arthalon', '99999'],
    commandName: 'bankreward',
    prefix: '!',
    config: {},
    logger: loggerFor(),
    services: servicesFor(fixture.service),
    whatsapp: { userJid: SUBJECT_JID },
    reply: async (text) => replies.push(text),
  })

  assert.equal(replies.length, 1)
  assert.match(replies[0], /Reward berhasil diberikan/)
  const rpcCall = fixture.calls.find((call) => call.operation === 'rpc')
  assert.equal(rpcCall.functionName, 'economy_grant_reward')
  assert.equal(rpcCall.args.p_amount, 99999)
  assert.match(rpcCall.args.p_subject_key, /^[0-9a-f]{64}$/)
})

test('Economy bankreward does not guess a target from display text', async () => {
  const fixture = createFixture({ rpcData: { status: 'applied', amount: 99999 } })
  const commands = []
  economyPlugin.load({
    logger: loggerFor(),
    config: {},
    events: {},
    commands: {
      register(command) {
        commands.push(command)
        return () => undefined
      },
    },
    services: servicesFor(fixture.service),
  })

  const replies = []
  await commands.find((command) => command.name === 'bankreward').handler({
    message: { id: 'reward-without-mention', remoteJid: GROUP_JID, senderJid: SUBJECT_JID },
    args: ['@Ran', '|', 'Arthalon', '99999'],
    commandName: 'bankreward',
    prefix: '!',
    config: {},
    logger: loggerFor(),
    services: servicesFor(fixture.service),
    whatsapp: { userJid: SUBJECT_JID },
    reply: async (text) => replies.push(text),
  })

  assert.equal(replies.length, 1)
  assert.match(replies[0], /Tag anggota dari daftar mention WhatsApp atau balas pesannya/)
  assert.equal(fixture.calls.some((call) => call.operation === 'rpc'), false)
})
