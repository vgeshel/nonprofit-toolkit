# Federal Compliance Sources

Load this file when discussing federal compliance discovery or interpreting IRS source
results.

## IRS Tax Exempt Organization Search bulk data

Source id: `us-federal/irs-teos`

- Access method: official public bulk downloads.
- Data used: Pub. 78 and automatic revocation bulk files, matched by EIN.
- Current use: confirms whether the EIN is listed in Pub. 78 and whether the EIN appears
  on the automatic revocation list.
- User-facing note: Pub. 78 is a deductibility signal. It should be interpreted alongside
  EO BMF, CA AG, and any manual-required state sources before calling compliance complete.

## IRS Exempt Organizations Business Master File

Source id: `us-federal/irs-eo-bmf`

- Access method: official public CSV bulk download.
- Data used: EO BMF row matched by EIN.
- Current use: subsection, deductibility, foundation classification, affiliation, ruling
  date, tax period, NTEE code, and basic financial fields where present.
- User-facing note: EO BMF supplements TEOS. A successful BMF match does not resolve
  California charity, corporate, or tax-agency standing.

## IRS Tax Pro Account

Source id: not registered by default.

- Access method: not implemented in Phase 3.
- Source decision: Tax Pro Account is not a default nonprofit compliance-discovery source
  because IRS TEOS and EO BMF already provide the public federal exemption signals this
  toolkit currently needs, while Tax Pro Account requires taxpayer/CAF authorization and
  exposes mutating flows such as authorization withdrawal and payments.
- Official URL: `https://www.irs.gov/tax-professionals/tax-pro-account`
- Tax professional hub: `https://www.irs.gov/taxpro`

Do not tell the user that IRS Tax Pro Account was checked unless a later phase adds a
safe, read-only, user-authorized source and the source actually runs.
