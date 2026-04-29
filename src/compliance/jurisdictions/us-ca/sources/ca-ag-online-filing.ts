import { errAsync } from 'neverthrow'
import type { Source } from '../../../types/index.ts'

const CA_AG_ONLINE_FILING_URL = 'https://rct.doj.ca.gov/'
const CA_AG_TERMS_URL = 'https://oag.ca.gov/privacy'

export const caAgOnlineFilingSource: Source = {
  id: 'ca-ag-online-filing',
  jurisdiction: 'us-ca',
  kind: 'playwright',
  authRequired: true,
  description:
    'User-assisted CA AG Registry Online Filing Service dashboard review.',
  accessUrl: CA_AG_ONLINE_FILING_URL,
  accessMethod: 'playwright_readonly',
  automationAllowed: true,
  tosUrl: CA_AG_TERMS_URL,
  auth: {
    loginUrl: CA_AG_ONLINE_FILING_URL,
    credentialMode: 'user_entered_session',
    credentialFields: [
      {
        key: 'username',
        label: 'CA AG Registry Online Filing username',
        required: true,
        secret: false,
      },
    ],
    mfa: 'user_assisted',
    instructions: [
      'Sign in to the CA AG Registry Online Filing Service using an authorized account.',
      'Open the charity dashboard for the configured charity registration number.',
      'Review filing status, deficiency messages, renewal status, and correspondence without creating, editing, submitting, or paying for any filing.',
      'Record the visible dashboard status and reviewed-at date.',
    ],
    evidenceFields: [
      {
        key: 'online_filing_access',
        label: 'Whether Online Filing Service access is available',
        required: true,
      },
      {
        key: 'dashboard_status',
        label: 'Dashboard status or unavailable reason',
        required: true,
      },
      {
        key: 'latest_submission_status',
        label: 'Latest submission status',
        required: false,
      },
      {
        key: 'deficiency_or_correspondence',
        label: 'Deficiency/correspondence messages or none shown',
        required: false,
      },
      { key: 'reviewed_at', label: 'Reviewed-at date', required: true },
    ],
    forbiddenActions: [
      'Do not create, edit, certify, submit, or withdraw filings.',
      'Do not pay fees.',
      'Do not upload documents.',
      'Do not change registrant profile, contact, account, or access information.',
      'Do not send correspondence or respond to deficiency notices from the portal.',
    ],
  },
  run: () =>
    errAsync({
      type: 'tos',
      message:
        'CA AG Online Filing Service requires a user-assisted authenticated session before read-only discovery can run.',
    }),
}
