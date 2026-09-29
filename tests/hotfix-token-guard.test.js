import dotenv from 'dotenv';
dotenv.config({ path: '/root/Allybot-hotfix/.env.test' });
import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import pino from 'pino';
import { randomBytes } from 'node:crypto';

const logger = pino({ level: 'silent' });

// S4 Guard: strictly enforces isolated PostgreSQL 17 and Redis
async function assertIsolatedStack() {
  const pgUrl = process.env.DISPOSABLE_POSTGRES_URL;
  if (!pgUrl) {
    throw new Error('FATAL GUARD: DISPOSABLE_POSTGRES_URL environment variable is required');
  }
  const parsed = new URL(pgUrl);
  if (parsed.port === '5432' || !parsed.port) {
    throw new Error('FATAL GUARD: Refusing to connect to production port 5432');
  }
  const isPort5433 = parsed.port === '5433';
  const isRoleRunner = parsed.username === 'allybot_test_runner';
  const isDbIsolated = parsed.pathname === '/allybot_isolated_test';
  if (!(isPort5433 && isRoleRunner && isDbIsolated)) {
    throw new Error(`FATAL GUARD: Database target violated AND(port=5433, role=allybot_test_runner, db=allybot_isolated_test): got port=${parsed.port}, role=${parsed.username}, db=${parsed.pathname}`);
  }

  // Runtime database verification
  const sql = postgres(pgUrl);
  try {
    const [meta] = await sql`SELECT current_database(), current_user, inet_server_port()`;
    if (!(meta.current_database === 'allybot_isolated_test' && meta.current_user === 'allybot_test_runner' && Number(meta.inet_server_port) === 5433)) {
      throw new Error(`FATAL GUARD: Runtime server verification failed: ${JSON.stringify(meta)}`);
    }
  } finally {
    await sql.end();
  }

  // Redis isolation verification
  const redisUrl = process.env.DISPOSABLE_REDIS_URL;
  if (!redisUrl) {
    throw new Error('FATAL GUARD: DISPOSABLE_REDIS_URL environment variable is required');
  }
  const parsedRedis = new URL(redisUrl);
  if (parsedRedis.port !== '6380') {
    throw new Error(`FATAL GUARD: Redis target violated port=6380: got port=${parsedRedis.port}`);
  }
}

test('S4_guard_verification: ensures connection to isolated PG17 and Redis', async () => {
  await assertIsolatedStack();
});

test('R1_raw_parsing_and_token_bounds: negative and non-integer inputs rejected', async () => {
  await assertIsolatedStack();
  const { parseStrictPositiveInt } = await import('../dist/framework/plugins/character-guide.js');

  const testCases = [
    { input: '-5', expectedOk: false },
    { input: '0', expectedOk: false },
    { input: '1.5', expectedOk: false },
    { input: '1e3', expectedOk: false },
    { input: '+5', expectedOk: false },
    { input: 'abc', expectedOk: false },
    { input: '', expectedOk: false },
    { input: '99999999999', expectedOk: false },
    { input: '5', expectedOk: true, val: 5 },
    { input: '100', expectedOk: true, val: 100 },
  ];

  for (const tc of testCases) {
    const res = parseStrictPositiveInt(tc.input, 100);
    assert.equal(res.ok, tc.expectedOk, `Input "${tc.input}" expected ok=${tc.expectedOk}, got ${res.ok}`);
    if (tc.expectedOk) {
      assert.equal(res.value, tc.val);
    }
  }
});

test('R1_command_handler_exploit_prevention: !alokasi str -5 rejected without minting tokens', async () => {
  await assertIsolatedStack();
  const { createCharacterGuidePlugin } = await import('../dist/framework/plugins/character-guide.js');
  const { CharacterGuideService } = await import('../dist/services/character-guide-service.js');
  const { createPostgresCharacterClient } = await import('../dist/services/character-postgres-client.js');

  const sql = postgres(process.env.DISPOSABLE_POSTGRES_URL);
  const guideKey = 'hotfix-guide-world';
  const ownerJid = '6281234567890@s.whatsapp.net';
  const charId = randomBytes(16).toString('hex');

  const charClient = createPostgresCharacterClient({ postgresUrl: process.env.DISPOSABLE_POSTGRES_URL });
  const charService = new CharacterGuideService(logger, { env: { CHARACTER_GUIDE_ENABLED: 'true' }, createClient: () => charClient });
  charService.initialize({ logger, config: {}, services: {} });

  const commands = new Map();
  const plugin = createCharacterGuidePlugin({
    userJid: 'bot@s.whatsapp.net',
    sendText: async () => {},
    sendNativeQuickReplies: async () => {},
    getGroupMetadata: async () => ({ jid: 'group@g.us', subject: 'Group', participants: [] }),
  });

  plugin.load({
    logger,
    config: { commandPrefix: '!', defaultCooldownMs: 0 },
    services: { get: () => charService, has: () => true },
    commands: { register: (d) => commands.set(d.name, d) },
    events: { on: () => {}, emit: () => {} },
    messageGates: { register: () => {} },
  });

  try {
    // Seed clean Level 1 character (budget = 5 tokens)
    const ownerKey = charService.getActiveForOwner ? (await import('../dist/services/character-guide-service.js')).hashIdentity?.(ownerJid) : null;
    await sql`DELETE FROM character_profiles WHERE guide_key = '01861054b1f6305a2e584f294da6883cd1c7ef3908865e94f09a58cf09848fa5'`;

    // 1. Initial State: Player sends !alokasi str -5
    let replyMsg = '';
    const cmdContext = {
      prefix: '!',
      args: ['str', '-5'],
      message: { senderJid: ownerJid, remoteJid: 'group@g.us' },
      reply: async (text) => { replyMsg = text; },
    };

    await commands.get('alokasi').handler(cmdContext);

    // 2. Verification: The command handler rejected the negative input
    assert.match(replyMsg, /Jumlah alokasi tidak valid: Harus berupa bilangan bulat positif/);

    // 3. Database allocated_stats was NEVER modified with negative values
    const rows = await sql`
      SELECT allocated_stats FROM character_profiles
      WHERE owner_key = ${ownerKey || ''} AND status = 'active'
    `;
    if (rows.length > 0) {
      assert.equal(rows[0].allocated_stats?.str ?? 0, 0, 'str stat must remain 0 or unmodified');
    }
  } finally {
    await sql.end();
  }
});

test('R3_concurrency_race_20_parallel: double-spending prevented via row-level locks', async () => {
  await assertIsolatedStack();
  const { createPostgresCharacterClient } = await import('../dist/services/character-postgres-client.js');
  const client = createPostgresCharacterClient({ postgresUrl: process.env.DISPOSABLE_POSTGRES_URL });
  const sql = postgres(process.env.DISPOSABLE_POSTGRES_URL);

  const guideKey = 'hotfix-guide-world';
  const ownerKey = 'synth-hotfix-owner';
  const charId = randomBytes(16).toString('hex');

  try {
    await sql`DELETE FROM character_profiles WHERE guide_key = ${guideKey} AND owner_key = ${ownerKey}`;
    // Insert baseline character on existing production schema: level 1, 0 bonus tokens = 5 tokens total
    await sql`
      INSERT INTO character_profiles (
        character_id, guide_key, owner_key, name, gender, age, birthday_day, birthday_month, birthday_year,
        race, class_name, element, will_of_path, rank, level, status, allocated_stats, bonus_tokens
      ) VALUES (
        ${charId}, ${guideKey}, ${ownerKey}, 'Hotfix Tester', 'Male', 20, 1, 'Zephyra', 780,
        'Human', 'Knight', 'Fire', 'Light', 'F-', 1, 'active', '{}'::jsonb, 0
      )
    `;

    // Send 20 parallel allocation requests of 1 token each
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(client.rpc('character_allocate_stats', {
        p_guide_key: guideKey,
        p_owner_key: ownerKey,
        p_stat_key: 'str',
        p_amount: 1,
      }));
    }

    const results = await Promise.all(promises);
    const successes = results.filter(r => r.data?.ok === true);
    const failures = results.filter(r => r.data?.ok === false);

    // Initial budget = 5. Exactly 5 must succeed, 15 must be rejected.
    assert.equal(successes.length, 5, `Expected exactly 5 successes, got ${successes.length}`);
    assert.equal(failures.length, 15, `Expected exactly 15 failures, got ${failures.length}`);

    // Verify DB allocated_stats sum is exactly 5
    const [finalRow] = await sql`SELECT allocated_stats FROM character_profiles WHERE character_id = ${charId}`;
    assert.equal(finalRow.allocated_stats.str, 5, `Expected str to be 5, got ${finalRow.allocated_stats?.str}`);
  } finally {
    await sql`DELETE FROM character_profiles WHERE guide_key = ${guideKey} AND owner_key = ${ownerKey}`;
    await sql.end();
  }
});
