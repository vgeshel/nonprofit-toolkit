/**
 * Tests for lint exception detection
 *
 * This module detects ESLint and TypeScript exception comments in staged changes
 * that bypass linting guardrails.
 */

import { execSync } from 'node:child_process'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import {
  type FileSystemOps,
  type LintViolation,
  checkFileContent,
  detectLintExceptions,
  formatViolationReport,
  main,
  parseArgs,
  walkTree,
} from './check-lint-exceptions'

// Mock node:child_process for main() tests
vi.mock('node:child_process', () => ({
  execSync: vi.fn<(command: string, options?: object) => string>(),
}))

// Mock node:fs for tree mode tests without testFs
vi.mock('node:fs', () => ({
  readdirSync: vi.fn(() => ['clean.ts']),
  statSync: vi.fn(() => ({
    isDirectory: () => false,
    isFile: () => true,
  })),
  readFileSync: vi.fn(() => 'const x = 1;'),
}))

// Handle unhandled rejections from process.exit mocks in entrypoint tests
// These occur because the async module code continues after our test completes
beforeAll(() => {
  process.on('unhandledRejection', (reason: unknown) => {
    // Suppress errors from our process.exit mock
    if (reason instanceof Error && reason.message === 'process.exit mock') {
      return
    }
    // Re-throw other errors
    throw reason
  })
})

const mockExecSync = vi.mocked(execSync)

describe('parseArgs', () => {
  it('returns tree: false when no arguments provided', () => {
    const result = parseArgs([])
    expect(result).toEqual({ tree: false })
  })

  it('returns tree: true when --tree flag is provided', () => {
    const result = parseArgs(['--tree'])
    expect(result).toEqual({ tree: true })
  })

  it('throws on unknown options', () => {
    expect(() => parseArgs(['--unknown'])).toThrow()
  })
})

describe('detectLintExceptions', () => {
  describe('ESLint exceptions', () => {
    it('detects eslint-disable comment', () => {
      const diff = `diff --git a/file.ts b/file.ts
+// eslint-disable
+const x = 1;`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'eslint',
        pattern: 'eslint-disable',
        line: '// eslint-disable',
        lineNumber: 2,
      })
    })

    it('detects eslint-disable-next-line comment', () => {
      const diff = `diff --git a/file.ts b/file.ts
+// eslint-disable-next-line no-console
+console.log('test');`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(1)
      expect(result[0]?.pattern).toBe('eslint-disable-next-line')
    })

    it('detects eslint-disable-line comment', () => {
      const diff = `diff --git a/file.ts b/file.ts
+const x = 1; // eslint-disable-line`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(1)
      expect(result[0]?.pattern).toBe('eslint-disable-line')
    })

    it('detects block eslint-disable comment', () => {
      const diff = `diff --git a/file.ts b/file.ts
+/* eslint-disable */
+const x = 1;`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(1)
      expect(result[0]?.pattern).toBe('eslint-disable')
    })
  })

  describe('TypeScript exceptions', () => {
    it('detects @ts-ignore comment', () => {
      const diff = `diff --git a/file.ts b/file.ts
+// @ts-ignore
+const x: number = 'string';`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        type: 'typescript',
        pattern: '@ts-ignore',
        line: '// @ts-ignore',
        lineNumber: 2,
      })
    })

    it('detects @ts-nocheck comment', () => {
      const diff = `diff --git a/file.ts b/file.ts
+// @ts-nocheck
+const x = 1;`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(1)
      expect(result[0]?.pattern).toBe('@ts-nocheck')
    })

    it('detects @ts-expect-error comment', () => {
      const diff = `diff --git a/file.ts b/file.ts
+// @ts-expect-error
+const x: number = 'string';`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(1)
      expect(result[0]?.pattern).toBe('@ts-expect-error')
    })
  })

  describe('edge cases', () => {
    it('returns empty array for empty diff', () => {
      const result = detectLintExceptions('')

      expect(result).toEqual([])
    })

    it('returns empty array when no violations found', () => {
      const diff = `diff --git a/file.ts b/file.ts
+const x = 1;
+const y = 2;`

      const result = detectLintExceptions(diff)

      expect(result).toEqual([])
    })

    it('ignores removed lines (starting with -)', () => {
      const diff = `diff --git a/file.ts b/file.ts
-// eslint-disable
-// @ts-ignore
+const x = 1;`

      const result = detectLintExceptions(diff)

      expect(result).toEqual([])
    })

    it('ignores context lines (not starting with + or -)', () => {
      const diff = `diff --git a/file.ts b/file.ts
 // eslint-disable
 // @ts-ignore
+const x = 1;`

      const result = detectLintExceptions(diff)

      expect(result).toEqual([])
    })

    it('detects multiple violations in same diff', () => {
      const diff = `diff --git a/file.ts b/file.ts
+// eslint-disable-next-line
+const x = 1;
+// @ts-ignore
+const y: number = 'string';`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(2)
      expect(result[0]?.pattern).toBe('eslint-disable-next-line')
      expect(result[1]?.pattern).toBe('@ts-ignore')
    })

    it('detects violations across multiple files', () => {
      const diff = `diff --git a/file1.ts b/file1.ts
+// eslint-disable
+const x = 1;
diff --git a/file2.ts b/file2.ts
+// @ts-nocheck
+const y = 2;`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(2)
    })

    it('handles inline comments with rule names', () => {
      const diff = `diff --git a/file.ts b/file.ts
+// eslint-disable-next-line @typescript-eslint/no-explicit-any
+const x: any = {};`

      const result = detectLintExceptions(diff)

      expect(result).toHaveLength(1)
      expect(result[0]?.pattern).toBe('eslint-disable-next-line')
    })

    it('does not flag regular comments mentioning eslint', () => {
      const diff = `diff --git a/file.ts b/file.ts
+// This code follows eslint rules
+// We removed the eslint disable that was here`

      const result = detectLintExceptions(diff)

      expect(result).toEqual([])
    })

    it('excludes test files from violation detection', () => {
      // Test files are excluded because mocking external SDK types
      // legitimately requires type assertions
      const diff = `diff --git a/src/foo.test.ts b/src/foo.test.ts
+// eslint-disable
+// @ts-ignore
+const x = 1;`

      const result = detectLintExceptions(diff)

      // Test files should be excluded - no violations detected
      expect(result).toEqual([])
    })

    it('handles malformed diff --git line without matching pattern', () => {
      // This covers the else branch of match ? match[1] : '' at line 75
      const diff = `diff --git malformed line without proper format
+// eslint-disable
+const x = 1;`

      const result = detectLintExceptions(diff)

      // Should still detect violations, with empty currentFile
      expect(result).toHaveLength(1)
      expect(result[0]?.pattern).toBe('eslint-disable')
    })

    it('ignores the check-lint-exceptions.ts file itself', () => {
      const diff = `diff --git a/scripts/check-lint-exceptions.ts b/scripts/check-lint-exceptions.ts
+const ESLINT_PATTERNS = [
+  'eslint-disable-next-line',
+  'eslint-disable-line',
+  'eslint-disable',
+]
+const TS_PATTERNS = ['@ts-ignore', '@ts-nocheck']`

      const result = detectLintExceptions(diff)

      expect(result).toEqual([])
    })
  })
})

describe('formatViolationReport', () => {
  it('returns empty string for no violations', () => {
    const result = formatViolationReport([])

    expect(result).toBe('')
  })

  it('formats single ESLint violation', () => {
    const violations: LintViolation[] = [
      {
        type: 'eslint',
        pattern: 'eslint-disable',
        line: '// eslint-disable',
        lineNumber: 5,
      },
    ]

    const result = formatViolationReport(violations)

    expect(result).toContain('COMMIT BLOCKED')
    expect(result).toContain('ESLint exceptions found')
    expect(result).toContain('// eslint-disable')
  })

  it('formats single TypeScript violation', () => {
    const violations: LintViolation[] = [
      {
        type: 'typescript',
        pattern: '@ts-ignore',
        line: '// @ts-ignore',
        lineNumber: 10,
      },
    ]

    const result = formatViolationReport(violations)

    expect(result).toContain('COMMIT BLOCKED')
    expect(result).toContain('TypeScript exceptions found')
    expect(result).toContain('// @ts-ignore')
  })

  it('formats mixed violations', () => {
    const violations: LintViolation[] = [
      {
        type: 'eslint',
        pattern: 'eslint-disable',
        line: '// eslint-disable',
        lineNumber: 5,
      },
      {
        type: 'typescript',
        pattern: '@ts-ignore',
        line: '// @ts-ignore',
        lineNumber: 10,
      },
    ]

    const result = formatViolationReport(violations)

    expect(result).toContain('ESLint exceptions found')
    expect(result).toContain('TypeScript exceptions found')
  })

  it('includes blocked patterns list', () => {
    const violations: LintViolation[] = [
      {
        type: 'eslint',
        pattern: 'eslint-disable',
        line: '// eslint-disable',
        lineNumber: 5,
      },
    ]

    const result = formatViolationReport(violations)

    expect(result).toContain('eslint-disable')
    expect(result).toContain('eslint-disable-next-line')
    expect(result).toContain('eslint-disable-line')
    expect(result).toContain('@ts-ignore')
    expect(result).toContain('@ts-nocheck')
    expect(result).toContain('@ts-expect-error')
  })

  it('includes actionable advice', () => {
    const violations: LintViolation[] = [
      {
        type: 'eslint',
        pattern: 'eslint-disable',
        line: '// eslint-disable',
        lineNumber: 5,
      },
    ]

    const result = formatViolationReport(violations)

    expect(result).toContain('fix the underlying issues')
  })
})

describe('main', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns 0 when no staged changes', async () => {
    mockExecSync.mockReturnValue('')

    const result = await main()

    expect(result).toBe(0)
  })

  it('returns 0 when git command fails', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('No git repository')
    })

    const result = await main()

    expect(result).toBe(0)
  })

  it('returns 0 when no violations found', async () => {
    mockExecSync.mockReturnValue(`diff --git a/file.ts b/file.ts
+const x = 1;`)

    const result = await main()

    expect(result).toBe(0)
  })

  it('returns 1 when violations found', async () => {
    mockExecSync.mockReturnValue(`diff --git a/file.ts b/file.ts
+// eslint-disable
+const x = 1;`)

    const result = await main()

    expect(result).toBe(1)
  })

  it('logs violation report when violations found', async () => {
    const consoleSpy = vi.spyOn(console, 'error')
    mockExecSync.mockReturnValue(`diff --git a/file.ts b/file.ts
+// @ts-ignore
+const x = 1;`)

    await main()

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('COMMIT BLOCKED'),
    )
  })

  describe('--tree mode', () => {
    it('checks all files when --tree flag is passed', async () => {
      const mockFs: FileSystemOps = {
        readdir: (path) => {
          if (path === '.') return ['src', 'index.ts']
          if (path === 'src') return ['file.ts']
          return []
        },
        stat: (path) => ({
          isDirectory: path === 'src',
          isFile: path !== 'src',
        }),
        readFile: (path) => {
          if (path === 'src/file.ts') return '// eslint-disable\nconst x = 1;'
          return 'const x = 1;'
        },
      }

      const result = await main(['--tree'], mockFs)

      expect(result).toBe(1)
    })

    it('returns 0 when no violations in tree', async () => {
      const mockFs: FileSystemOps = {
        readdir: () => ['file.ts'],
        stat: () => ({ isDirectory: false, isFile: true }),
        readFile: () => 'const x = 1;',
      }

      const result = await main(['--tree'], mockFs)

      expect(result).toBe(0)
    })

    it('logs violation report when violations found in tree', async () => {
      const consoleSpy = vi.spyOn(console, 'error')
      const mockFs: FileSystemOps = {
        readdir: () => ['file.ts'],
        stat: () => ({ isDirectory: false, isFile: true }),
        readFile: () => '// @ts-ignore\nconst x = 1;',
      }

      await main(['--tree'], mockFs)

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('COMMIT BLOCKED'),
      )
    })

    it('uses real fs when testFs not provided', async () => {
      // This test exercises the dynamic import path (lines 323-330)
      // The node:fs module is mocked above to return clean files
      const result = await main(['--tree'])

      expect(result).toBe(0)
    })
  })
})

describe('checkFileContent', () => {
  it('returns violations for file with eslint-disable', () => {
    const content = `const x = 1;
// eslint-disable-next-line
const y = 2;`

    const result = checkFileContent(content, 'file.ts')

    expect(result).toHaveLength(1)
    expect(result[0]?.pattern).toBe('eslint-disable-next-line')
    expect(result[0]?.file).toBe('file.ts')
  })

  it('returns violations for file with @ts-ignore', () => {
    const content = `// @ts-ignore
const x: number = 'string';`

    const result = checkFileContent(content, 'file.ts')

    expect(result).toHaveLength(1)
    expect(result[0]?.pattern).toBe('@ts-ignore')
  })

  it('returns empty array for clean file', () => {
    const content = `const x = 1;
const y = 2;`

    const result = checkFileContent(content, 'file.ts')

    expect(result).toEqual([])
  })

  it('returns multiple violations', () => {
    const content = `// eslint-disable
const x = 1;
// @ts-ignore
const y: number = 'string';
// @ts-nocheck`

    const result = checkFileContent(content, 'file.ts')

    expect(result).toHaveLength(3)
  })

  it('excludes check-lint-exceptions.ts file', () => {
    const content = `// eslint-disable
const x = 1;`

    const result = checkFileContent(content, 'scripts/check-lint-exceptions.ts')

    expect(result).toEqual([])
  })

  it('excludes check-lint-exceptions.test.ts file', () => {
    const content = `// eslint-disable
const x = 1;`

    const result = checkFileContent(
      content,
      'scripts/check-lint-exceptions.test.ts',
    )

    expect(result).toEqual([])
  })
})

describe('walkTree', () => {
  it('finds violations in files recursively', () => {
    const mockFs: FileSystemOps = {
      readdir: (path) => {
        if (path === '.') return ['src', 'index.ts']
        if (path === 'src') return ['file.ts']
        return []
      },
      stat: (path) => ({
        isDirectory: path === 'src',
        isFile: path !== 'src',
      }),
      readFile: (path) => {
        if (path === 'src/file.ts') return '// eslint-disable\nconst x = 1;'
        return 'const x = 1;'
      },
    }

    const result = walkTree('.', mockFs)

    expect(result).toHaveLength(1)
    expect(result[0]?.pattern).toBe('eslint-disable')
    expect(result[0]?.file).toBe('src/file.ts')
  })

  it('returns empty when no violations', () => {
    const mockFs: FileSystemOps = {
      readdir: () => ['file.ts'],
      stat: () => ({ isDirectory: false, isFile: true }),
      readFile: () => 'const x = 1;',
    }

    const result = walkTree('.', mockFs)

    expect(result).toEqual([])
  })

  it('skips node_modules directory', () => {
    const mockFs: FileSystemOps = {
      readdir: (path) => {
        if (path === '.') return ['node_modules', 'src']
        if (path === 'src') return ['clean.ts']
        if (path === 'node_modules') return ['bad.ts']
        return []
      },
      stat: (path) => ({
        isDirectory: path === 'node_modules' || path === 'src',
        isFile: path.endsWith('.ts'),
      }),
      readFile: (path) => {
        if (path === 'node_modules/bad.ts')
          return '// eslint-disable\nconst x = 1;'
        return 'const x = 1;'
      },
    }

    const result = walkTree('.', mockFs)

    expect(result).toEqual([])
  })

  it('skips hidden files and directories', () => {
    const mockFs: FileSystemOps = {
      readdir: () => ['.hidden', 'visible.ts'],
      stat: (path) => ({
        isDirectory: path === '.hidden',
        isFile: path.endsWith('.ts'),
      }),
      readFile: () => 'const x = 1;',
    }

    const result = walkTree('.', mockFs)

    expect(result).toEqual([])
  })

  it('only checks files with relevant extensions', () => {
    const mockFs: FileSystemOps = {
      readdir: () => ['file.ts', 'readme.md', 'data.json'],
      stat: () => ({ isDirectory: false, isFile: true }),
      readFile: () => '// eslint-disable\nconst x = 1;',
    }

    const result = walkTree('.', mockFs)

    // Only file.ts should be checked
    expect(result).toHaveLength(1)
    expect(result[0]?.file).toBe('file.ts')
  })

  it('skips entries that are neither directory nor file (e.g., symlinks)', () => {
    // This covers the else branch at line 228 where neither isDirectory nor isFile is true
    const mockFs: FileSystemOps = {
      readdir: () => ['symlink', 'file.ts'],
      stat: (path) => ({
        isDirectory: false,
        // symlink is neither a regular file nor directory
        isFile: path === 'file.ts',
      }),
      readFile: () => 'const x = 1;',
    }

    const result = walkTree('.', mockFs)

    // Should only process file.ts, not the symlink
    expect(result).toEqual([])
  })
})

describe('check-lint-exceptions entrypoint', () => {
  it('runs main when STUDIO_LINT_EXCEPTIONS_RUN_MAIN is true', async () => {
    const originalRunMain = process.env.STUDIO_LINT_EXCEPTIONS_RUN_MAIN
    const originalArgv = process.argv
    const exitCodes: (string | number | null | undefined)[] = []
    // Mock process.exit - store exit code but don't actually exit
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      exitCodes.push(code)
      // Throw to satisfy the never return type
      throw new Error('process.exit mock')
    })

    try {
      process.env.STUDIO_LINT_EXCEPTIONS_RUN_MAIN = 'true'
      process.argv = ['bun', 'check-lint-exceptions']
      mockExecSync.mockReturnValue('')
      vi.resetModules()
      await import('./check-lint-exceptions')
      // Keep process.exit mocked until async main() reaches it
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalled()
      })
    } finally {
      exitSpy.mockRestore()
      if (originalRunMain === undefined) {
        delete process.env.STUDIO_LINT_EXCEPTIONS_RUN_MAIN
      } else {
        process.env.STUDIO_LINT_EXCEPTIONS_RUN_MAIN = originalRunMain
      }
      process.argv = originalArgv
    }
  })

  it('handles errors from main() and exits with code 1', async () => {
    const originalRunMain = process.env.STUDIO_LINT_EXCEPTIONS_RUN_MAIN
    const originalArgv = process.argv
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCodes: (string | number | null | undefined)[] = []
    // Mock process.exit - store exit code but don't actually exit
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      exitCodes.push(code)
      // Throw to satisfy the never return type
      throw new Error('process.exit mock')
    })

    try {
      process.env.STUDIO_LINT_EXCEPTIONS_RUN_MAIN = 'true'
      // Use --tree to trigger the fs path that will throw
      process.argv = ['bun', 'check-lint-exceptions', '--tree']

      // Reset modules and set up throwing mock before reimport
      vi.resetModules()

      // Mock node:fs to throw an error
      vi.doMock('node:fs', () => ({
        readdirSync: () => {
          throw new Error('Test fs error')
        },
        statSync: vi.fn<
          (path: string) => {
            isDirectory: () => boolean
            isFile: () => boolean
          }
        >(),
        readFileSync: vi.fn<(path: string, encoding: string) => string>(),
      }))

      // Also re-mock child_process to avoid interference
      vi.doMock('node:child_process', () => ({
        execSync: vi.fn<(command: string, options?: object) => string>(),
      }))

      await import('./check-lint-exceptions')

      // Keep process.exit mocked until async main() hits the catch
      await vi.waitFor(() => {
        expect(exitCodes).toContain(1)
      })
      expect(consoleSpy).toHaveBeenCalledWith('Error:', expect.any(Error))
    } finally {
      consoleSpy.mockRestore()
      exitSpy.mockRestore()
      if (originalRunMain === undefined) {
        delete process.env.STUDIO_LINT_EXCEPTIONS_RUN_MAIN
      } else {
        process.env.STUDIO_LINT_EXCEPTIONS_RUN_MAIN = originalRunMain
      }
      process.argv = originalArgv
      vi.resetModules()
    }
  })
})
