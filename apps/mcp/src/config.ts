/**
 * Configuration for the MCP server.
 *
 * Loads and validates environment variables using Zod.
 */
import { z } from 'zod'

export const ConfigSchema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Public URL of this server (for OAuth metadata)
  BASE_URL: z.string().url(),

  // GCP / BigQuery
  PROJECT_ID: z.string(),
  DATASET_CANON: z.string().default('donations'),

  // GCP region + the Cloud Run Job that runs compliance discovery
  // out-of-band (triggered by the compliance-discover-start tool).
  REGION: z.string().default('us-central1'),
  COMPLIANCE_DISCOVER_JOB_NAME: z.string().default('compliance-discover'),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  MCP_ALLOWED_DOMAIN: z.string(),

  // Organization identity (for letter templates)
  ORG_NAME: z.string().default('Your Organization'),
  ORG_ADDRESS: z.string().default(''),
  ORG_MISSION: z
    .string()
    .default(
      'Our organization is dedicated to making a positive impact through charitable giving.',
    ),
  ORG_TAX_STATUS: z
    .string()
    .default(
      'This organization is a tax-exempt organization under Section 501(c)(3) of the Internal Revenue Code. Our EIN is available upon request.',
    ),
  DEFAULT_SIGNER_NAME: z.string().default('Organization Leader'),
  DEFAULT_SIGNER_TITLE: z.string().default('Director'),
})

export type Config = z.infer<typeof ConfigSchema>

/**
 * Load configuration from environment variables.
 */
export function loadConfig(): Config {
  return ConfigSchema.parse(process.env)
}
