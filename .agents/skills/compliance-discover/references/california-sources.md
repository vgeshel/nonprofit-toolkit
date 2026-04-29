# California Compliance Sources

Load this file when discussing California compliance discovery, interpreting California
source results, or explaining why a California source is manual.

## CA AG Registry Reports

Source id: `us-ca/ca-ag-registry`

- Access method: official public CSV download.
- Primary data: Registry of Charitable Trusts report rows matched by EIN, AG charity
  registration number, or available California identifiers.
- Current use: registry status, renewal/reporting status, source freshness, and evidence
  metadata from the downloaded report.
- User-facing note: successful CA AG output is a California charity-registration signal;
  it is not a substitute for CA SOS corporate status or CA FTB tax status.

## CA SOS bizfile

Source id: `us-ca/ca-sos-bizfile`

- Access method: manual.
- Why manual: current source-policy review treats bizfile as manual-only because the
  CA SOS bizfile terms prohibit page-scrape, robot, spider, or similar automated
  collection methods.
- Official URL: `https://bizfileonline.sos.ca.gov/search/business`
- Terms URL:
  `https://www.sos.ca.gov/business-programs/bizfile/privacy-warning-terms-and-conditions-use`

Manual steps:

1. Open the California Secretary of State bizfile business search.
2. Search for the exact SOS entity number configured for this nonprofit.
3. Record the displayed entity status, entity name, jurisdiction, and status date if shown.

Evidence fields:

- `entity_status` (required): Entity status
- `entity_name` (required): Entity name
- `jurisdiction` (optional): Jurisdiction
- `status_date` (optional): Status date

## CA FTB Entity Status Letter

Source id: `us-ca/ca-ftb-entity-status-letter`

- Access method: manual.
- Why manual: Phase 2 treats the FTB Entity Status Letter form as manual pending a
  narrower source-policy review for automated read-only form use.
- Official URL: `https://webapp.ftb.ca.gov/eletter/`
- Reference URL: `https://www.ftb.ca.gov/help/business/entity-status-letter.asp`

Manual steps:

1. Open the FTB Entity Status Letter lookup.
2. Search by FTB entity id if configured; otherwise search by exact legal name.
3. Record whether the entity is in good standing with FTB and whether exempt status is
   verified.

Evidence fields:

- `ftb_status` (required): FTB status
- `exempt_status_verified` (optional): Exempt status verified
- `letter_date` (optional): Letter date

## CA CDTFA

Source id: not implemented yet.

- Status: planned source candidate for Phase 3.
- Scope to research: seller's permit, use-tax registration, and other CDTFA-managed tax
  or fee accounts relevant to the nonprofit.
- Starting URLs:
  - `https://www.cdtfa.ca.gov/services/`
  - `https://www.cdtfa.ca.gov/services/permits-licenses.htm`
  - `https://onlineservices.cdtfa.ca.gov/`
- Implementation rule: first confirm whether the nonprofit has a CDTFA-managed account and
  whether CDTFA offers an allowed public or authenticated read-only status path. If not,
  keep the source manual with typed evidence capture.
- Forbidden actions: filing returns, registering or closing accounts, requesting relief,
  making payments, or mutating CDTFA account data.
