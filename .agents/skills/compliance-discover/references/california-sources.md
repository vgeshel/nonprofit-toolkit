# California Compliance Sources

Load this file when discussing California compliance discovery, interpreting California
source results, or explaining why a California source is manual or automated.

## CA AG Registry Search Tool

Source id: `us-ca/ca-ag-registry`

- Access method: official public Registry Search Tool and public detail page.
- Official URL: `https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y`
- Primary data: Registry status, RCT registration number, FEIN, city/state, renewal due
  date, issue/effective dates, last renewal date, mailing address, annual renewal rows,
  and bounded text evidence from the public detail page.
- Current use: the code fetches the search form, submits the best available configured
  value itself (FEIN first, then AG charity number, then SOS/FTB number, then exact legal
  name), follows the public details link, and records the result. Do not ask the user to
  search this page manually unless the source fails.
- User-facing note: successful CA AG output is a California charity-registration signal;
  it is not a substitute for CA SOS corporate status or CA FTB tax status.

## CA AG Online Renewal System

Source id: `us-ca/ca-ag-online-filing`

- Access method: user-assisted authenticated read-only session.
- Why authenticated: the CA AG Online Renewal System requires an authorized user account
  before the renewal dashboard can be reviewed. Public Registry Search Tool results are
  fetched automatically before this source is considered.
- Default status behavior: this is an optional dashboard-only supplement. Do not include
  it in the normal manual/authenticated walkthrough, do not treat its auth-required state
  as an open compliance item, and do not ask the user to open it unless they explicitly
  ask for renewal-dashboard-only details that the public Registry Search Tool cannot
  answer.
- Official login URL: `https://rct.doj.ca.gov/eGov/Home.aspx`
- Public Registry Search Tool URL:
  `https://rct.doj.ca.gov/Verification/Web/Search.aspx?facility=Y`
- Official renewal information URL: `https://oag.ca.gov/charities/renewals`
- Eligibility: use this login only when the stored CA AG public status is Current or
  Current - Awaiting Reporting and an authorized agent has a User ID and Password, Account
  Code, or Registration Code.
- Rollout note: the newer CA AG Online Filing Service is currently limited to new
  registrations in the official guidance. Existing registrants continue to use the Online
  Renewal System until the broader 2026 rollout replaces existing systems.
- Terms/reference URL: `https://oag.ca.gov/privacy`

Evidence fields:

- `online_filing_access` (required): Whether Online Renewal System access is available
- `dashboard_status` (required): Dashboard status or unavailable reason
- `latest_submission_status` (optional): Latest submission status
- `deficiency_or_correspondence` (optional): Deficiency/correspondence messages or none
  shown
- `reviewed_at` (required): Reviewed-at date

Forbidden actions:

- Do not create, edit, certify, submit, or withdraw filings.
- Do not pay fees.
- Do not upload documents.
- Do not change registrant profile, contact, account, or access information.
- Do not send correspondence or respond to deficiency notices from the portal.

User-facing walkthrough: public CA AG charity status and renewal details are checked
automatically from the public Registry Search Tool, so there is normally no CA AG manual
step. Only if the user explicitly asks for dashboard-only renewal details, give the
official renewal login URL, the eligibility caveat, and the configured AG charity
registration number if present. If no AG charity number is configured, give the exact
legal name from onboarding. Ask for plain-language status details; do not ask the user to
type the field keys above.

## CA SOS bizfile

Source id: `us-ca/ca-sos-bizfile`

- Access method: automated public browser check. No authentication is required.
- Official URL: `https://bizfileonline.sos.ca.gov/search/business`
- Terms URL:
  `https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use`

Automated behavior:

1. Open the public California Secretary of State bizfile business search in Chromium.
2. Search by configured SOS entity number, removing a legacy leading `C` when needed
   because bizfile tells users to search corporation numbers without that prefix.
3. If no SOS number is configured, search by exact legal entity name.
4. Record entity name, SOS entity number, initial filing date, status, entity type,
   formed-in jurisdiction, agent, standing when shown, and structured public-row evidence.

Finding behavior:

- If the source returns no matching row, treat that as an open CA SOS issue.
- If the source returns a status other than `Active`, treat that as an open CA SOS issue.
- If the source legal name differs from the onboarded legal name, treat that as a
  cross-source legal-name mismatch.

User-facing guidance: do not ask the user to re-check this page manually. Run
`compliance-discover` to refresh it. If the latest result is missing, non-active, or has
the wrong name/number, guide the user to correct the record with CA SOS or the registered
agent, then rerun discovery.

## CA FTB Entity Status Letter

Source id: `us-ca/ca-ftb-entity-status-letter`

- Access method: automated public browser check. No authentication is required.
- Official URL: `https://webapp.ftb.ca.gov/eletter/`
- Reference URL: `https://www.ftb.ca.gov/help/business/entity-status-letter.asp`

Automated behavior:

1. Open the FTB Entity Status Letter lookup.
2. Search by FTB entity ID if configured; otherwise search by exact legal name.
3. Open the public result summary and record entity ID, entity name, address, FTB entity
   status, and California exempt status.

Finding behavior:

- If the source returns `NOT EXEMPT` or any other non-verified exempt status, treat that
  as an open California FTB issue.
- If the source later returns `EXEMPT`, the current findings view suppresses the stale
  prior FTB exempt-status issue while keeping all raw history.

User-facing guidance: do not ask the user to re-check this page manually. Run
`compliance-discover` to refresh it. If the latest result is `NOT EXEMPT`, guide the user
to fix California exemption through MyFTB, FTB support, or Form 3500A as appropriate.

## MyFTB

Source id: `us-ca/ca-ftb-myftb`

- Access method: user-assisted authenticated read-only session.
- Why authenticated: MyFTB account access is private. FTB terms require an authorized
  individual business representative account and prohibit shared credentials.
- Official URL: `https://www.ftb.ca.gov/myftb/`
- Terms URL: `https://www.ftb.ca.gov/myftb/general-terms-and-conditions.html`

Evidence fields:

- `business_account_access` (required): Whether authorized business account access is
  available
- `ftb_account_status` (required): FTB account status
- `action_required_messages` (optional): Action-required messages or none shown
- `reviewed_at` (required): Reviewed-at date

Forbidden actions:

- Do not share or store a MyFTB password.
- Do not file returns or submit forms.
- Do not make payments.
- Do not upload attachments.
- Do not update account, address, representative, or access information.
- Do not send messages, request relief, protest, appeal, or otherwise transact with FTB.

User-facing walkthrough: give the official URL and the configured FTB entity ID or legal
name. Ask for plain-language status details; do not ask the user to type the field keys
above.

## CDTFA public permit/license/account verification

Source id: `us-ca/ca-cdtfa-permit-license-verification`

- Access method: automated public browser check.
- Public flow: open CDTFA Online Services, choose "Verify a Permit, License or
  Account," select the configured account type, enter the normalized identifier, and read
  the public result.
- Supported automated identifiers: seller permit number and use-tax account number.
  Special tax/fee identifiers remain configuration-blocked until the specific taxable
  activity type is known.
- Official URL: `https://onlineservices.cdtfa.ca.gov/`
- Terms URL: `https://www.cdtfa.ca.gov/use.htm`

Stored payload includes account type, account number, verification status, validity,
owner name, start date, end date, DBA, address, suspension dates, city, zip code, and
structured evidence. If this source fails because no seller permit or use-tax identifier
is configured, store the known identifier and rerun discovery; do not ask the user to
perform the public search manually.

## CDTFA Online Services

Source id: `us-ca/ca-cdtfa-online-services`

- Access method: user-assisted authenticated read-only session.
- Why authenticated: CDTFA Online Services account overview can show accounts, filing
  obligations, notices, billings, payment/return history, and account maintenance tools.
  Discovery may inspect read-only status only after user-assisted login/MFA.
- Official URL: `https://onlineservices.cdtfa.ca.gov/`
- Terms URL: `https://www.cdtfa.ca.gov/use.htm`

Evidence fields:

- `cdtfa_accounts_present` (required): Whether any CDTFA-managed account is present
- `account_statuses` (required): Account statuses shown in Online Services
- `open_filing_obligations` (optional): Open filing obligations or none shown
- `notices_or_billings` (optional): Notices or billings shown, if any
- `reviewed_at` (required): Reviewed-at date

Forbidden actions:

- Do not file returns or reports.
- Do not make payments or prepayments.
- Do not register, renew, close, or modify any permit, license, account, or location.
- Do not request relief, payment plans, filing extensions, appeals, or power of attorney.
- Do not add, remove, or change portal users, delegates, secondary logons, or access
  levels.
- Do not upload documents or submit forms.

User-facing walkthrough: give the official URL and every configured CDTFA account
identifier. If no CDTFA identifier is configured, say that clearly. Ask for plain-language
status details; do not ask the user to type the field keys above.
