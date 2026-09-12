import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const root = new URL('..', import.meta.url).pathname

function runGenerator(directory) {
  const output = execFileSync(
    process.execPath,
    ['scripts/create-release-manifest.mjs', directory, 'release-manifest.json'],
    {
      cwd: root,
      encoding: 'utf8',
      // Hermetic: CI runners export GITHUB_SHA, which would change the
      // manifest's commitSha/artifactId. Strip those vars so assertions
      // are deterministic in every environment.
      env: (() => {
        const hermetic = { ...process.env }
        delete hermetic.GITHUB_SHA
        delete hermetic.RELEASE_COMMIT_SHA
        return hermetic
      })(),
    },
  )
  assert.equal(output, '', 'generator must stay silent on stdout')
  return JSON.parse(readFileSync(join(directory, 'release-manifest.json'), 'utf8'))
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Runs the real release manifest generator against a prepared artifact
// directory. The caller asserts against the returned state and the test
// context cleans the directory up afterwards.
function withArtifactDirectory(context, prepare = (directory) => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-release-manifest-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  prepareArtifactFiles(directory)
  prepare(directory)
  return directory
}

function prepareArtifactFiles(directory) {
  mkdirSync(join(directory, 'scripts'), { recursive: true })
  mkdirSync(join(directory, 'dist'), { recursive: true })
  mkdirSync(join(directory, 'node_modules', 'dotenv'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), '{"version":"0.1.0"}\n')
  writeFileSync(join(directory, 'package-lock.json'), '{"lock":true}\n')
  writeFileSync(join(directory, 'scripts', 'verify-platform.mjs'), 'export {}\n')
  writeFileSync(join(directory, 'dist', 'index.js'), 'console.log("allybot")\n')
  writeFileSync(join(directory, 'dist', 'utils.js'), 'export {}\n')
  writeFileSync(join(directory, 'node_modules', 'dotenv', 'main.js'), 'export {}\n')
}

test('release manifest hashes and lists every allowlisted artifact deterministically', (context) => {
  const directory = withArtifactDirectory(context)
  const manifest = runGenerator(directory)

  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.packageVersion, '0.1.0')
  assert.equal(manifest.nodeVersion, process.version)
  assert.equal(manifest.commitSha, 'local')
  assert.equal(manifest.artifactId, 'allybot-release-local')

  // packageLockSha256 must be the real digest of package-lock.json.
  assert.equal(manifest.packageLockSha256, sha256(join(directory, 'package-lock.json')))

  // Every artifact entry carries path, byte size, and a full-length sha256 hex
  // digest that matches the file on disk.
  const paths = manifest.files.map((entry) => entry.path)
  assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right)), 'entries must be sorted by path')
  assert.deepEqual(paths, [
    'dist/index.js',
    'dist/utils.js',
    'node_modules/dotenv/main.js',
    'package-lock.json',
    'package.json',
    'scripts/verify-platform.mjs',
  ])
  for (const entry of manifest.files) {
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${entry.path} sha256 must be a full hex digest`)
    assert.equal(entry.sha256, sha256(join(directory, entry.path)))
    assert.equal(entry.bytes, statSync(join(directory, entry.path)).size)
  }

  // The allowlist documents exactly which artifact paths a release may carry.
  assert.equal(manifest.allowlist.includes('dist/**'), true)
  assert.equal(manifest.allowlist.includes('package.json'), true)
  assert.equal(manifest.allowlist.includes('package-lock.json'), true)
  assert.equal(manifest.allowlist.includes('scripts/verify-platform.mjs'), true)
  assert.equal(manifest.allowlist.includes('node_modules/dotenv/**'), true)
})

test('release manifest rejects artifacts outside the allowlist and forbidden payloads', (context) => {
  const outOfAllowlist = withArtifactDirectory(context, (directory) => {
    writeFileSync(join(directory, 'README.md'), 'not allowlisted\n')
  })
  assert.throws(
    () => runGenerator(outOfAllowlist),
    /Artifact path is not allowlisted: README\.md/,
  )

  const forbiddenCredential = withArtifactDirectory(context, (directory) => {
    writeFileSync(join(directory, 'creds.json'), '{}\n')
  })
  assert.throws(
    () => runGenerator(forbiddenCredential),
    /Artifact path is not allowlisted: creds\.json/,
  )

  const sessionDatabase = withArtifactDirectory(context, (directory) => {
    mkdirSync(join(directory, 'data'), { recursive: true })
    writeFileSync(join(directory, 'data', 'session.sqlite'), 'x')
  })
  assert.throws(
    () => runGenerator(sessionDatabase),
    /Artifact path is not allowlisted: data\/session\.sqlite/,
  )
})

test('release manifest writes only once and refuses to overwrite an existing manifest', (context) => {
  const directory = withArtifactDirectory(context)
  runGenerator(directory)
  const first = readFileSync(join(directory, 'release-manifest.json'), 'utf8')
  assert.throws(
    () => runGenerator(directory),
    (error) => error.status !== 0,
    'second run must fail because the manifest file is created exclusively',
  )
  assert.equal(readFileSync(join(directory, 'release-manifest.json'), 'utf8'), first, 'failed rerun must not mutate the manifest')
})
