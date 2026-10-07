/**
 * Run external commands (gcloud, bq) from provisioning scripts.
 *
 * The type lets the logic libraries take a fake runner in tests; spawnRunner is
 * the real implementation used by the thin CLI wrappers.
 */
import { spawn } from 'node:child_process'

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

export const spawnRunner: CommandRunner = (command, args, options) =>
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
