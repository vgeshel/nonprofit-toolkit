/**
 * `compliance.sources` accessor.
 *
 * Persists a registry snapshot of all sources known to the toolkit. Each row
 * records what the source claims about itself (id, kind, ToS url, etc.).
 * Rows are merged on `source_id` so re-running onboarding is idempotent.
 *
 * The persisted columns intentionally exclude the `run` function — only the
 * declarative metadata is stored.
 */
import { ResultAsync, errAsync, okAsync } from 'neverthrow'
import type { Source } from '../types/index.ts'
import type { BqQueryRunner, QueryParam } from './bq-entity.ts'
import { COMPLIANCE_DATASET, ComplianceSourceRowSchema } from './bq-rows.ts'

/**
 * Errors emitted by the sources accessor.
 */
export type SourcesAccessorError =
  | { type: 'query'; message: string }
  | { type: 'validation'; message: string }

/**
 * Wiring.
 */
export interface SourcesAccessorDeps {
  readonly runner: BqQueryRunner
  readonly projectId: string
  readonly now: () => Date
}

/**
 * Accessor surface.
 */
export interface SourcesAccessor {
  upsertSources(
    sources: readonly Source[],
  ): ResultAsync<void, SourcesAccessorError>
}

/**
 * Construct an accessor.
 */
export function createSourcesAccessor(
  deps: SourcesAccessorDeps,
): SourcesAccessor {
  const tableName = `\`${deps.projectId}.${COMPLIANCE_DATASET}.sources\``

  return {
    upsertSources(sources) {
      if (sources.length === 0) {
        return okAsync(undefined)
      }

      // Validate each source's metadata up-front so we don't issue a partial
      // batch on a bad row.
      const updatedAt = deps.now().toISOString()
      const rows: Record<string, QueryParam>[] = []
      for (const s of sources) {
        const row = {
          source_id: s.id,
          jurisdiction_id: s.jurisdiction,
          kind: s.kind,
          auth_required: s.authRequired,
          description: s.description,
          tos_url: s.tosUrl,
          updated_at: updatedAt,
        }
        const validation = ComplianceSourceRowSchema.safeParse(row)
        if (!validation.success) {
          return errAsync<void, SourcesAccessorError>({
            type: 'validation',
            message: validation.error.message,
          })
        }
        rows.push({ ...row })
      }

      const sql = `
        MERGE ${tableName} T
        USING (
          SELECT
            @source_id AS source_id,
            @jurisdiction_id AS jurisdiction_id,
            @kind AS kind,
            @auth_required AS auth_required,
            @description AS description,
            @tos_url AS tos_url,
            @updated_at AS updated_at
        ) S
        ON T.source_id = S.source_id
        WHEN MATCHED THEN UPDATE SET
          jurisdiction_id = S.jurisdiction_id,
          kind = S.kind,
          auth_required = S.auth_required,
          description = S.description,
          tos_url = S.tos_url,
          updated_at = S.updated_at
        WHEN NOT MATCHED THEN INSERT (
          source_id,
          jurisdiction_id,
          kind,
          auth_required,
          description,
          tos_url,
          updated_at
        ) VALUES (
          S.source_id,
          S.jurisdiction_id,
          S.kind,
          S.auth_required,
          S.description,
          S.tos_url,
          S.updated_at
        )
      `

      const merges: ResultAsync<void, SourcesAccessorError>[] = rows.map(
        (params) =>
          deps.runner
            .query(sql, params)
            .mapErr<SourcesAccessorError>((err) => ({
              type: 'query',
              message: err.message,
            }))
            .map(() => undefined),
      )

      return ResultAsync.combine(merges).map(() => undefined)
    },
  }
}
