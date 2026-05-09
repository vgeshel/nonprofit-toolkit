import { errAsync } from 'neverthrow'
import type { Source } from '../../../types/index.ts'

const CA_AG_ONLINE_RENEWAL_LOGIN_URL = 'https://rct.doj.ca.gov/eGov/Home.aspx'
const CA_AG_REGISTRY_SEARCH_URL =
  'https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y'
const CA_AG_TERMS_URL = 'https://oag.ca.gov/privacy'

export const caAgOnlineFilingSource: Source = {
  id: 'ca-ag-online-filing',
  jurisdiction: 'us-ca',
  kind: 'playwright',
  authRequired: true,
  description:
    'Optional CA AG Registry Online Renewal System dashboard review.',
  accessUrl: CA_AG_ONLINE_RENEWAL_LOGIN_URL,
  accessMethod: 'playwright_readonly',
  automationAllowed: true,
  tosUrl: CA_AG_TERMS_URL,
  auth: {
    loginUrl: CA_AG_ONLINE_RENEWAL_LOGIN_URL,
    credentialMode: 'user_entered_session',
    credentialFields: [
      {
        key: 'username',
        label: 'CA AG Registry Online Renewal System username',
        required: true,
        secret: false,
      },
    ],
    mfa: 'user_assisted',
    instructions: [
      `CA AG public charity status, registration number, renewal due date, and annual renewal details are already checked automatically from the public Registry Search Tool at ${CA_AG_REGISTRY_SEARCH_URL}.`,
      'Use the CA AG Registry Online Renewal System only for optional dashboard-only details the public Registry Search Tool cannot answer.',
      'Sign in using an authorized account with a User ID and Password, Account Code, or Registration Code.',
      'Open the renewal account for the configured charity registration number.',
      'Review filing status, deficiency messages, renewal status, and correspondence without creating, editing, submitting, or paying for any filing.',
      'Record the visible dashboard status and reviewed-at date.',
    ],
    evidenceFields: [
      {
        key: 'online_filing_access',
        label: 'Whether Online Renewal System access is available',
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
        'CA AG Online Renewal System requires a user-assisted authenticated session for optional dashboard-only review.',
    }),
}
