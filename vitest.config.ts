import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Coverage globs are matched anywhere in a file's absolute path, so a
// root-relative glob like `.claude/worktrees/**` also matches a parent
// directory of this checkout (e.g. when the checkout is itself a worktree) and
// silently excludes every file. Anchor coverage globs to this config's
// directory, escaping glob syntax in the path.
const fromRoot = (glob: string): string =>
  join(import.meta.dirname.replace(/[\\()[\]{}*?!+@]/g, '\\$&'), glob)

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
      reporter: ['text', 'html', 'json-summary'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/tests/**',
        '*-workspace/**',
        '.claude/worktrees/**',
      ].map(fromRoot),
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
    },
  },
})
