/**
 * Configuration for the Slack bot.
 *
 * Loads and validates environment variables using Zod.
 */
import { z } from 'zod'

/**
 * Configuration schema for the Slack bot.
 */
export const ConfigSchema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // GCP / BigQuery
  PROJECT_ID: z.string(),
  DATASET_CANON: z.string().default('donations'),

  // AI
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().optional(),

  // Slack
  SLACK_BOT_TOKEN: z.string(),
  SLACK_SIGNING_SECRET: z.string(),

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
