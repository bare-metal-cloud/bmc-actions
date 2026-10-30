import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The chunk-size tests allocate real buffers; keep the pool sane.
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
