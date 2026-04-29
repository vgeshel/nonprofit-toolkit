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
