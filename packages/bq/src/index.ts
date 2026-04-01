/**
 * @donations-etl/bq
 *
 * BigQuery integration for Donations ETL.
 */

// Client
export {
  BigQueryClient,
  type BigQueryError,
  type BigQueryErrorType,
} from './client'

// Types
export {
  EtlMetricsSchema,
  EtlModeSchema,
  EtlRunSchema,
  EtlStatusSchema,
  ReportRowSchema,
  SourceMetricsSchema,
  WatermarkSchema,
  parseReportRows,
  type BigQueryConfig,
  type EtlMetrics,
  type EtlMode,
  type EtlRun,
  type EtlStatus,
  type GCSConfig,
  type LoadOptions,
  type LoadResult,
  type MergeOptions,
  type MergeResult,
  type ReportData,
  type ReportRow,
  type SourceMetrics,
  type Watermark,
} from './types'

// SQL generation
export {
  generateGetRunSql,
  generateGetWatermarkSql,
  generateInsertRunSql,
  generateMergeSql,
  generateUpdateRunSql,
  generateUpdateSourceCoverageSql,
  generateUpsertWatermarkSql,
} from './sql'

// Report SQL
export { generateReportSql } from './report-sql'

// SQL safety
export { ensureLimit, validateReadOnlySql } from './sql-safety'

// Donation agent
export {
  buildQueryFn,
  runDonationAgent,
  type AgentError,
  type AgentResult,
  type ConversationMessage,
  type QueryFn,
} from './donation-agent'

// NDJSON utilities
export {
  chunkEvents,
  eventToNdjsonLine,
  eventsToNdjson,
  generateGcsPath,
  generateGcsPattern,
  generateGcsUri,
} from './ndjson'
