/**
 * @donations-etl/connectors
 *
 * Data source connectors for the Donations ETL system.
 */

// Connector interface and types
export type {
  CheckDepositsConfig,
  Connector,
  ConnectorConfigs,
  ConnectorFactory,
  FetchOptions,
  FetchResult,
  FunraiseConfig,
  GivebutterConfig,
  MercuryConfig,
  PatreonConfig,
  PayPalConfig,
  VenmoConfig,
  WiseConfig,
} from './types'

// Mercury connector
export {
  MERCURY_BASE_URL,
  MERCURY_DEFAULT_PAGE_SIZE,
  MercuryClient,
  MercuryConnector,
  type IMercuryClient,
  type MercuryConnectorOptions,
} from './mercury'

// PayPal connector
export {
  PAYPAL_BASE_URL,
  PAYPAL_DEFAULT_PAGE_SIZE,
  PAYPAL_SANDBOX_URL,
  PayPalClient,
  PayPalConnector,
  type IPayPalClient,
  type PayPalConnectorOptions,
} from './paypal'

// Givebutter connector
export {
  GIVEBUTTER_BASE_URL,
  GIVEBUTTER_DEFAULT_PAGE_SIZE,
  GivebutterClient,
  GivebutterConnector,
  type GivebutterConnectorOptions,
  type IGivebutterClient,
} from './givebutter'

// Check Deposits connector (Google Sheets)
export {
  CheckDepositsClient,
  CheckDepositsConnector,
  type CheckDepositsConnectorOptions,
  type ICheckDepositsClient,
} from './check-deposits'

// Funraise connector (CSV exports)
export {
  FunraiseClient,
  FunraiseConnector,
  type FunraiseConnectorOptions,
  type IFunraiseClient,
} from './funraise'

// Venmo connector (CSV exports)
export { VenmoClient, VenmoConnector, type IVenmoClient } from './venmo'

// Wise connector (API)
export {
  WISE_BASE_URL,
  WiseClient,
  WiseConnector,
  type IWiseClient,
  type WiseConnectorOptions,
} from './wise'

// Patreon connector (API)
export {
  PATREON_BASE_URL,
  PATREON_DEFAULT_PAGE_SIZE,
  PatreonClient,
  PatreonConnector,
  type IPatreonClient,
  type PatreonConnectorOptions,
} from './patreon'
