import { errAsync } from 'neverthrow'
import type { Source } from '../../../types/index.ts'

const MYFTB_URL = 'https://www.ftb.ca.gov/myftb/'
const MYFTB_TERMS_URL =
  'https://www.ftb.ca.gov/myftb/general-terms-and-conditions.html'

export const caFtbMyFtbSource: Source = {
  id: 'ca-ftb-myftb',
  jurisdiction: 'us-ca',
  kind: 'playwright',
  authRequired: true,
  description: 'User-assisted MyFTB read-only business account review.',
  accessUrl: MYFTB_URL,
  accessMethod: 'playwright_readonly',
  automationAllowed: true,
  tosUrl: MYFTB_TERMS_URL,
  auth: {
    loginUrl: MYFTB_URL,
    credentialMode: 'user_entered_session',
    credentialFields: [
      {
        key: 'username',
        label: 'MyFTB username',
        required: true,
        secret: false,
      },
    ],
    mfa: 'user_assisted',
    instructions: [
      'Use only an individual MyFTB account that belongs to an authorized business representative; do not share a password with the agent.',
      'Sign in to MyFTB and complete MFA yourself.',
      'Open the business account overview and review status, messages, notices, and exempt-organization context without starting transactions.',
      'Record the visible status and any action-required messages.',
    ],
    evidenceFields: [
      {
        key: 'business_account_access',
        label: 'Whether authorized business account access is available',
        required: true,
      },
      {
        key: 'ftb_account_status',
        label: 'FTB account status',
        required: true,
      },
      {
        key: 'action_required_messages',
        label: 'Action-required messages or none shown',
        required: false,
      },
      { key: 'reviewed_at', label: 'Reviewed-at date', required: true },
    ],
    forbiddenActions: [
      'Do not share or store a MyFTB password.',
      'Do not file returns or submit forms.',
      'Do not make payments.',
      'Do not upload attachments.',
      'Do not update account, address, representative, or access information.',
      'Do not send messages, request relief, protest, appeal, or otherwise transact with FTB.',
    ],
  },
  run: () =>
    errAsync({
      type: 'tos',
      message:
        'MyFTB requires a user-assisted authenticated session owned by an authorized representative before read-only discovery can run.',
    }),
}
