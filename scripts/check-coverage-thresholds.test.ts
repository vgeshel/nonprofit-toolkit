/**
 * Tests for coverage threshold checking
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { main } from './check-coverage-thresholds'

// Handle unhandled rejections from process.exit mocks in entrypoint tests
beforeAll(() => {
  process.on('unhandledRejection', (reason: unknown) => {
    if (reason instanceof Error && reason.message.startsWith('process.exit(')) {
      return
    }
    throw reason
  })
})

describe('main', () => {
  let exitCalls: (string | number | null | undefined)[]

  beforeEach(() => {
    exitCalls = []
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      exitCalls.push(code)
      throw new Error(`process.exit(${code})`)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exits with 0 when all thresholds are 100', async () => {
    const config = {
      default: {
        test: {
          coverage: {
            thresholds: {
              statements: 100,
              branches: 100,
              functions: 100,
              lines: 100,
            },
          },
        },
      },
    }

    await expect(main(config)).rejects.toThrow('process.exit(0)')
    expect(exitCalls).toEqual([0])
    expect(console.log).toHaveBeenCalledWith(
      '✅ Coverage thresholds verified (all at 100%)',
    )
  })

  it('exits with 1 when a threshold is not 100', async () => {
    const config = {
      default: {
        test: {
          coverage: {
            thresholds: {
              statements: 80,
              branches: 100,
              functions: 100,
              lines: 100,
            },
          },
        },
      },
    }

    await expect(main(config)).rejects.toThrow('process.exit(1)')
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('COMMIT BLOCKED'),
    )
  })

  it('exits with 1 when config structure is invalid', async () => {
    await expect(main({ default: {} })).rejects.toThrow('process.exit(1)')
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('COMMIT BLOCKED'),
    )
  })

  it('handles non-Error exceptions', async () => {
    const config = {
      get default(): unknown {
        throw 'string-error'
      },
    }

    await expect(main(config)).rejects.toThrow('process.exit(1)')
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith('Error: string-error')
  })

  it('handles Error exceptions', async () => {
    const config = {
      get default(): unknown {
        throw new Error('test error')
      },
    }

    await expect(main(config)).rejects.toThrow('process.exit(1)')
    expect(exitCalls).toEqual([1])
    expect(console.error).toHaveBeenCalledWith('Error: test error')
  })
})

describe('entrypoint', () => {
  it('runs main when STUDIO_COVERAGE_THRESHOLDS_RUN_MAIN is true', async () => {
    const originalRunMain = process.env.STUDIO_COVERAGE_THRESHOLDS_RUN_MAIN
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})

    try {
      process.env.STUDIO_COVERAGE_THRESHOLDS_RUN_MAIN = 'true'
      vi.resetModules()
      await import('./check-coverage-thresholds')
      // Keep process.exit mocked until async main() reaches it
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalled()
      })
    } finally {
      exitSpy.mockRestore()
      consoleSpy.mockRestore()
      consoleErrorSpy.mockRestore()
      if (originalRunMain === undefined) {
        delete process.env.STUDIO_COVERAGE_THRESHOLDS_RUN_MAIN
      } else {
        process.env.STUDIO_COVERAGE_THRESHOLDS_RUN_MAIN = originalRunMain
      }
      vi.resetModules()
    }
  })
})
