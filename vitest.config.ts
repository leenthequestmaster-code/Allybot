import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    alias: {
      'node:test': 'vitest',
    },
    include: ['tests/**/*.test.{js,ts}'],
    testTimeout: 15000,
  },
})
