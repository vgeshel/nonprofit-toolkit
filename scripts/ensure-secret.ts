#!/usr/bin/env bun
/**
 * Create or update a Secret Manager secret without ever blanking it.
 *
 * Usage: VALUE=... bun scripts/ensure-secret.ts --project <id> --name <secret> --from-env VALUE
 *
 * Called by the deploy scripts. All logic lives in secret-lib.ts.
 */
import { spawn } from 'node:child_process'
import { ensureSecret, parseArgs, type CommandRunner } from './secret-lib'

const run: CommandRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on(
      'data',
      (chunk: Buffer) => (stdout += chunk.toString('utf8')),
    )
    child.stderr.on(
      'data',
      (chunk: Buffer) => (stderr += chunk.toString('utf8')),
    )
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.end(options?.input ?? '')
  })

const options = parseArgs(process.argv.slice(2), process.env)
if (options.isErr()) {
  console.error(options.error.message)
  process.exit(1)
}

const result = await ensureSecret(options.value, run)
if (result.isErr()) {
  console.error(result.error.message)
  process.exit(1)
}
console.log(`  ${options.value.name} — ${result.value}`)
