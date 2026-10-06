/**
 * Every column in the DDL must be carried by each layer that moves an event:
 * the NDJSON writer, the staging load schema, and both halves of the MERGE.
 *
 * A column missing from the MERGE's UPDATE list fails silently — re-running a
 * backfill reports success while leaving the column untouched on existing
 * rows — so these tests derive the expected columns from schema.sql rather
 * than from a hand-maintained list.
 */
import type { DonationEvent } from '@donations-etl/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { STG_EVENTS_LOAD_FIELDS } from '../src/client'
import { eventToNdjsonLine } from '../src/ndjson'
import { generateMergeSql } from '../src/sql'

const srcDir = join(__dirname, '..', 'src')
const schemaSql = readFileSync(join(srcDir, 'schema.sql'), 'utf8')

/**
 * Column names, in order, of a CREATE TABLE statement in schema.sql.
 */
function tableColumns(table: string): string[] {
  const start = schemaSql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`)
  expect(start).toBeGreaterThanOrEqual(0)
  const body = schemaSql.slice(start, schemaSql.indexOf('\n)', start))
  return body
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'))
    .map((line) => line.split(/\s+/)[0] ?? '')
}

function splitList(list: string): string[] {
  return list
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

const mergeSql = generateMergeSql({
  projectId: 'test-project',
  datasetRaw: 'donations_raw',
  datasetCanon: 'donations',
})

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

const canonColumns = tableColumns('donations.events')
const stgColumns = tableColumns('donations_raw.stg_events')
// Columns the database fills itself.
const canonDataColumns = canonColumns.filter(
  (c) => c !== '_inserted_at' && c !== '_updated_at',
)
const stgDataColumns = stgColumns.filter((c) => c !== '_loaded_at')

describe('schema.sql', () => {
  it('declares is_recurring as a nullable BOOL on both event tables', () => {
    expect(schemaSql).toMatch(
      /CREATE TABLE IF NOT EXISTS donations_raw\.stg_events \([^;]*\n {2}is_recurring BOOL,\n/,
    )
    expect(schemaSql).toMatch(
      /CREATE TABLE IF NOT EXISTS donations\.events \([^;]*\n {2}is_recurring BOOL,\n/,
    )
  })

  it('keeps the canonical and staging data columns identical', () => {
    expect(stgDataColumns).toEqual(['run_id', ...canonDataColumns])
  })
})

describe('migration 003', () => {
  const migration = readFileSync(
    join(srcDir, 'migrations', '003_add_is_recurring.sql'),
    'utf8',
  )

  it('adds is_recurring to staging and canonical idempotently', () => {
    expect(migration).toContain(
      'ALTER TABLE donations_raw.stg_events\nADD COLUMN IF NOT EXISTS is_recurring BOOL;',
    )
    expect(migration).toContain(
      'ALTER TABLE donations.events\nADD COLUMN IF NOT EXISTS is_recurring BOOL;',
    )
  })
})

describe('migration 004', () => {
  const migration = readFileSync(
    join(srcDir, 'migrations', '004_backfill_is_recurring.sql'),
    'utf8',
  )
  const updates = migration
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes('UPDATE'))

  it('backfills each source with a signal exactly once, in the canonical table', () => {
    expect(updates.map((u) => /source = '(\w+)'/.exec(u)?.[1])).toEqual([
      'benevity',
      'funraise',
      'paypal',
      'patreon',
    ])
    for (const update of updates) {
      expect(update).toContain('UPDATE donations.events')
    }
  })

  it('only fills rows that are still NULL, so re-running is a no-op', () => {
    for (const update of updates) {
      expect(update).toContain('AND is_recurring IS NULL')
    }
  })

  it('leaves alone the no-signal sources and Givebutter, which needs a re-fetch', () => {
    for (const source of [
      'givebutter',
      'mercury',
      'wise',
      'venmo',
      'check_deposits',
    ]) {
      expect(migration).not.toContain(`source = '${source}'`)
    }
  })
})

describe('generateMergeSql column coverage', () => {
  it('updates every data column except the MERGE key', () => {
    const assignments = splitList(
      between(mergeSql, 'WHEN MATCHED THEN UPDATE SET', 'WHEN NOT MATCHED'),
    )
    const expected = canonDataColumns
      .filter((c) => c !== 'source' && c !== 'external_id')
      .map((c) => `${c} = source.${c}`)

    expect(assignments).toEqual([
      ...expected,
      '_updated_at = CURRENT_TIMESTAMP()',
    ])
  })

  it('inserts every data column with its matching value', () => {
    const insertColumns = splitList(
      between(mergeSql, 'WHEN NOT MATCHED THEN INSERT (', ') VALUES ('),
    )
    const insertValues = splitList(
      mergeSql.slice(mergeSql.indexOf(') VALUES (') + ') VALUES ('.length, -1),
    )

    expect(insertColumns).toEqual(canonDataColumns)
    expect(insertValues).toEqual(canonDataColumns.map((c) => `source.${c}`))
  })
})

describe('staging load schema', () => {
  it('lists exactly the staging data columns', () => {
    expect(STG_EVENTS_LOAD_FIELDS.map((f) => f.name)).toEqual(stgDataColumns)
  })

  it('loads is_recurring as a nullable BOOL', () => {
    expect(
      STG_EVENTS_LOAD_FIELDS.find((f) => f.name === 'is_recurring'),
    ).toEqual({ name: 'is_recurring', type: 'BOOL' })
  })
})

describe('eventToNdjsonLine column coverage', () => {
  const event: DonationEvent = {
    source: 'givebutter',
    external_id: 'gb_1',
    event_ts: '2024-01-15T10:30:00Z',
    created_at: '2024-01-15T10:30:00Z',
    ingested_at: '2024-01-15T10:35:00Z',
    amount_cents: 2500,
    fee_cents: 0,
    net_amount_cents: 2500,
    currency: 'USD',
    donor_name: 'Jane Doe',
    payer_name: null,
    donor_email: 'jane@example.com',
    donor_phone: null,
    donor_address: null,
    status: 'succeeded',
    payment_method: 'credit_card',
    description: null,
    attribution: null,
    attribution_human: null,
    is_recurring: true,
    source_metadata: { plan_id: 'plan_9' },
    run_id: '550e8400-e29b-41d4-a716-446655440000',
  }

  it('writes exactly the staging data columns', () => {
    const record: unknown = JSON.parse(eventToNdjsonLine(event))
    expect(Object.keys(record ?? {}).sort()).toEqual([...stgDataColumns].sort())
  })

  it('carries is_recurring through unchanged', () => {
    expect(eventToNdjsonLine(event)).toContain('"is_recurring":true')
    expect(eventToNdjsonLine({ ...event, is_recurring: null })).toContain(
      '"is_recurring":null',
    )
  })
})
