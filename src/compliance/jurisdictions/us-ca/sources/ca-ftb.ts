import { errAsync } from 'neverthrow'
import type { Source } from '../../../types/index.ts'

const ACCESS_URL = 'https://webapp.ftb.ca.gov/eletter/'
const TERMS_URL =
  'https://www.ftb.ca.gov/help/business/entity-status-letter.asp'

export const caFtbEntityStatusLetterSource: Source = {
  id: 'ca-ftb-entity-status-letter',
  jurisdiction: 'us-ca',
  kind: 'manual',
  authRequired: false,
  description:
    'Manual California Franchise Tax Board Entity Status Letter verification.',
  accessUrl: ACCESS_URL,
  accessMethod: 'manual',
  automationAllowed: false,
  manualOnlyReason:
    'Phase 2 treats the FTB Entity Status Letter form as manual pending a narrower source-policy review for automated read-only form use.',
  manualInstructions: [
    'Open the FTB Entity Status Letter lookup.',
    'Search by FTB entity id if configured; otherwise search by exact legal name.',
    'Record whether the entity is in good standing with FTB and whether exempt status is verified.',
  ],
  manualEvidenceFields: [
    { key: 'ftb_status', label: 'FTB status', required: true },
    {
      key: 'exempt_status_verified',
      label: 'Exempt status verified',
      required: false,
    },
    { key: 'letter_date', label: 'Letter date', required: false },
  ],
  tosUrl: TERMS_URL,
  run: () =>
    errAsync({
      type: 'tos',
      message:
        'CA FTB Entity Status Letter is manual-only until automated read-only form use is approved.',
    }),
}
