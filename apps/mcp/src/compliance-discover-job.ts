/**
 * Cloud Run **Job** entrypoint for out-of-band compliance discovery.
 *
 * The `compliance-discover-start` MCP tool triggers a Cloud Run Job
 * execution of this image (command `bun dist/compliance-discover-job.js`),
 * passing `DISCOVERY_JOB_ID` (+ optional filter) as env overrides. This
 * process runs the discovery to completion and records the terminal status
 * on the parent `discovery_jobs` Firestore doc, then exits. Because it runs
 * as a Job — not inside the MCP HTTP request — it survives the MCP service
 * scaling to zero and is not bounded by the request timeout.
 *
 * This is a thin bootstrap (like `main.ts`): all logic lives in the tested
 * `parseDiscoverJobEnv` / `executeDiscoveryJobProduction` wiring.
 */
import { Firestore } from '@google-cloud/firestore'
import {
  executeDiscoveryJobProduction,
  parseDiscoverJobEnv,
} from '../../../src/compliance/skills/discover-job-wiring.ts'
import { createLogger } from './logger'

async function main(): Promise<void> {
  const logger = createLogger({ LOG_LEVEL: 'info' })
  const { projectId, jobId, filter } = parseDiscoverJobEnv(process.env)
  logger.info({ jobId, filter }, 'compliance-discover Job starting')

  const firestore = new Firestore({
    projectId,
    ignoreUndefinedProperties: true,
  })

  await executeDiscoveryJobProduction({
    projectId,
    jobId,
    filter,
    firestore,
    logger: {
      error: (message, err) => {
        logger.error({ err }, message)
      },
    },
  })

  logger.info({ jobId }, 'compliance-discover Job finished')
}

main().catch((error) => {
  console.error('compliance-discover Job crashed:', error)
  process.exit(1)
})
