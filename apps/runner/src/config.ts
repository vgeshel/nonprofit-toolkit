/**
 * Configuration for the ETL runner.
 *
 * Loads and validates environment variables using Zod.
 */
import { z } from 'zod'

/**
 * Configuration schema.
 */
export const ConfigSchema = z.object({
  // GCP (same names as provisioning script)
  PROJECT_ID: z.string(),
  BUCKET: z.string(),

  // BigQuery (same names as provisioning script)
  DATASET_RAW: z.string().default('donations_raw'),
  DATASET_CANON: z.string().default('donations'),

  // ETL behavior
  LOOKBACK_HOURS: z.coerce.number().int().positive().default(48),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Connector secrets (from Secret Manager, mounted as env vars)
  MERCURY_API_KEY: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_SECRET: z.string().optional(),
  GIVEBUTTER_API_KEY: z.string().optional(),

  // Check deposits (Google Sheets)
  CHECK_DEPOSITS_SPREADSHEET_ID: z.string().optional(),
  CHECK_DEPOSITS_SHEET_NAME: z.string().default('checks'),

  // Wise (balanceId not needed - connector auto-discovers all balances)
  WISE_TOKEN: z.string().optional(),
  WISE_PROFILE_ID: z.coerce.number().int().positive().optional(),

  // Patreon
  PATREON_ACCESS_TOKEN: z.string().optional(),
  PATREON_CAMPAIGN_ID: z.string().optional(),

  // Slack (for reports)
  SLACK_BOT_TOKEN: z.string().optional(),
  REPORT_SLACK_CHANNEL: z.string().optional(),
})

export type Config = z.infer<typeof ConfigSchema>

/**
 * Load configuration from environment variables.
 *
 * For secrets, checks both runtime names (MERCURY_API_KEY) and
 * provisioning names (SECRET_MERCURY_API_KEY) to support both
 * Cloud Run (secrets mounted without prefix) and local dev
 * (using same .env as provisioning).
 *
 * Throws a ZodError if validation fails.
 */
export function loadConfig(): Config {
  const env = {
    ...process.env,
    // Use SECRET_* vars as fallback for local dev
    MERCURY_API_KEY:
      process.env.MERCURY_API_KEY ?? process.env.SECRET_MERCURY_API_KEY,
    PAYPAL_CLIENT_ID:
      process.env.PAYPAL_CLIENT_ID ?? process.env.SECRET_PAYPAL_CLIENT_ID,
    PAYPAL_SECRET:
      process.env.PAYPAL_SECRET ?? process.env.SECRET_PAYPAL_SECRET,
    GIVEBUTTER_API_KEY:
      process.env.GIVEBUTTER_API_KEY ?? process.env.SECRET_GIVEBUTTER_API_KEY,
    WISE_TOKEN: process.env.WISE_TOKEN ?? process.env.SECRET_WISE_TOKEN,
    PATREON_ACCESS_TOKEN:
      process.env.PATREON_ACCESS_TOKEN ??
      process.env.SECRET_PATREON_ACCESS_TOKEN,
  }
  return ConfigSchema.parse(env)
}

/**
 * Check which sources are enabled based on configuration.
 */
export function getEnabledSources(
  config: Config,
): (
  | 'mercury'
  | 'paypal'
  | 'givebutter'
  | 'check_deposits'
  | 'wise'
  | 'patreon'
)[] {
  const sources: (
    | 'mercury'
    | 'paypal'
    | 'givebutter'
    | 'check_deposits'
    | 'wise'
    | 'patreon'
  )[] = []

  if (config.MERCURY_API_KEY) {
    sources.push('mercury')
  }

  if (config.PAYPAL_CLIENT_ID && config.PAYPAL_SECRET) {
    sources.push('paypal')
  }

  if (config.GIVEBUTTER_API_KEY) {
    sources.push('givebutter')
  }

  if (config.CHECK_DEPOSITS_SPREADSHEET_ID) {
    sources.push('check_deposits')
  }

  if (config.WISE_TOKEN && config.WISE_PROFILE_ID) {
    sources.push('wise')
  }

  if (config.PATREON_ACCESS_TOKEN && config.PATREON_CAMPAIGN_ID) {
    sources.push('patreon')
  }

  return sources
}
