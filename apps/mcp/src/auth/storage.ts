/**
 * Firestore storage for OAuth state.
 *
 * Stores client registrations, pending authorizations, token
 * installations, and refresh token mappings in Firestore.
 * Falls back to in-memory storage when Firestore is unavailable
 * (local dev without GCP credentials).
 */
import { Firestore } from '@google-cloud/firestore'
import {
  OAuthClientInformationFullSchema,
  type OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import crypto from 'node:crypto'
import { z } from 'zod'

/**
 * A pending OAuth authorization awaiting Google callback.
 */
export interface PendingAuthorization {
  clientId: string
  redirectUri: string
  codeChallenge: string
  state?: string
  createdAt: number
}

/**
 * An active MCP token installation.
 */
export interface McpInstallation {
  accessToken: string
  refreshToken: string
  clientId: string
  userId: string
  userEmail: string
  userDomain: string
  issuedAt: number
  expiresAt: number
}

/**
 * Storage interface for OAuth state. Implemented by Firestore.
 */
export interface OAuthStorage {
  // Client registrations (DCR)
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>
  saveClient(client: OAuthClientInformationFull): Promise<void>

  // Pending authorizations (short-lived, during OAuth flow)
  getPendingAuth(code: string): Promise<PendingAuthorization | undefined>
  savePendingAuth(code: string, auth: PendingAuthorization): Promise<void>
  deletePendingAuth(code: string): Promise<void>

  // Token installations (long-lived)
  getInstallation(accessToken: string): Promise<McpInstallation | undefined>
  saveInstallation(installation: McpInstallation): Promise<void>
  deleteInstallation(accessToken: string): Promise<void>

  // Refresh token → access token mapping
  getAccessTokenForRefresh(refreshToken: string): Promise<string | undefined>
  saveRefreshMapping(refreshToken: string, accessToken: string): Promise<void>
  deleteRefreshMapping(refreshToken: string): Promise<void>

  // Authorization code → access token (for exchange)
  getTokenExchange(
    code: string,
  ): Promise<{ accessToken: string; used: boolean } | undefined>
  saveTokenExchange(code: string, accessToken: string): Promise<void>
  markTokenExchangeUsed(code: string): Promise<boolean>
}

/**
 * Hash a token for use as a Firestore document ID.
 * Tokens should not be stored in plaintext.
 */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Return a short, log-safe fingerprint of a token: the first 12 hex
 * chars of its SHA256 hash. This matches the prefix used by Firestore
 * document IDs in the OAuth collections, so log entries can be
 * cross-referenced with stored docs without exposing the full token.
 */
export function tokenFingerprint(token: string): string {
  return hashToken(token).slice(0, 12)
}

/**
 * Generate a cryptographically random token.
 */
export function generateToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

// ── Zod schemas for Firestore document data ──────────────────────

const PendingAuthSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  codeChallenge: z.string(),
  state: z.string().optional(),
  createdAt: z.number(),
})

const McpInstallationSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  clientId: z.string(),
  userId: z.string(),
  userEmail: z.string(),
  userDomain: z.string(),
  issuedAt: z.number(),
  expiresAt: z.number(),
})

// TTLs
const CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000 // 10 minutes
const INSTALLATION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const TOKEN_EXCHANGE_TTL_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Firestore-backed OAuth storage.
 */
export class FirestoreOAuthStorage implements OAuthStorage {
  private db: Firestore

  constructor(projectId: string) {
    this.db = new Firestore({ projectId, ignoreUndefinedProperties: true })
  }

  // ── Clients ──────────────────────────────────────────────────────

  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    const doc = await this.db.doc(`mcp_clients/${clientId}`).get()
    if (!doc.exists) return undefined
    const data = doc.data()
    if (!data) return undefined
    if (data.expiresAt && data.expiresAt < Date.now()) return undefined
    return OAuthClientInformationFullSchema.parse(data.client)
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    await this.db.doc(`mcp_clients/${client.client_id}`).set({
      client,
      expiresAt: Date.now() + CLIENT_TTL_MS,
    })
  }

  // ── Pending Authorizations ───────────────────────────────────────

  async getPendingAuth(
    code: string,
  ): Promise<PendingAuthorization | undefined> {
    const doc = await this.db.doc(`mcp_pending/${hashToken(code)}`).get()
    if (!doc.exists) return undefined
    const data = doc.data()
    if (!data) return undefined
    if (data.expiresAt && data.expiresAt < Date.now()) return undefined
    return PendingAuthSchema.parse(data.auth)
  }

  async savePendingAuth(
    code: string,
    auth: PendingAuthorization,
  ): Promise<void> {
    await this.db.doc(`mcp_pending/${hashToken(code)}`).set({
      auth,
      expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
    })
  }

  async deletePendingAuth(code: string): Promise<void> {
    await this.db.doc(`mcp_pending/${hashToken(code)}`).delete()
  }

  // ── Installations ────────────────────────────────────────────────

  async getInstallation(
    accessToken: string,
  ): Promise<McpInstallation | undefined> {
    const doc = await this.db
      .doc(`mcp_installations/${hashToken(accessToken)}`)
      .get()
    if (!doc.exists) return undefined
    const data = doc.data()
    if (!data) return undefined
    // Note: we do NOT reject expired installations here. The access token
    // expiry is enforced by the provider's verifyAccessToken. The refresh
    // flow legitimately needs to read installations whose access token has
    // expired — that's the whole point of refresh tokens. The Firestore
    // document-level TTL (7 days) handles cleanup of truly old records.
    return McpInstallationSchema.parse(data.installation)
  }

  async saveInstallation(installation: McpInstallation): Promise<void> {
    await this.db
      .doc(`mcp_installations/${hashToken(installation.accessToken)}`)
      .set({
        installation,
        expiresAt: Date.now() + INSTALLATION_TTL_MS,
      })
  }

  async deleteInstallation(accessToken: string): Promise<void> {
    await this.db.doc(`mcp_installations/${hashToken(accessToken)}`).delete()
  }

  // ── Refresh Mappings ─────────────────────────────────────────────

  async getAccessTokenForRefresh(
    refreshToken: string,
  ): Promise<string | undefined> {
    const doc = await this.db
      .doc(`mcp_refresh/${hashToken(refreshToken)}`)
      .get()
    if (!doc.exists) return undefined
    const data = doc.data()
    if (!data) return undefined
    const parsed = z.object({ accessToken: z.string() }).safeParse(data)
    return parsed.success ? parsed.data.accessToken : undefined
  }

  async saveRefreshMapping(
    refreshToken: string,
    accessToken: string,
  ): Promise<void> {
    await this.db.doc(`mcp_refresh/${hashToken(refreshToken)}`).set({
      accessToken,
      expiresAt: Date.now() + INSTALLATION_TTL_MS,
    })
  }

  async deleteRefreshMapping(refreshToken: string): Promise<void> {
    await this.db.doc(`mcp_refresh/${hashToken(refreshToken)}`).delete()
  }

  // ── Token Exchange ───────────────────────────────────────────────

  async getTokenExchange(
    code: string,
  ): Promise<{ accessToken: string; used: boolean } | undefined> {
    const doc = await this.db.doc(`mcp_exchanges/${hashToken(code)}`).get()
    if (!doc.exists) return undefined
    const data = doc.data()
    if (!data) return undefined
    if (data.expiresAt && data.expiresAt < Date.now()) return undefined
    const parsed = z
      .object({ accessToken: z.string(), used: z.boolean() })
      .parse(data)
    return parsed
  }

  async saveTokenExchange(code: string, accessToken: string): Promise<void> {
    await this.db.doc(`mcp_exchanges/${hashToken(code)}`).set({
      accessToken,
      used: false,
      expiresAt: Date.now() + TOKEN_EXCHANGE_TTL_MS,
    })
  }

  async markTokenExchangeUsed(code: string): Promise<boolean> {
    const ref = this.db.doc(`mcp_exchanges/${hashToken(code)}`)
    const result = await this.db.runTransaction(async (tx) => {
      const doc = await tx.get(ref)
      if (!doc.exists) return false
      const data = doc.data()
      if (!data || data.used) return false
      tx.update(ref, { used: true })
      return true
    })
    return result
  }
}
