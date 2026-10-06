/**
 * Tests for check-github-script script.
 * Ensures that github-script usage is blocked in workflow files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('check-github-script', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('parseStagedFiles', () => {
    it('parses git diff output correctly', async () => {
      const { parseStagedFiles } = await import('./check-github-script')

      const gitOutput = `M\tworkflows/studio-pm.yml
A\t.github/workflows/studio-pm.yml
D\tsrc/old.ts`

      const files = parseStagedFiles(gitOutput)
      expect(files).toEqual([
        'workflows/studio-pm.yml',
        '.github/workflows/studio-pm.yml',
        // Deleted files are excluded
      ])
    })

    it('handles empty git output', async () => {
      const { parseStagedFiles } = await import('./check-github-script')

      const files = parseStagedFiles('')
      expect(files).toEqual([])
    })

    it('handles whitespace-only output', async () => {
      const { parseStagedFiles } = await import('./check-github-script')

      const files = parseStagedFiles('  \n  \n  ')
      expect(files).toEqual([])
    })

    it('handles lines without tab separators', async () => {
      const { parseStagedFiles } = await import('./check-github-script')

      const files = parseStagedFiles('M\tvalid/path.ts\ninvalid-line-no-tab')
      expect(files).toEqual(['valid/path.ts'])
    })

    it('excludes deleted files', async () => {
      const { parseStagedFiles } = await import('./check-github-script')

      const gitOutput = `M\tworkflows/keep.yml
D\tworkflows/deleted.yml
A\tworkflows/new.yml`

      const files = parseStagedFiles(gitOutput)
      expect(files).toEqual(['workflows/keep.yml', 'workflows/new.yml'])
    })
  })

  describe('containsGithubScript', () => {
    it('detects github-script usage without quotes', async () => {
      const { containsGithubScript } = await import('./check-github-script')

      const content = `
steps:
  - uses: actions/github-script@v7
    with:
      script: |
        console.log('hello')
`
      expect(containsGithubScript(content)).toBe(true)
    })

    it('detects github-script usage with single quotes', async () => {
      const { containsGithubScript } = await import('./check-github-script')

      const content = `
steps:
  - uses: 'actions/github-script@v7'
`
      expect(containsGithubScript(content)).toBe(true)
    })

    it('detects github-script usage with double quotes', async () => {
      const { containsGithubScript } = await import('./check-github-script')

      const content = `
steps:
  - uses: "actions/github-script@v7"
`
      expect(containsGithubScript(content)).toBe(true)
    })

    it('returns false for workflow without github-script', async () => {
      const { containsGithubScript } = await import('./check-github-script')

      const content = `
steps:
  - uses: actions/checkout@v4
  - uses: some-org/some-repo/actions/pr-details@main
`
      expect(containsGithubScript(content)).toBe(false)
    })

    it('returns false for empty content', async () => {
      const { containsGithubScript } = await import('./check-github-script')

      expect(containsGithubScript('')).toBe(false)
    })

    it('does not match github-script in comments', async () => {
      const { containsGithubScript } = await import('./check-github-script')

      // The regex matches raw content, so comments are still detected
      // This is intentional - we want to catch any reference
      const content = `
# We used to use: actions/github-script@v7
# Now we use TypeScript actions
`
      // Comments don't have the "uses:" prefix, so they don't match
      expect(containsGithubScript(content)).toBe(false)
    })
  })

  describe('checkGithubScript', () => {
    it('passes when no workflow files are staged', async () => {
      const { checkGithubScript } = await import('./check-github-script')

      const result = await checkGithubScript([])
      expect(result.success).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('passes when staged workflows have no github-script', async () => {
      const { checkGithubScript } = await import('./check-github-script')

      const mockReadFile = vi.fn<(path: string) => Promise<string>>()
        .mockResolvedValue(`
steps:
  - uses: actions/checkout@v4
`)

      const result = await checkGithubScript(
        ['workflows/studio-pm.yml'],
        mockReadFile,
      )
      expect(result.success).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('fails when staged workflow contains github-script', async () => {
      const { checkGithubScript } = await import('./check-github-script')

      const mockReadFile = vi.fn<(path: string) => Promise<string>>()
        .mockResolvedValue(`
steps:
  - uses: actions/github-script@v7
    with:
      script: console.log('bad')
`)

      const result = await checkGithubScript(
        ['workflows/studio-pm.yml'],
        mockReadFile,
      )
      expect(result.success).toBe(false)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('studio-pm.yml')
      expect(result.errors[0]).toContain('actions/github-script')
    })

    it('fails for multiple workflows with github-script', async () => {
      const { checkGithubScript } = await import('./check-github-script')

      const mockReadFile = vi.fn<(path: string) => Promise<string>>()
        .mockResolvedValue(`
steps:
  - uses: actions/github-script@v7
`)

      const result = await checkGithubScript(
        ['workflows/studio-pm.yml', '.github/workflows/studio-coding.yml'],
        mockReadFile,
      )
      expect(result.success).toBe(false)
      expect(result.errors).toHaveLength(2)
    })

    it('ignores non-workflow files', async () => {
      const { checkGithubScript } = await import('./check-github-script')

      const mockReadFile = vi.fn<(path: string) => Promise<string>>()
        .mockResolvedValue(`
// This is a TypeScript file
const x = 'actions/github-script@v7'
`)

      const result = await checkGithubScript(['src/index.ts'], mockReadFile)
      expect(result.success).toBe(true)
      expect(mockReadFile).not.toHaveBeenCalled()
    })

    it('handles file read errors gracefully', async () => {
      const { checkGithubScript } = await import('./check-github-script')

      const mockReadFile = vi
        .fn<(path: string) => Promise<string>>()
        .mockRejectedValue(new Error('File not found'))

      const result = await checkGithubScript(
        ['workflows/studio-pm.yml'],
        mockReadFile,
      )
      expect(result.success).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('checks both workflows/ and .github/workflows/ directories', async () => {
      const { checkGithubScript } = await import('./check-github-script')

      const mockReadFile = vi.fn<(path: string) => Promise<string>>()
        .mockResolvedValue(`
steps:
  - uses: actions/checkout@v4
`)

      await checkGithubScript(
        [
          'workflows/studio-pm.yml',
          '.github/workflows/studio-pm.yml',
          'other/file.yml',
        ],
        mockReadFile,
      )

      expect(mockReadFile).toHaveBeenCalledTimes(2)
      expect(mockReadFile).toHaveBeenCalledWith('workflows/studio-pm.yml')
      expect(mockReadFile).toHaveBeenCalledWith(
        '.github/workflows/studio-pm.yml',
      )
    })
  })

  describe('main', () => {
    it('exits with 0 when no workflow files are staged', async () => {
      vi.doMock('node:child_process', () => ({
        exec: vi.fn(
          (
            _cmd: string,
            callback: (
              err: Error | null,
              result: { stdout: string; stderr: string },
            ) => void,
          ) => {
            callback(null, { stdout: 'M\tsrc/index.ts\n', stderr: '' })
          },
        ),
      }))

      vi.resetModules()

      const exitCalls: (string | number | null | undefined)[] = []
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        exitCalls.push(code)
        throw new Error(`process.exit(${code})`)
      })
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})

      const { main } = await import('./check-github-script')

      await expect(main()).rejects.toThrow()
      expect(exitCalls[0]).toBe(0)

      consoleSpy.mockRestore()
      consoleErrorSpy.mockRestore()
      exitSpy.mockRestore()
    })

    it('exits with 1 when github-script is found', async () => {
      vi.doMock('node:child_process', () => ({
        exec: vi.fn(
          (
            _cmd: string,
            callback: (
              err: Error | null,
              result: { stdout: string; stderr: string },
            ) => void,
          ) => {
            callback(null, {
              stdout: 'M\tworkflows/studio-pm.yml\n',
              stderr: '',
            })
          },
        ),
      }))

      vi.doMock('node:fs/promises', () => ({
        readFile: vi.fn<(path: string, encoding: string) => Promise<string>>()
          .mockResolvedValue(`
steps:
  - uses: actions/github-script@v7
`),
      }))

      vi.resetModules()

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`)
      })
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})

      const { main } = await import('./check-github-script')

      await expect(main()).rejects.toThrow('process.exit(1)')
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('GitHub Script check failed'),
      )

      consoleErrorSpy.mockRestore()
      exitSpy.mockRestore()
    })

    it('exits with 1 when git command fails', async () => {
      vi.doMock('node:child_process', () => ({
        exec: vi.fn(
          (
            _cmd: string,
            callback: (
              err: Error | null,
              result: { stdout: string; stderr: string },
            ) => void,
          ) => {
            callback(new Error('git error'), { stdout: '', stderr: 'error' })
          },
        ),
      }))

      vi.resetModules()

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`)
      })
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})

      const { main } = await import('./check-github-script')

      await expect(main()).rejects.toThrow('process.exit(1)')

      consoleErrorSpy.mockRestore()
      exitSpy.mockRestore()
    })
  })

  describe('entrypoint', () => {
    it('runs main when STUDIO_CHECK_GITHUB_SCRIPT_RUN_MAIN is true', async () => {
      const originalRunMain = process.env.STUDIO_CHECK_GITHUB_SCRIPT_RUN_MAIN
      let exited = false
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        exited = true
        throw new Error(`process.exit(${code})`)
      })
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {})

      try {
        process.env.STUDIO_CHECK_GITHUB_SCRIPT_RUN_MAIN = 'true'
        vi.resetModules()
        await import('./check-github-script')
        // Keep process.exit mocked until async main() reaches it
        await vi.waitFor(() => {
          expect(exited).toBe(true)
        })
      } finally {
        expect(exited).toBe(true)
        exitSpy.mockRestore()
        consoleSpy.mockRestore()
        consoleErrorSpy.mockRestore()
        if (originalRunMain === undefined) {
          delete process.env.STUDIO_CHECK_GITHUB_SCRIPT_RUN_MAIN
        } else {
          process.env.STUDIO_CHECK_GITHUB_SCRIPT_RUN_MAIN = originalRunMain
        }
        vi.resetModules()
      }
    })
  })
})
