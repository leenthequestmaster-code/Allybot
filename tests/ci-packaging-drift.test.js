import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * CI drift guard: the sanitized-deployment packaging step in
 * .github/workflows/ci.yml hand-maintains a list of runtime packages that it
 * `cp -a`s from node_modules into the release archive. That list must stay a
 * subset of package-lock.json — if a package is removed from the lockfile but
 * not from ci.yml, `cp -a` fails and the pipeline breaks on every push to main
 * (this exact class of failure happened with iceberg-js/uncrypto and mongodb
 * before 2e05226). This test fails at the moment of drift instead.
 */

const root = new URL('..', import.meta.url).pathname
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))

// Every package referenced by the packaging steps: both the mkdir pre-creates
// (.ci-artifact/node_modules/<pkg>) and the copies (cp -a node_modules/<pkg>/.).
const referenced = new Set()
for (const match of ci.matchAll(/\.ci-artifact\/node_modules\/(@?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)/g)) {
  referenced.add(match[1])
}
for (const match of ci.matchAll(/cp -a node_modules\/([A-Za-z0-9@/_.-]+?)\/\./g)) {
  referenced.add(match[1])
}

test('ci.yml packaging list references at least the known runtime sentinels', () => {
  // Guards against the extraction regex silently breaking on a ci.yml edit.
  for (const sentinel of ['dotenv', 'buffer', 'ws', '@sentry', '@opentelemetry']) {
    assert.ok(referenced.has(sentinel), `extraction failed: expected ${sentinel} in ci.yml packaging list`)
  }
  assert.ok(referenced.size >= 20, `expected the full curated list, got ${referenced.size} entries`)
})

test('every package copied by ci.yml packaging exists in package-lock.json', () => {
  const missing = []
  for (const pkg of referenced) {
    if (pkg.startsWith('@')) {
      // Scoped parent directories (e.g. @sentry): the copy brings every child,
      // so the package is drift-safe if the lock carries at least one child.
      const prefix = `node_modules/${pkg}/`
      const hasChild = Object.keys(lock.packages).some((key) => key.startsWith(prefix))
      // @types/estree is a direct child, not a scope parent — handle both.
      const exact = `node_modules/${pkg}` in lock.packages
      if (!hasChild && !exact) missing.push(pkg)
    } else {
      if (!((`node_modules/${pkg}`) in lock.packages)) missing.push(pkg)
    }
  }
  assert.deepEqual(missing, [], `ci.yml copies packages that are not in package-lock.json (remove them from the ci.yml packaging lists): ${missing.join(', ')}`)
})

test('every package copied by ci.yml packaging exists on the local filesystem', () => {
  const missing = []
  for (const pkg of referenced) {
    if (!existsSync(join(root, 'node_modules', ...pkg.split('/')))) missing.push(pkg)
  }
  assert.deepEqual(missing, [], `ci.yml copies packages missing from node_modules (run npm ci): ${missing.join(', ')}`)
})

test('manifest allowlist and ci.yml curated zip-check stay aligned', () => {
  const manifestScript = readFileSync(join(root, 'scripts/create-release-manifest.mjs'), 'utf8')
  // Extract the curated package list from the ci.yml zip-check grep -Ev pattern:
  //   grep -Ev '^(node_modules/?$|node_modules/(pkg1|pkg2|...)(/|$))'
  const anchor = ci.indexOf("grep -Ev '^(node_modules/?$|node_modules/(")
  assert.ok(anchor !== -1, 'ci.yml zip-check curated list not found — update this test if the check moved')
  const open = ci.indexOf('(', anchor + "grep -Ev '^(node_modules/?$|node_modules/(".length - 1)
  const close = ci.indexOf(')', open + 1)
  const zipList = new Set(ci.slice(open + 1, close).split('|'))
  for (const pkg of zipList) {
    if (pkg === 'node_modules/?$') continue
    const manifestHasIt = manifestScript.includes(`node_modules/${pkg}/`)
    assert.ok(manifestHasIt, `ci.yml zip-check allows '${pkg}' but create-release-manifest.mjs does not allowlist it — sync both`)
  }
})
