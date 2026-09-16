/**
 * Benevity connector (Donations Report CSV exports).
 */
export {
  BenevityClient,
  getErrorMessage,
  parseBenevityReport,
  type IBenevityClient,
} from './client'
export { BenevityConnector, createBenevityConnector } from './connector'
export {
  BenevityCsvRowSchema,
  BenevityReportMetaSchema,
  NOT_SHARED_SENTINEL,
  REPORT_META_LABELS,
  isDonationHeaderRow,
  isTrailerLabel,
  normalizeWithheld,
  parseMoneyToCents,
  type BenevityCsvRow,
  type BenevityParseError,
  type BenevityReport,
  type BenevityReportMeta,
  type BenevityReportTotals,
} from './schema'
export {
  buildDonorAddress,
  buildDonorName,
  buildSourceMetadata,
  extractEmail,
  transformBenevityReport,
  transformBenevityRow,
} from './transformer'
