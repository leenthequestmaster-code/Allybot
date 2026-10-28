import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    alias: {
      'node:test': resolve(rootDir, 'vitest-node-test-shim.ts'),
    },
    include: ['tests/**/*.test.{js,ts}'],
    testTimeout: 15000,
  },
})
