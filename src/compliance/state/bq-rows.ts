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
  SourceAccessMethodSchema,
  SourceFreshnessSchema,
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
 * One BigQuery view definition.
 */
export interface ComplianceViewDefinition {
  readonly name: string
  readonly description: string
  readonly query: string
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
      { name: 'access_url', type: 'STRING', mode: 'NULLABLE' },
      { name: 'access_method', type: 'STRING', mode: 'NULLABLE' },
      { name: 'automation_allowed', type: 'BOOL', mode: 'NULLABLE' },
      { name: 'manual_only_reason', type: 'STRING', mode: 'NULLABLE' },
      { name: 'source_freshness', type: 'JSON', mode: 'NULLABLE' },
      { name: 'tos_url', type: 'STRING', mode: 'REQUIRED' },
      { name: 'updated_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
    ],
  },
] as const

export const CURRENT_OPEN_FINDINGS_VIEW = 'current_open_findings'

/**
 * Query for the current-open-findings view.
 *
 * The raw `findings` table is append-only history. This view owns the
 * current-state contract by selecting the latest row for each semantic finding
 * key. It deliberately does not partition by `finding_id`, because source-level
 * findings can emit a fresh UUID on each run for the same underlying issue.
 */
export function currentOpenFindingsViewQuery(
  datasetRef: string = COMPLIANCE_DATASET,
): string {
  const findingsTable = `\`${datasetRef}.findings\``
  const runsTable = `\`${datasetRef}.discovery_runs\``
  return `
    WITH latest_runs AS (
      SELECT source_id, status, payload
      FROM (
        SELECT
          source_id,
          status,
          payload,
          ROW_NUMBER() OVER (
            PARTITION BY source_id
            ORDER BY completed_at DESC, started_at DESC, run_id DESC
          ) AS rn
        FROM ${runsTable}
      )
      WHERE rn = 1
    ),
    ranked_findings AS (
      SELECT
        f.*,
        ROW_NUMBER() OVER (
          PARTITION BY
            f.jurisdiction_id,
            f.source_id,
            COALESCE(JSON_VALUE(f.evidence, '$.code'), f.title)
          ORDER BY opened_at DESC, finding_id DESC
        ) AS rn
      FROM ${findingsTable} f
    )
    SELECT
      f.finding_id,
      f.jurisdiction_id,
      f.source_id,
      f.severity,
      f.status,
      f.title,
      f.detail,
      f.evidence,
      f.opened_at,
      f.resolved_at
    FROM ranked_findings f
    LEFT JOIN latest_runs r
      ON r.source_id = f.source_id
    WHERE f.rn = 1
      AND f.status = 'open'
      AND NOT COALESCE(
        (
          JSON_VALUE(f.evidence, '$.code') IN (
            'source.failed',
            'source.auth_required',
            'source.manual_required',
            'source.policy_blocked'
          )
          AND r.status = 'succeeded'
        )
        OR (
          f.source_id = 'ca-ftb-entity-status-letter'
          AND JSON_VALUE(f.evidence, '$.code') = 'ca.ftb.exempt_status_not_verified'
          AND r.status = 'succeeded'
          AND UPPER(TRIM(COALESCE(JSON_VALUE(r.payload, '$.exempt_status_verified'), ''))) IN (
            'YES',
            'TRUE',
            'VERIFIED',
            'EXEMPT',
            'EXEMPT STATUS VERIFIED'
          )
        )
        OR f.source_id = 'ca-ag-online-filing',
        FALSE
      )
  `
}

export const COMPLIANCE_VIEWS: readonly ComplianceViewDefinition[] = [
  {
    name: CURRENT_OPEN_FINDINGS_VIEW,
    description:
      'Latest open compliance findings derived from append-only finding history.',
    query: currentOpenFindingsViewQuery(),
  },
]

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
export const ComplianceSourceRowSchema = z
  .object({
    source_id: z.string().min(1),
    jurisdiction_id: z.string().min(1),
    kind: SourceKindSchema,
    auth_required: z.boolean(),
    description: z.string().min(1),
    access_url: z.string().url(),
    access_method: SourceAccessMethodSchema,
    automation_allowed: z.boolean(),
    manual_only_reason: z.string().min(1).nullable(),
    source_freshness: SourceFreshnessSchema.nullable(),
    tos_url: z.string().url(),
    updated_at: z.preprocess(extractTimestampValue, z.string().min(1)),
  })
  .refine((row) => row.automation_allowed || row.manual_only_reason !== null, {
    path: ['manual_only_reason'],
    message: 'manual_only_reason is required when automation is blocked',
  })
  .refine((row) => !row.automation_allowed || row.manual_only_reason === null, {
    path: ['manual_only_reason'],
    message: 'manual_only_reason must be null when automation is allowed',
  })

export type ComplianceSourceRow = z.infer<typeof ComplianceSourceRowSchema>
