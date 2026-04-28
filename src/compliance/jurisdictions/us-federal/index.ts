/**
 * `us-federal` jurisdiction module.
 *
 * Phase 1 wires the IRS TEOS source; deadline rules and forms arrive in
 * later phases. The exported `entityIdSchema` is the same Zod object the
 * onboarding skill consumes when prompting for an EIN.
 */
import { z } from 'zod'
import type { Jurisdiction } from '../../types/index.ts'
import { irsTeosSource } from './sources/irs-teos.ts'

const UsFederalEntityIdSchema = z.object({
  ein: z
    .string()
    .regex(
      /^\d{2}-?\d{7}$/,
      'EIN must be 9 digits with optional dash (NN-NNNNNNN)',
    ),
})

export type UsFederalEntityId = z.infer<typeof UsFederalEntityIdSchema>

export const usFederalJurisdiction: Jurisdiction = {
  id: 'us-federal',
  entityIdSchema: UsFederalEntityIdSchema,
  sources: [irsTeosSource],
  deadlineRules: [],
  forms: [],
}
