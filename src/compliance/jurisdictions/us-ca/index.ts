import { z } from 'zod'
import type { Jurisdiction } from '../../types/index.ts'
import { caAgOnlineFilingSource } from './sources/ca-ag-online-filing.ts'
import { caAgRegistrySource } from './sources/ca-ag-registry.ts'
import {
  caCdtfaOnlineServicesSource,
  caCdtfaPermitLicenseVerificationSource,
} from './sources/ca-cdtfa.ts'
import { caFtbMyFtbSource } from './sources/ca-ftb-myftb.ts'
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
  cdtfaSellerPermitNumber: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/, 'CA CDTFA seller permit must be alphanumeric')
    .optional(),
  cdtfaUseTaxAccountNumber: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/, 'CA CDTFA use-tax account must be alphanumeric')
    .optional(),
  cdtfaSpecialTaxAccountNumber: z
    .string()
    .min(1)
    .regex(
      /^[A-Za-z0-9-]+$/,
      'CA CDTFA special tax or fee account must be alphanumeric',
    )
    .optional(),
})

export type UsCaEntityId = z.infer<typeof UsCaEntityIdSchema>

export const usCaJurisdiction: Jurisdiction = {
  id: 'us-ca',
  entityIdSchema: UsCaEntityIdSchema,
  sources: [
    caSosBizfileSource,
    caAgRegistrySource,
    caAgOnlineFilingSource,
    caFtbEntityStatusLetterSource,
    caFtbMyFtbSource,
    caCdtfaPermitLicenseVerificationSource,
    caCdtfaOnlineServicesSource,
  ],
  deadlineRules: [],
  forms: [],
}
