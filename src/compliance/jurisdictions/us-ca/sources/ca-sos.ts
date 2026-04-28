import { errAsync } from 'neverthrow'
import type { Source } from '../../../types/index.ts'

const TERMS_URL =
  'https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use'

export const caSosBizfileSource: Source = {
  id: 'ca-sos-bizfile',
  jurisdiction: 'us-ca',
  kind: 'manual',
  authRequired: false,
  description:
    'Manual California Secretary of State bizfile business-status verification.',
  accessUrl: 'https://bizfileonline.sos.ca.gov/search/business',
  accessMethod: 'manual',
  automationAllowed: false,
  manualOnlyReason:
    'California Secretary of State bizfile terms prohibit page-scrape, robot, spider, or similar automated collection methods.',
  manualInstructions: [
    'Open the California Secretary of State bizfile business search.',
    'Search for the exact SOS entity number configured for this nonprofit.',
    'Record the displayed entity status, entity name, jurisdiction, and status date if shown.',
  ],
  manualEvidenceFields: [
    { key: 'entity_status', label: 'Entity status', required: true },
    { key: 'entity_name', label: 'Entity name', required: true },
    { key: 'jurisdiction', label: 'Jurisdiction', required: false },
    { key: 'status_date', label: 'Status date', required: false },
  ],
  tosUrl: TERMS_URL,
  run: () =>
    errAsync({
      type: 'tos',
      message:
        'CA SOS bizfile is manual-only under current source-policy review.',
    }),
}
