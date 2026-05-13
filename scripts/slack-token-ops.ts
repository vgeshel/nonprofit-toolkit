#!/usr/bin/env bun
/**
 * Executable wrapper for Slack token operations.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CommandResult,
  type CommandRunner,
  type SlackTokenValidation,
  ensureSlackMonitoring,
  parseArgs,
  promoteSlackBotToken,
  smokeSlackRuntime,
  validateSlackBotToken,
} from './slack-token-ops-lib'

async function readSecretVersion(
  options: { projectId?: string; secretName: string; version: string },
  run: CommandRunner,
): Promise<string> {
  if (!options.projectId) {
    throw new Error('Set --token, --token-env, or --project')
  }
  const result = await run('gcloud', [
    'secrets',
    'versions',
    'access',
    options.version,
    `--secret=${options.secretName}`,
    `--project=${options.projectId}`,
  ])
  if (result.code !== 0) {
    throw new Error(result.stderr || 'Failed to read secret')
  }
  return result.stdout.trim()
}

function tokenFromEnv(name: string): string {
  return process.env[name] ?? ''
}

async function resolveToken(
  options: {
    token?: string
    tokenEnv?: string
    projectId?: string
    secretName?: string
    version?: string
  },
  run: CommandRunner,
): Promise<string> {
  if (options.token) {
    return options.token
  }
  if (options.tokenEnv) {
    return tokenFromEnv(options.tokenEnv)
  }
  return readSecretVersion(
    {
      projectId: options.projectId,
      secretName: options.secretName ?? 'SLACK_BOT_TOKEN',
      version: options.version ?? 'latest',
    },
    run,
  )
}

async function defaultRun(
  command: string,
  args: string[],
  options?: { input?: string },
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr })
    })

    child.stdin.end(options?.input ?? '')
  })
}

async function defaultWritePolicyFile(policy: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'slack-token-ops-'))
  const path = join(directory, 'alert-policy.json')
  await writeFile(path, `${JSON.stringify(policy, null, 2)}\n`, 'utf8')
  return path
}

function printValidation(result: SlackTokenValidation, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(result.ok ? `ok: ${result.team} / ${result.user}` : result.error)
}

async function main(args: string[]): Promise<void> {
  const options = parseArgs(args)

  if (options.command === 'validate') {
    const token = await resolveToken(options, defaultRun)
    const result = await validateSlackBotToken(token)
    printValidation(result, options.json)
    process.exit(result.ok ? 0 : 1)
  }

  if (options.command === 'promote') {
    const token = await resolveToken(options, defaultRun)
    const result = await promoteSlackBotToken(
      {
        projectId: options.projectId,
        secretName: options.secretName,
        token,
        disablePreviousLatest: options.disablePreviousLatest,
      },
      { run: defaultRun },
    )
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  }

  if (options.command === 'ensure-monitoring') {
    await ensureSlackMonitoring(options, {
      run: defaultRun,
      writeFile: defaultWritePolicyFile,
    })
    console.log('Slack monitoring is configured')
    process.exit(0)
  }

  const result = await smokeSlackRuntime(options.serviceUrl)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
