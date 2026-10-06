#!/usr/bin/env bun
/**
 * Main entry point for the ETL runner.
 */
import dns from 'node:dns'

// Force IPv4 for all DNS lookups. Mercury's IP whitelist (0.0.0.0/0)
// only covers IPv4, not IPv6. Without this, fetch() may use IPv6
// and get rejected by Mercury's firewall.
//
// IMPORTANT: This MUST be at module level (not inside main()) because:
// 1. Module-level code runs at import time, before any other code
// 2. If moved to main(), any DNS lookups during module imports would
//    use the default (IPv6-preferring) behavior
// 3. The setting must be in place before ANY network calls happen
//
// Note: This setting affects Node.js DNS resolution but NOT Bun's fetch(),
// which uses its own HTTP implementation. For Bun compatibility, we also
// use the fetchIPv4 wrapper in packages/connectors/src/ipv4-fetch.ts
// which explicitly resolves to IPv4 before making requests.
dns.setDefaultResultOrder('ipv4first')

import { parseCli } from './cli'
import { loadConfig } from './config'
import { sendFailureAlert } from './failure-alert'
import { createLogger } from './logger'
import { Orchestrator } from './orchestrator'
import { runReport } from './report'

/**
 * Run the ETL based on CLI command.
 */
async function main(): Promise<void> {
  // Parse CLI arguments
  const commandResult = parseCli(process.argv.slice(2))

  if (commandResult.isErr()) {
    console.error('CLI Error:', commandResult.error.message)
    process.exit(1)
  }

  const command = commandResult.value

  // Load configuration
  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig()
  } catch (error) {
    console.error(
      'Configuration Error:',
      error instanceof Error ? error.message : error,
    )
    process.exit(1)
  }

  // Create logger and orchestrator
  const logger = createLogger(config)
  const orchestrator = new Orchestrator(config, logger)

  // Alert Slack, then exit non-zero. A failed alert is logged but never
  // changes the outcome: the run already failed.
  const failAndExit = async (job: string, error: unknown): Promise<never> => {
    const alert = await sendFailureAlert(config, job, error, logger)
    if (alert.isErr()) {
      logger.error({ error: alert.error }, 'Failure alert not sent')
    }
    process.exit(1)
  }

  try {
    await runCommand()
  } catch (error) {
    logger.error({ error }, 'Unexpected error')
    await failAndExit('ETL runner', error)
  }

  async function runCommand(): Promise<void> {
    // Execute command
    switch (command.command) {
      case 'daily': {
        const result = await orchestrator.runDaily(command.options)

        if (result.isErr()) {
          logger.error({ error: result.error }, 'Daily ETL failed')
          return failAndExit('Daily ETL', result.error)
        }

        logger.info(
          {
            runId: result.value.runId,
            totalCount: result.value.metrics?.totalCount,
            durationMs: result.value.metrics?.totalDurationMs,
          },
          'Daily ETL completed successfully',
        )
        break
      }

      case 'backfill': {
        const result = await orchestrator.runBackfill(command.options)

        if (result.isErr()) {
          logger.error({ error: result.error }, 'Backfill failed')
          return failAndExit('Backfill', result.error)
        }

        const succeeded = result.value.filter(
          (r) => r.status === 'succeeded',
        ).length
        const failed = result.value.filter((r) => r.status === 'failed').length
        const totalCount = result.value.reduce(
          (sum, r) => sum + (r.metrics?.totalCount ?? 0),
          0,
        )

        logger.info(
          {
            chunks: result.value.length,
            succeeded,
            failed,
            totalCount,
          },
          'Backfill completed',
        )

        if (failed > 0) {
          const firstError = result.value.find(
            (r) => r.status === 'failed',
          )?.error
          return failAndExit('Backfill', {
            type: 'backfill',
            message: `${failed} of ${result.value.length} chunks failed${firstError ? `; first: ${firstError}` : ''}`,
          })
        }
        break
      }

      case 'health': {
        const result = await orchestrator.healthCheck()

        if (result.isErr()) {
          logger.error({ error: result.error }, 'Health check failed')
          return failAndExit('Health check', result.error)
        }

        logger.info('Health check passed')
        break
      }

      case 'report': {
        const result = await runReport(config, command.options.period, logger)

        if (result.isErr()) {
          logger.error({ error: result.error }, 'Report generation failed')
          return failAndExit(
            `${command.options.period === 'weekly' ? 'Weekly' : 'Monthly'} report`,
            result.error,
          )
        }

        logger.info({ period: command.options.period }, 'Report sent to Slack')
        break
      }
    }
  }
}

// Run main
main().catch((error) => {
  console.error('Unexpected error:', error)
  process.exit(1)
})
