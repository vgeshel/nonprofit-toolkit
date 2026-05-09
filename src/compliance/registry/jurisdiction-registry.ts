/**
 * Jurisdiction registry.
 *
 * Phase 1 keeps the registry simple: an in-memory store with `register`,
 * `get`, and `list`. Adding jurisdictions in later phases is a call to
 * `register` from a startup wiring point — there is no auto-discovery, by
 * design, so the wiring is explicit and grep-able.
 *
 * The store is a plain array (not a Map) because (a) the number of
 * jurisdictions is in the single digits and a linear scan is cheaper than a
 * Map's machinery, and (b) keeping a single source of truth removes the
 * "Map and array out of sync" failure mode entirely.
 */
import type { Result } from 'neverthrow'
import { err, ok } from 'neverthrow'
import {
  JurisdictionIdSchema,
  SourceMetadataSchema,
  type Jurisdiction,
  type Source,
} from '../types/index.ts'

/**
 * Failure modes when interacting with the registry.
 */
export type RegistryError =
  | { type: 'duplicate'; id: string; message: string }
  | { type: 'not_found'; id: string; message: string }
  | { type: 'invalid_id'; id: string; message: string }
  | { type: 'invalid_source'; id: string; message: string }

/**
 * Registry interface — exposed so callers can pass it around without depending
 * on the concrete implementation.
 */
export interface JurisdictionRegistry {
  register(jurisdiction: Jurisdiction): Result<Jurisdiction, RegistryError>
  get(id: string): Result<Jurisdiction, RegistryError>
  list(): readonly Jurisdiction[]
}

/**
 * Construct an empty registry.
 */
export function createJurisdictionRegistry(): JurisdictionRegistry {
  const entries: Jurisdiction[] = []

  return {
    register(jurisdiction) {
      const idCheck = JurisdictionIdSchema.safeParse(jurisdiction.id)
      if (!idCheck.success) {
        return err({
          type: 'invalid_id',
          id: jurisdiction.id,
          message: `Invalid jurisdiction id: ${jurisdiction.id}`,
        })
      }

      const id = idCheck.data
      if (entries.some((j) => j.id === id)) {
        return err({
          type: 'duplicate',
          id,
          message: `Jurisdiction already registered: ${id}`,
        })
      }

      for (const source of jurisdiction.sources) {
        const sourceValidation = validateSourceMetadata(source)
        if (sourceValidation.isErr()) {
          return err(sourceValidation.error)
        }
      }

      entries.push(jurisdiction)
      return ok(jurisdiction)
    },

    get(id) {
      const idCheck = JurisdictionIdSchema.safeParse(id)
      if (!idCheck.success) {
        return err({
          type: 'invalid_id',
          id,
          message: `Invalid jurisdiction id: ${id}`,
        })
      }
      const found = entries.find((j) => j.id === idCheck.data)
      if (found === undefined) {
        return err({
          type: 'not_found',
          id: idCheck.data,
          message: `Jurisdiction not registered: ${idCheck.data}`,
        })
      }
      return ok(found)
    },

    list() {
      return entries.slice()
    },
  }
}

function validateSourceMetadata(source: Source): Result<Source, RegistryError> {
  const parsed = SourceMetadataSchema.safeParse(source)
  if (!parsed.success) {
    return err({
      type: 'invalid_source',
      id: source.id,
      message: `Invalid source metadata for ${source.id}: ${parsed.error.issues
        .map(formatIssuePath)
        .join('; ')}`,
    })
  }
  return ok(source)
}

function formatIssuePath(issue: {
  readonly path: readonly PropertyKey[]
}): string {
  return issue.path.map(String).join('.')
}
