/**
 * BigQuery row schemas and table definitions for the `compliance` dataset.
 *
 * The four Phase 1 tables — `entity`, `discovery_runs`, `findings`,
 * `sources` — are defined as data here. The migration script (`scripts/
 * compliance-migrate.ts`) consumes the table definitions to create tables;
 * the runtime accessors consume the row schemas to validate query results.
 *
 * Keeping schema and validation in lockstep prevents the "row shape drifts
 * away from CREATE TABLE" bug — they share the source of truth.
 *
 * BigQuery quirks we account for:
 *   - TIMESTAMP columns come back as `{ value: '...ISO...' }` objects.
 *     Schemas preprocess that into a plain string.
 *   - INT64 columns may come back as strings on the wire. Schemas use
 *     `z.coerce.number()` for safety.
 */
import { z } from 'zod'
import {
  EntitySchema,
  FindingSchema,
  SourceKindSchema,
} from '../types/index.ts'

/**
 * Strip `{ value: string }` BigQueryTimestamp wrappers down to a string.
 *
 * Local copy (not imported from `entity.ts`) so this file has no dependency
 * on internal helpers there.
 */
const extractTimestampValue = (val: unknown): unknown => {
  if (
    val !== null &&
    typeof val === 'object' &&
    'value' in val &&
    typeof val.value === 'string'
  ) {
    return val.value
  }
  return val
}

/**
 * Name of the BigQuery dataset that holds compliance data. Kept separate
 * from the donations dataset (`donations` / `donations_raw`) so the two
 * concerns can be authorised, partitioned, and dropped independently.
 */
export const COMPLIANCE_DATASET = 'compliance'

/**
 * BigQuery field type strings we use in this codebase. The official set is
 * larger; this enum is a short list of what the compliance tables actually
 * need so we get a compile-time error if a typo creeps in.
 */
export type BqFieldType =
  | 'STRING'
  | 'INT64'
  | 'TIMESTAMP'
  | 'DATE'
  | 'JSON'
  | 'BOOL'

/**
 * BigQuery field mode.
 */
export type BqFieldMode = 'REQUIRED' | 'NULLABLE'

/**
 * One column in a BigQuery table definition.
 */
export interface TableSchemaField {
  readonly name: string
  readonly type: BqFieldType
  readonly mode: BqFieldMode
}

/**
 * One BigQuery table definition.
 */
export interface ComplianceTableDefinition {
  readonly name: string
  readonly description: string
  readonly fields: readonly TableSchemaField[]
}

/**
 * Wrap an array of fields into the shape BigQuery's `createTable` expects.
 *
 * Returns a fresh array so callers cannot mutate the table definitions.
 */
export function buildTableSchema(fields: readonly TableSchemaField[]): {
  fields: TableSchemaField[]
} {
  return { fields: fields.slice() }
}

/**
 * Phase 1 table definitions.
 *
 * Schema choices:
 *   - `entity` is single-row, but we still partition-free it: there's no
 *     point in event-time semantics for an entity row.
 *   - `discovery_runs` is partitioned by `started_at` so we can prune long
 *     histories cheaply when this dataset gets old.
 *   - `findings` is partitioned by `opened_at` for the same reason.
 *   - `sources` is a tiny registry snapshot; no partitioning.
 */
export const COMPLIANCE_TABLES: readonly ComplianceTableDefinition[] = [
  {
    name: 'entity',
    description: 'Single-row, non-secret attributes of the managed nonprofit.',
    fields: [
      { name: 'legal_name', type: 'STRING', mode: 'REQUIRED' },
      { name: 'state_of_incorporation', type: 'STRING', mode: 'REQUIRED' },
      { name: 'fiscal_year_end_month', type: 'INT64', mode: 'REQUIRED' },
      { name: 'fiscal_year_end_day', type: 'INT64', mode: 'REQUIRED' },
      { name: 'formation_date', type: 'DATE', mode: 'REQUIRED' },
      { name: 'mailing_address_line1', type: 'STRING', mode: 'REQUIRED' },
      { name: 'mailing_address_line2', type: 'STRING', mode: 'NULLABLE' },
      { name: 'mailing_address_city', type: 'STRING', mode: 'REQUIRED' },
      { name: 'mailing_address_region', type: 'STRING', mode: 'REQUIRED' },
      { name: 'mailing_address_postal_code', type: 'STRING', mode: 'REQUIRED' },
      { name: 'mailing_address_country', type: 'STRING', mode: 'REQUIRED' },
      { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    ],
  },
  {
    name: 'discovery_runs',
    description:
      'One row per Source.run() invocation. Captures payload (verbatim) on success or error metadata on failure.',
    fields: [
      { name: 'run_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'source_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'jurisdiction_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'status', type: 'STRING', mode: 'REQUIRED' },
      { name: 'started_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      { name: 'completed_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      { name: 'duration_ms', type: 'INT64', mode: 'REQUIRED' },
      { name: 'error_type', type: 'STRING', mode: 'NULLABLE' },
      { name: 'error_message', type: 'STRING', mode: 'NULLABLE' },
      { name: 'payload', type: 'JSON', mode: 'NULLABLE' },
    ],
  },
  {
    name: 'findings',
    description:
      'Typed findings derived from discovery runs, with severity and lifecycle.',
    fields: [
      { name: 'finding_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'jurisdiction_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'source_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'severity', type: 'STRING', mode: 'REQUIRED' },
      { name: 'status', type: 'STRING', mode: 'REQUIRED' },
      { name: 'title', type: 'STRING', mode: 'REQUIRED' },
      { name: 'detail', type: 'STRING', mode: 'REQUIRED' },
      { name: 'evidence', type: 'JSON', mode: 'REQUIRED' },
      { name: 'opened_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      { name: 'resolved_at', type: 'TIMESTAMP', mode: 'NULLABLE' },
    ],
  },
  {
    name: 'sources',
    description:
      'Registry snapshot of compliance sources known to the toolkit (audit trail).',
    fields: [
      { name: 'source_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'jurisdiction_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'kind', type: 'STRING', mode: 'REQUIRED' },
      { name: 'auth_required', type: 'BOOL', mode: 'REQUIRED' },
      { name: 'description', type: 'STRING', mode: 'REQUIRED' },
      { name: 'tos_url', type: 'STRING', mode: 'REQUIRED' },
      { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    ],
  },
] as const

/**
 * Row schema for the `entity` table — same shape as the underlying
 * EntitySchema in the types module.
 */
export const ComplianceEntityRowSchema = EntitySchema

export type ComplianceEntityRow = z.infer<typeof ComplianceEntityRowSchema>

/**
 * Row schema for the `discovery_runs` table.
 *
 * `payload` is `unknown` — sources can persist any JSON shape — but it must
 * be `null` when the run failed (no payload to record). Status/error
 * relationships are intentionally not coupled with refinements here so the
 * raw row data remains close to BigQuery's wire format.
 */
export const ComplianceDiscoveryRunRowSchema = z.object({
  run_id: z.string().uuid(),
  source_id: z.string().min(1),
  jurisdiction_id: z.string().min(1),
  status: z.enum(['succeeded', 'failed']),
  started_at: z.preprocess(extractTimestampValue, z.string().min(1)),
  completed_at: z.preprocess(extractTimestampValue, z.string().min(1)),
  duration_ms: z.coerce.number().int().nonnegative(),
  error_type: z.string().nullable(),
  error_message: z.string().nullable(),
  payload: z.unknown().nullable(),
})

export type ComplianceDiscoveryRunRow = z.infer<
  typeof ComplianceDiscoveryRunRowSchema
>

/**
 * Row schema for the `findings` table — the same shape as the underlying
 * FindingSchema in the types module.
 */
export const ComplianceFindingRowSchema = FindingSchema

export type ComplianceFindingRow = z.infer<typeof ComplianceFindingRowSchema>

/**
 * Row schema for the `sources` registry-snapshot table.
 */
export const ComplianceSourceRowSchema = z.object({
  source_id: z.string().min(1),
  jurisdiction_id: z.string().min(1),
  kind: SourceKindSchema,
  auth_required: z.boolean(),
  description: z.string().min(1),
  tos_url: z.string().url(),
  updated_at: z.preprocess(extractTimestampValue, z.string().min(1)),
})

export type ComplianceSourceRow = z.infer<typeof ComplianceSourceRowSchema>
