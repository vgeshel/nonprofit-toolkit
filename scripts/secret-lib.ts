/**
 * Idempotent Secret Manager writes for provisioning and deploy scripts.
 *
 * A missing or empty value never overwrites a secret: the existing version is
 * kept, so running a deploy with an incomplete .env cannot blank out a live
 * credential. A value equal to the current version adds nothing, so repeated
 * deploys do not pile up identical versions.
 */
import { Command, CommanderError } from 'commander'
import { Result, ResultAsync, err, errAsync, ok, okAsync } from 'neverthrow'
import { z } from 'zod'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string },
) => Promise<CommandResult>

export interface SecretError {
  type: 'gcloud' | 'missing' | 'usage'
  message: string
}

export interface SecretOptions {
  projectId: string
  name: string
  /** New value; undefined or empty means "keep whatever is there". */
  value: string | undefined
}

export type SecretOutcome = 'updated' | 'unchanged' | 'kept'

function gcloud(
  run: CommandRunner,
  label: string,
  args: string[],
  input?: string,
): ResultAsync<CommandResult, SecretError> {
  return ResultAsync.fromPromise(
    run('gcloud', args, input === undefined ? undefined : { input }),
    (cause): SecretError => ({
      type: 'gcloud',
      message: `gcloud ${label} could not run: ${cause instanceof Error ? cause.message : String(cause)}`,
    }),
  )
}

/** Run gcloud and turn a non-zero exit into an error. */
function gcloudOk(
  run: CommandRunner,
  label: string,
  args: string[],
  input?: string,
): ResultAsync<CommandResult, SecretError> {
  return gcloud(run, label, args, input).andThen((result) =>
    result.code === 0
      ? okAsync(result)
      : errAsync<CommandResult, SecretError>({
          type: 'gcloud',
          message: `gcloud ${label} failed: ${result.stderr.trim()}`,
        }),
  )
}

/**
 * Make the secret hold `value`, or keep its current value when none is given.
 */
export function ensureSecret(
  options: SecretOptions,
  run: CommandRunner,
): ResultAsync<SecretOutcome, SecretError> {
  const { projectId, name } = options
  const value = options.value === '' ? undefined : options.value
  const project = `--project=${projectId}`

  const latest = (): ResultAsync<string | undefined, SecretError> =>
    gcloud(run, `secrets versions access ${name}`, [
      'secrets',
      'versions',
      'access',
      'latest',
      `--secret=${name}`,
      project,
    ]).map((result) => (result.code === 0 ? result.stdout : undefined))

  return gcloud(run, `secrets describe ${name}`, [
    'secrets',
    'describe',
    name,
    project,
  ]).andThen((described) => {
    const exists = described.code === 0

    if (value === undefined) {
      const current = exists ? latest() : okAsync(undefined)
      return current.andThen((existing) => {
        return existing !== undefined
          ? okAsync<SecretOutcome, SecretError>('kept')
          : errAsync<SecretOutcome, SecretError>({
              type: 'missing',
              message: `${name} has no value in Secret Manager and none was provided; set it in .env`,
            })
      })
    }

    const created = exists
      ? okAsync<unknown, SecretError>(undefined)
      : gcloudOk(run, `secrets create ${name}`, [
          'secrets',
          'create',
          name,
          project,
          '--replication-policy=automatic',
        ])

    return created
      .andThen(() => latest())
      .andThen((existing) =>
        existing === value
          ? okAsync<SecretOutcome, SecretError>('unchanged')
          : gcloudOk(
              run,
              `secrets versions add ${name}`,
              ['secrets', 'versions', 'add', name, project, '--data-file=-'],
              value,
            ).map((): SecretOutcome => 'updated'),
      )
  })
}

const RawArgsSchema = z.object({
  project: z.string().min(1),
  name: z.string().min(1),
  fromEnv: z.string().min(1),
})

/**
 * Commander throws CommanderError under exitOverride; anything else is shown as is.
 */
export function describeParseError(error: unknown): string {
  return error instanceof CommanderError ? error.message : String(error)
}

/**
 * Parse `--project <id> --name <secret> --from-env <VAR>`.
 *
 * The value is read from an environment variable so it never appears in the
 * process list.
 */
export function parseArgs(
  args: string[],
  env: Record<string, string | undefined>,
): Result<SecretOptions, SecretError> {
  const program = new Command()
    .name('ensure-secret')
    .description('Create or update a Secret Manager secret without blanking it')
    .requiredOption('--project <id>', 'GCP project ID')
    .requiredOption('--name <secret>', 'Secret name')
    .requiredOption(
      '--from-env <var>',
      'Environment variable holding the value',
    )
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: () => undefined })

  return Result.fromThrowable(
    (): unknown => program.parse(args, { from: 'user' }).opts(),
    (error): SecretError => ({
      type: 'usage',
      message: describeParseError(error),
    }),
  )().andThen((opts) => {
    const parsed = RawArgsSchema.safeParse(opts)
    /* istanbul ignore if -- @preserve commander already enforces the required options */
    if (!parsed.success) {
      return err<SecretOptions, SecretError>({
        type: 'usage',
        message: parsed.error.message,
      })
    }
    const value = env[parsed.data.fromEnv]
    return ok<SecretOptions, SecretError>({
      projectId: parsed.data.project,
      name: parsed.data.name,
      value: value === '' ? undefined : value,
    })
  })
}
