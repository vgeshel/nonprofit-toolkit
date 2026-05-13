/**
 * Logger for the Slack bot.
 */
import pino from 'pino'
import type { Config } from './config'

/**
 * Create a pino logger instance.
 */
export function createLogger(config: Pick<Config, 'LOG_LEVEL'>) {
  return pino({
    level: config.LOG_LEVEL,
    ...(process.env.NODE_ENV !== 'production' && {
      transport: { target: 'pino-pretty' },
    }),
  })
}
