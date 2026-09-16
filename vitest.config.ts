import { defineConfig } from 'vitest/config'

export default defineConfig({
  ssr: {
    noExternal: ['zod'],
  },
  test: {
    // `.claude/worktrees/**` holds git worktrees: checkouts of this same repo
    // at other commits. Collecting their tests double-runs the suite and fails
    // whenever a worktree is on a different commit than the packages it
    // resolves from the root `node_modules`.
    exclude: ['*-workspace/**', '**/node_modules/**', '.claude/worktrees/**'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/tests/**',
        '*-workspace/**',
        '.claude/worktrees/**',
      ],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
