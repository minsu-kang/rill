import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        extends: false,
        test: {
          name: 'packages',
          include: ['packages/*/test/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      'apps/desktop',
    ],
  },
})
