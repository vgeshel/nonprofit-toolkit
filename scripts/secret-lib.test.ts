/**
 * Tests for idempotent Secret Manager writes.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  describeParseError,
  ensureSecret,
  parseArgs,
  type CommandResult,
  type CommandRunner,
} from './secret-lib'

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr = 'NOT_FOUND'): CommandResult => ({
  code: 1,
  stdout: '',
  stderr,
})

/**
 * Fake gcloud: `describe` and `access` answer from the given state; every call
 * is recorded as a single string (stdin shown after `<<<`).
 */
function fakeGcloud(state: { exists: boolean; latest?: string }) {
  const calls: string[] = []
  const run = vi.fn<CommandRunner>((command, args, options) => {
    const line = [command, ...args].join(' ')
    calls.push(
      options?.input === undefined ? line : `${line} <<< ${options.input}`,
    )
    if (args[1] === 'describe') {
      return Promise.resolve(state.exists ? ok() : fail())
    }
    if (args[1] === 'versions' && args[2] === 'access') {
      return Promise.resolve(
        state.latest === undefined ? fail('no versions') : ok(state.latest),
      )
    }
    return Promise.resolve(ok())
  })
  return { run, calls }
}

const base = { projectId: 'p', name: 'ORG_NAME' }

describe('ensureSecret', () => {
  it('creates the secret and adds the value when it does not exist', async () => {
    const { run, calls } = fakeGcloud({ exists: false })

    const result = await ensureSecret(
      { ...base, value: 'Example Charity' },
      run,
    )

    expect(result._unsafeUnwrap()).toBe('updated')
    expect(calls).toEqual([
      'gcloud secrets describe ORG_NAME --project=p',
      'gcloud secrets create ORG_NAME --project=p --replication-policy=automatic',
      'gcloud secrets versions access latest --secret=ORG_NAME --project=p',
      'gcloud secrets versions add ORG_NAME --project=p --data-file=- <<< Example Charity',
    ])
  })

  it('adds a version when the value changed', async () => {
    const { run, calls } = fakeGcloud({ exists: true, latest: 'Old Name' })

    const result = await ensureSecret({ ...base, value: 'New Name' }, run)

    expect(result._unsafeUnwrap()).toBe('updated')
    expect(calls.at(-1)).toBe(
      'gcloud secrets versions add ORG_NAME --project=p --data-file=- <<< New Name',
    )
  })

  it('does nothing when the value is already current', async () => {
    const { run, calls } = fakeGcloud({ exists: true, latest: 'Same' })

    const result = await ensureSecret({ ...base, value: 'Same' }, run)

    expect(result._unsafeUnwrap()).toBe('unchanged')
    expect(calls.some((c) => c.includes('versions add'))).toBe(false)
  })

  it('keeps the existing value when none is provided', async () => {
    const { run, calls } = fakeGcloud({ exists: true, latest: 'Real' })

    const result = await ensureSecret({ ...base, value: undefined }, run)

    expect(result._unsafeUnwrap()).toBe('kept')
    expect(calls.some((c) => c.includes('versions add'))).toBe(false)
  })

  it('treats an empty value as not provided', async () => {
    const { run } = fakeGcloud({ exists: true, latest: 'Real' })

    const result = await ensureSecret({ ...base, value: '' }, run)

    expect(result._unsafeUnwrap()).toBe('kept')
  })

  it('fails when the secret has no value anywhere', async () => {
    const { run, calls } = fakeGcloud({ exists: true })

    const result = await ensureSecret({ ...base, value: undefined }, run)

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'missing',
      message:
        'ORG_NAME has no value in Secret Manager and none was provided; set it in .env',
    })
    expect(calls.some((c) => c.includes('versions add'))).toBe(false)
  })

  it('fails when the secret does not exist and has no value', async () => {
    const { run, calls } = fakeGcloud({ exists: false })

    const result = await ensureSecret({ ...base, value: undefined }, run)

    expect(result._unsafeUnwrapErr().type).toBe('missing')
    expect(calls).toEqual(['gcloud secrets describe ORG_NAME --project=p'])
  })

  it('reports a failed create', async () => {
    const run = vi.fn<CommandRunner>((_command, args) =>
      Promise.resolve(
        args[1] === 'create' ? fail('PERMISSION_DENIED') : fail('NOT_FOUND'),
      ),
    )

    const result = await ensureSecret({ ...base, value: 'x' }, run)

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'gcloud',
      message: 'gcloud secrets create ORG_NAME failed: PERMISSION_DENIED',
    })
  })

  it('reports a failed version add', async () => {
    const run = vi.fn<CommandRunner>((_command, args) =>
      Promise.resolve(
        args[2] === 'add'
          ? fail('QUOTA')
          : args[1] === 'describe'
            ? ok()
            : fail(),
      ),
    )

    const result = await ensureSecret({ ...base, value: 'x' }, run)

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'gcloud',
      message: 'gcloud secrets versions add ORG_NAME failed: QUOTA',
    })
  })

  it('reports gcloud failing to start', async () => {
    const run = vi.fn<CommandRunner>().mockRejectedValue(new Error('ENOENT'))

    const result = await ensureSecret({ ...base, value: 'x' }, run)

    expect(result._unsafeUnwrapErr()).toEqual({
      type: 'gcloud',
      message: 'gcloud secrets describe ORG_NAME could not run: ENOENT',
    })
  })

  it('reports a non-Error failure to start', async () => {
    const run = vi.fn<CommandRunner>().mockRejectedValue('spawn failed')

    const result = await ensureSecret({ ...base, value: 'x' }, run)

    expect(result._unsafeUnwrapErr().message).toBe(
      'gcloud secrets describe ORG_NAME could not run: spawn failed',
    )
  })
})

describe('parseArgs', () => {
  const env = { ORG_NAME: 'Example Charity', EMPTY: '' }

  it('reads the value from the named environment variable', () => {
    expect(
      parseArgs(
        ['--project', 'p', '--name', 'ORG_NAME', '--from-env', 'ORG_NAME'],
        env,
      )._unsafeUnwrap(),
    ).toEqual({
      projectId: 'p',
      name: 'ORG_NAME',
      value: 'Example Charity',
    })
  })

  it('treats an empty variable as no value', () => {
    expect(
      parseArgs(
        ['--project', 'p', '--name', 'X', '--from-env', 'EMPTY'],
        env,
      )._unsafeUnwrap().value,
    ).toBeUndefined()
  })

  it('requires the project, name and env var', () => {
    expect(parseArgs(['--project', 'p'], env)._unsafeUnwrapErr()).toEqual({
      type: 'usage',
      message: "error: required option '--name <secret>' not specified",
    })
  })

  it('returns --help as a usage result instead of printing and exiting', () => {
    expect(parseArgs(['--help'], env)._unsafeUnwrapErr()).toEqual({
      type: 'usage',
      message: '(outputHelp)',
    })
  })
})

describe('describeParseError', () => {
  it('uses the text of anything that is not a CommanderError', () => {
    expect(describeParseError('odd')).toBe('odd')
  })
})
