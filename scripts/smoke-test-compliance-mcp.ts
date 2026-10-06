#!/usr/bin/env bun
/**
 * Smoke-test the deployed compliance MCP surface end-to-end.
 *
 * Writes a short-lived synthetic MCP installation to the production Firestore
 * OAuth storage, calls the deployed endpoint with it, and deletes it again.
 * The same service-account-backed Secret Manager and BigQuery calls run as for
 * a real user, so an IAM regression on either backend surfaces here.
 *
 *   bun scripts/smoke-test-compliance-mcp.ts \
 *     --base-url https://your-mcp-server.example.com \
 *     --project your-gcp-project \
 *     --user-email you@your-org.example
 *
 * All logic lives in smoke-test-compliance-mcp-lib.ts, under test.
 */
import {
  FirestoreOAuthStorage,
  generateToken,
} from '../apps/mcp/src/auth/storage.ts'
import { parseArgs, runSmokeTest } from './smoke-test-compliance-mcp-lib'

const options = parseArgs(process.argv.slice(2))
if (options.isErr()) {
  console.error(options.error.message)
  process.exit(1)
}

const result = await runSmokeTest(options.value, {
  store: new FirestoreOAuthStorage(options.value.projectId),
  generateToken,
  fetch,
  now: Date.now,
})

if (result.isErr()) {
  console.error(`✗ ${result.error.step}: ${result.error.message}`)
  process.exit(1)
}
for (const line of result.value) {
  console.log(`✓ ${line}`)
}
console.log('All checks passed; synthetic installation removed.')
