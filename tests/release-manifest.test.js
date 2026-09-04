import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const root = new URL('..', import.meta.url).pathname

test('release manifest allows platform verifier and core files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-release-manifest-'))
  try {
    mkdirSync(join(directory, 'scripts'), { recursive: true })
    writeFileSync(join(directory, 'package.json'), '{"version":"0.1.0"}\n')
    writeFileSync(join(directory, 'package-lock.json'), '{}\n')
    writeFileSync(join(directory, 'bash-exec-list.txt'), 'node dist/index.js\n')
    writeFileSync(join(directory, 'scripts', 'verify-platform.mjs'), 'export {}\n')

    const output = execFileSync(process.execPath, ['scripts/create-release-manifest.mjs', directory, 'release-manifest.json'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(output, '')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
