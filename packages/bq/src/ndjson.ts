/**
 * NDJSON (Newline Delimited JSON) utilities.
 *
 * Converts donation events to NDJSON format for BigQuery loading.
 */
import type { DonationEvent } from '@donations-etl/types'

/**
 * Convert a single donation event to an NDJSON line.
 *
 * Transforms the event to match BigQuery schema:
 * - Converts event_ts, created_at, ingested_at to ISO strings
 * - Serializes donor_address and source_metadata as JSON
 */
export function eventToNdjsonLine(event: DonationEvent): string {
  // BigQuery expects ISO timestamp strings
  const record = {
    run_id: event.run_id,
    source: event.source,
    external_id: event.external_id,
    event_ts: event.event_ts,
    created_at: event.created_at,
    ingested_at: event.ingested_at,
    amount_cents: event.amount_cents,
    fee_cents: event.fee_cents,
    net_amount_cents: event.net_amount_cents,
    currency: event.currency,
    donor_name: event.donor_name,
    payer_name: event.payer_name,
    donor_email: event.donor_email,
    donor_phone: event.donor_phone,
    donor_address: event.donor_address,
    status: event.status,
    payment_method: event.payment_method,
    description: event.description,
    attribution: event.attribution,
    attribution_human: event.attribution_human,
    source_metadata: event.source_metadata,
  }

  return JSON.stringify(record)
}

/**
 * Convert multiple donation events to NDJSON string.
 *
 * Returns newline-delimited JSON with each event on its own line.
 */
export function eventsToNdjson(events: DonationEvent[]): string {
  return events.map(eventToNdjsonLine).join('\n')
}

/**
 * Split events into chunks for parallel processing.
 *
 * @param events Events to split
 * @param chunkSize Maximum events per chunk
 * @returns Array of event chunks
 */
export function chunkEvents(
  events: DonationEvent[],
  chunkSize: number,
): DonationEvent[][] {
  const chunks: DonationEvent[][] = []

  for (let i = 0; i < events.length; i += chunkSize) {
    chunks.push(events.slice(i, i + chunkSize))
  }

  return chunks
}

/**
 * Generate a GCS path for a run's data.
 *
 * Format: runs/{runId}/source={source}/[chunk-{chunkPrefix}-]part-{index}.ndjson
 *
 * @param runId Unique run identifier
 * @param source Source name (mercury, paypal, givebutter, patreon, etc.)
 * @param index Part index within this write operation
 * @param chunkPrefix Optional prefix to differentiate date chunks
 */
export function generateGcsPath(
  runId: string,
  source: string,
  index: number,
  chunkPrefix?: string,
): string {
  const partName = chunkPrefix
    ? `chunk-${chunkPrefix}-part-${index.toString().padStart(5, '0')}`
    : `part-${index.toString().padStart(5, '0')}`
  return `runs/${runId}/source=${source}/${partName}.ndjson`
}

/**
 * Generate a full GCS URI.
 */
export function generateGcsUri(bucket: string, path: string): string {
  return `gs://${bucket}/${path}`
}

/**
 * Generate a GCS wildcard pattern for loading all parts.
 *
 * Format: gs://{bucket}/runs/{runId}/source={source}/*.ndjson
 */
export function generateGcsPattern(
  bucket: string,
  runId: string,
  source: string,
): string {
  return `gs://${bucket}/runs/${runId}/source=${source}/*.ndjson`
}
