import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const repository = process.cwd()
const generator = join(repository, 'scripts/generate-codebase-export.mjs')

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'allybot-codebase-generator-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'src', 'index.ts'), [
    "import { greet } from './greet.js'",
    'export function main(): string { return greet("Allybot") }',
  ].join('\n'))
  await writeFile(join(root, 'src', 'greet.ts'), 'export function greet(name: string): string { return `Hello ${name}` }\n')
  await writeFile(join(root, 'src', 'config.ts'), [
    'const envSchema = {',
    "  FEATURE_ENABLED: booleanFromEnv.default(false),",
    "  CODEBASE_EXPORT_ENABLED: booleanFromEnv.default(false),",
    '}',
  ].join('\n'))
  await writeFile(join(root, 'tests', 'sample.test.js'), "test('sample behavior', () => {})\n")
  await writeFile(join(root, 'docs', 'architecture.md'), '# Architecture\n')
  await writeFile(join(root, '.env'), 'SECRET_VALUE=must-not-enter-export\n')
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { zod: '4.0.17' }, devDependencies: { typescript: '5.9.2' } }, null, 2))
  await writeFile(join(root, 'package-lock.json'), '{}\n')
  await writeFile(join(root, 'tsconfig.json'), '{}\n')
  return root
}

async function runGenerator(root) {
  execFileSync(process.execPath, [generator, '--output', 'Codebase'], {
    cwd: repository,
    env: { ...process.env, CODEBASE_REPOSITORY_ROOT: root },
    stdio: 'pipe',
  })
}

test('Codebase generator produces index-first tables and excludes environment files', async () => {
  const root = await createFixture()
  try {
    await runGenerator(root)
    const output = join(root, 'Codebase')
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    const filesTable = await readFile(join(output, 'tables', 'files.csv'), 'utf8')
    const commandsTable = await readFile(join(output, 'tables', 'commands.csv'), 'utf8')

    assert.equal(manifest.commitSha, 'unknown')
    assert.ok(manifest.counts.files >= 8)
    assert.ok(manifest.counts.symbols >= 1)
    assert.ok(manifest.counts.imports >= 1)
    assert.ok(manifest.counts.tests >= 1)
    assert.equal(filesTable.includes('.env'), false)
    assert.equal(filesTable.includes('Codebase/'), false)
    assert.match(commandsTable, /name,aliases,description,category,permission,cooldown_ms/)
    assert.ok(manifest.files.every((entry) => !entry.path.startsWith('Codebase/')))
    assert.ok((await readFile(join(output, 'SHA256SUMS.txt'), 'utf8')).includes('tables/files.csv'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codebase generator is reproducible for the same source tree', async () => {
  const root = await createFixture()
  try {
    await runGenerator(root)
    const first = await readFile(join(root, 'Codebase', 'tables', 'calls.csv'), 'utf8')
    const firstManifest = await readFile(join(root, 'Codebase', 'manifest.json'), 'utf8')
    await runGenerator(root)
    const second = await readFile(join(root, 'Codebase', 'tables', 'calls.csv'), 'utf8')
    const secondManifest = await readFile(join(root, 'Codebase', 'manifest.json'), 'utf8')

    assert.equal(second, first)
    assert.equal(secondManifest, firstManifest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
