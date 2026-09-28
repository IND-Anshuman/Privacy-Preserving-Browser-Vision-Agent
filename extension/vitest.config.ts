import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * The `@/` alias is configured by WXT at build time, but vitest does not load
 * WXT's config — so any test that imported from `entrypoints/` (which uses
 * `@/lib/...`) failed to resolve, silently excluding the offscreen compositor
 * and the fail-closed gate from the suite entirely. Those are the two modules
 * the privacy claim depends on most, so they were the worst thing to leave
 * untested.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
