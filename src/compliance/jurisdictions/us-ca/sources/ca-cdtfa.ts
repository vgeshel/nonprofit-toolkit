import { errAsync } from 'neverthrow'
import type { Source } from '../../../types/index.ts'

const CDTFA_ONLINE_SERVICES_URL = 'https://onlineservices.cdtfa.ca.gov/'
const CDTFA_TERMS_URL = 'https://www.cdtfa.ca.gov/use.htm'

export const caCdtfaPermitLicenseVerificationSource: Source = {
  id: 'ca-cdtfa-permit-license-verification',
  jurisdiction: 'us-ca',
  kind: 'manual',
  authRequired: false,
  description:
    'Manual CDTFA permit, license, or account verification for seller permits, cigarette/tobacco licenses, and eWaste accounts.',
  accessUrl: CDTFA_ONLINE_SERVICES_URL,
  accessMethod: 'manual',
  automationAllowed: false,
  manualOnlyReason:
    'CDTFA documents a public verification webpage, but Phase 3 has not identified a documented automated read-only request shape for that form. Capture typed evidence manually.',
  manualInstructions: [
    'Open CDTFA Online Services.',
    'Choose the option to verify a permit, license, or account.',
    'Search any configured seller permit, use-tax, special tax/fee, cigarette/tobacco, or eWaste account number.',
    'Record the account type, account number, verification result, displayed owner name, and status date if shown.',
  ],
  manualEvidenceFields: [
    { key: 'account_type', label: 'Account type', required: true },
    { key: 'account_number', label: 'Account number', required: true },
    {
      key: 'verification_status',
      label: 'Verification status',
      required: true,
    },
    { key: 'owner_name', label: 'Owner name', required: false },
    { key: 'status_date', label: 'Status date', required: false },
  ],
  tosUrl: CDTFA_TERMS_URL,
  run: () =>
    errAsync({
      type: 'tos',
      message:
        'CDTFA permit, license, or account verification is manual-only until a permitted automated read-only request shape is documented.',
    }),
}

export const caCdtfaOnlineServicesSource: Source = {
  id: 'ca-cdtfa-online-services',
  jurisdiction: 'us-ca',
  kind: 'playwright',
  authRequired: true,
  description:
    'User-assisted CDTFA Online Services read-only account standing review.',
  accessUrl: CDTFA_ONLINE_SERVICES_URL,
  accessMethod: 'playwright_readonly',
  automationAllowed: true,
  tosUrl: CDTFA_TERMS_URL,
  auth: {
    loginUrl: CDTFA_ONLINE_SERVICES_URL,
    credentialMode: 'user_entered_session',
    credentialFields: [
      {
        key: 'username',
        label: 'CDTFA username',
        required: true,
        secret: false,
      },
      {
        key: 'password',
        label: 'CDTFA password',
        required: true,
        secret: true,
      },
    ],
    mfa: 'user_assisted',
    instructions: [
      'Use an authorized owner, employee, or delegated account with the narrowest access available for viewing account information.',
      'Sign in to CDTFA Online Services and complete MFA yourself.',
      'Open the relevant account overview without starting returns, payments, registration, closure, relief, extension, appeal, or access-management flows.',
      'Record the visible account status, permit/license/account types, filing obligations, notices, and reviewed-at date.',
    ],
    evidenceFields: [
      {
        key: 'cdtfa_accounts_present',
        label: 'Whether any CDTFA-managed account is present',
        required: true,
      },
      {
        key: 'account_statuses',
        label: 'Account statuses shown in Online Services',
        required: true,
      },
      {
        key: 'open_filing_obligations',
        label: 'Open filing obligations or none shown',
        required: false,
      },
      {
        key: 'notices_or_billings',
        label: 'Notices or billings shown, if any',
        required: false,
      },
      { key: 'reviewed_at', label: 'Reviewed-at date', required: true },
    ],
    forbiddenActions: [
      'Do not file returns or reports.',
      'Do not make payments or prepayments.',
      'Do not register, renew, close, or modify any permit, license, account, or location.',
      'Do not request relief, payment plans, filing extensions, appeals, or power of attorney.',
      'Do not add, remove, or change portal users, delegates, secondary logons, or access levels.',
      'Do not upload documents or submit forms.',
    ],
  },
  run: () =>
    errAsync({
      type: 'tos',
      message:
        'CDTFA Online Services requires a user-assisted authenticated session before read-only discovery can run.',
    }),
}
