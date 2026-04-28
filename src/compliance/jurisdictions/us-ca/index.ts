import { z } from 'zod'
import type { Jurisdiction } from '../../types/index.ts'
import { caAgRegistrySource } from './sources/ca-ag-registry.ts'
import { caFtbEntityStatusLetterSource } from './sources/ca-ftb.ts'
import { caSosBizfileSource } from './sources/ca-sos.ts'

const UsCaEntityIdSchema = z.object({
  sosEntityNumber: z
    .string()
    .regex(
      /^(?:C\d{7}|\d{7,12}|B[A-Za-z0-9]{11})$/,
      'CA SOS entity number must be C + 7 digits, 7-12 digits, or a 12-character B-prefixed id',
    ),
  agCharityNumber: z
    .string()
    .regex(
      /^(?:CT\d{6,7}|\d{6})$/,
      'CA AG charity number must be CT + digits or an older six-digit number',
    )
    .optional(),
  ftbEntityId: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/, 'CA FTB entity id must be alphanumeric')
    .optional(),
  ftbEntityName: z.string().min(1).optional(),
})

export type UsCaEntityId = z.infer<typeof UsCaEntityIdSchema>

export const usCaJurisdiction: Jurisdiction = {
  id: 'us-ca',
  entityIdSchema: UsCaEntityIdSchema,
  sources: [
    caSosBizfileSource,
    caAgRegistrySource,
    caFtbEntityStatusLetterSource,
  ],
  deadlineRules: [],
  forms: [],
}
