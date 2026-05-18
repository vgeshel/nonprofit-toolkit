/**
 * MCP OAuth server provider that proxies authentication to Google.
 *
 * Implements the OAuthServerProvider interface from the MCP SDK.
 * Handles Dynamic Client Registration, redirects to Google for login,
 * and issues MCP tokens after verifying the user's Google Workspace domain.
 */
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import {
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Response } from 'express'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { OAuthStorage } from './storage'
import { generateToken, tokenFingerprint } from './storage'

/** Token lifetime: 1 hour */
const TOKEN_LIFETIME_S = 3600

/**
 * Zod schema for the Google token endpoint response.
 */
const GoogleTokenResponseSchema = z.object({
  access_token: z.string(),
  id_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  scope: z.string().optional(),
})

/**
 * Zod schema for the decoded Google ID token payload.
 * We only parse the fields we need.
 */
const GoogleIdTokenPayloadSchema = z.object({
  sub: z.string(),
  email: z.string(),
  hd: z.string().optional(),
  name: z.string().optional(),
})

/**
 * Configuration for the Google OAuth proxy provider.
 */
export interface GoogleOAuthProviderConfig {
  googleClientId: string
  googleClientSecret: string
  allowedDomain: string
  baseUrl: string
  storage: OAuthStorage
  logger: Logger
}

/**
 * Clients store backed by the shared OAuthStorage.
 */
class FirestoreClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private storage: OAuthStorage,
    private logger: Logger,
  ) {}

  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    try {
      return await this.storage.getClient(clientId)
    } catch (err) {
      this.logger.error({ err }, 'getClient failed')
      throw err
    }
  }

  async registerClient(
    client: Omit<
      OAuthClientInformationFull,
      'client_id' | 'client_id_issued_at'
    >,
  ): Promise<OAuthClientInformationFull> {
    try {
      const fullClient: OAuthClientInformationFull = {
        ...client,
        client_id: generateToken(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      }
      await this.storage.saveClient(fullClient)
      return fullClient
    } catch (err) {
      this.logger.error({ err, client }, 'registerClient failed')
      throw err
    }
  }
}

/**
 * OAuth server provider that proxies to Google for authentication.
 */
export class GoogleOAuthProvider implements OAuthServerProvider {
  private readonly config: GoogleOAuthProviderConfig
  private readonly _clientsStore: FirestoreClientsStore

  constructor(config: GoogleOAuthProviderConfig) {
    this.config = config
    this._clientsStore = new FirestoreClientsStore(
      config.storage,
      config.logger,
    )
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore
  }

  /**
   * Begin authorization by redirecting to Google's OAuth consent screen.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Generate an authorization code for this MCP flow
    const authorizationCode = generateToken()

    // Save the pending authorization
    await this.config.storage.savePendingAuth(authorizationCode, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      createdAt: Date.now(),
    })

    // Redirect to Google OAuth
    const googleAuthUrl = new URL(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    googleAuthUrl.searchParams.set('client_id', this.config.googleClientId)
    googleAuthUrl.searchParams.set(
      'redirect_uri',
      `${this.config.baseUrl}/oauth/google/callback`,
    )
    googleAuthUrl.searchParams.set('response_type', 'code')
    googleAuthUrl.searchParams.set('scope', 'openid email profile')
    googleAuthUrl.searchParams.set('hd', this.config.allowedDomain)
    // Pass our MCP authorization code as state so we can correlate
    // the Google callback with the pending authorization
    googleAuthUrl.searchParams.set('state', authorizationCode)
    googleAuthUrl.searchParams.set('access_type', 'online')
    googleAuthUrl.searchParams.set('prompt', 'select_account')

    res.redirect(googleAuthUrl.toString())
  }

  /**
   * Return the PKCE code challenge for the given authorization code.
   */
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    try {
      const pending =
        await this.config.storage.getPendingAuth(authorizationCode)
      if (!pending) {
        throw new InvalidGrantError('Unknown authorization code')
      }
      return pending.codeChallenge
    } catch (err) {
      this.config.logger.error({ err }, 'challengeForAuthorizationCode failed')
      throw err
    }
  }

  /**
   * Exchange an authorization code for MCP tokens.
   */
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const codeFp = tokenFingerprint(authorizationCode)
    this.config.logger.info(
      { codeFingerprint: codeFp, clientId: client.client_id },
      'exchangeAuthorizationCode: start',
    )
    try {
      // Mark the exchange as used (replay protection)
      const wasUnused =
        await this.config.storage.markTokenExchangeUsed(authorizationCode)
      if (!wasUnused) {
        this.config.logger.warn(
          { codeFingerprint: codeFp },
          'exchangeAuthorizationCode: code replayed',
        )
        throw new InvalidGrantError(
          'Authorization code already used or invalid',
        )
      }

      const exchange =
        await this.config.storage.getTokenExchange(authorizationCode)
      if (!exchange) {
        this.config.logger.warn(
          { codeFingerprint: codeFp },
          'exchangeAuthorizationCode: token exchange not found',
        )
        throw new InvalidGrantError('Token exchange not found')
      }

      const installation = await this.config.storage.getInstallation(
        exchange.accessToken,
      )
      if (!installation) {
        this.config.logger.warn(
          { codeFingerprint: codeFp },
          'exchangeAuthorizationCode: installation not found',
        )
        throw new InvalidGrantError('Installation not found')
      }

      this.config.logger.info(
        {
          codeFingerprint: codeFp,
          accessTokenFingerprint: tokenFingerprint(installation.accessToken),
          refreshTokenFingerprint: tokenFingerprint(installation.refreshToken),
          userEmail: installation.userEmail,
        },
        'exchangeAuthorizationCode: success',
      )

      return {
        access_token: installation.accessToken,
        refresh_token: installation.refreshToken,
        token_type: 'bearer',
        expires_in: TOKEN_LIFETIME_S,
      }
    } catch (err) {
      this.config.logger.error(
        { err, codeFingerprint: codeFp },
        'exchangeAuthorizationCode failed',
      )
      throw err
    }
  }

  /**
   * Exchange a refresh token for new MCP tokens.
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
  ): Promise<OAuthTokens> {
    const refreshFp = tokenFingerprint(refreshToken)
    this.config.logger.info(
      { refreshTokenFingerprint: refreshFp, clientId: client.client_id },
      'exchangeRefreshToken: start',
    )

    const oldAccessToken =
      await this.config.storage.getAccessTokenForRefresh(refreshToken)
    if (!oldAccessToken) {
      this.config.logger.warn(
        { refreshTokenFingerprint: refreshFp, clientId: client.client_id },
        'exchangeRefreshToken: refresh mapping not found',
      )
      throw new InvalidGrantError('Invalid refresh token')
    }
    this.config.logger.info(
      {
        refreshTokenFingerprint: refreshFp,
        accessTokenFingerprint: tokenFingerprint(oldAccessToken),
      },
      'exchangeRefreshToken: refresh mapping found',
    )

    const oldInstallation =
      await this.config.storage.getInstallation(oldAccessToken)
    if (!oldInstallation) {
      this.config.logger.warn(
        {
          refreshTokenFingerprint: refreshFp,
          accessTokenFingerprint: tokenFingerprint(oldAccessToken),
        },
        'exchangeRefreshToken: installation not found',
      )
      throw new InvalidGrantError('Installation not found')
    }
    this.config.logger.info(
      {
        refreshTokenFingerprint: refreshFp,
        userEmail: oldInstallation.userEmail,
        installationExpiresAt: oldInstallation.expiresAt,
      },
      'exchangeRefreshToken: installation found',
    )

    // Generate new tokens
    const newAccessToken = generateToken()
    const newRefreshToken = generateToken()
    const now = Math.floor(Date.now() / 1000)

    const newInstallation = {
      ...oldInstallation,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      issuedAt: now,
      expiresAt: now + TOKEN_LIFETIME_S,
    }

    // Save new installation and mappings
    await this.config.storage.saveInstallation(newInstallation)
    await this.config.storage.saveRefreshMapping(
      newRefreshToken,
      newAccessToken,
    )

    // Delete old tokens
    await this.config.storage.deleteInstallation(oldAccessToken)
    await this.config.storage.deleteRefreshMapping(refreshToken)

    this.config.logger.info(
      {
        oldRefreshTokenFingerprint: refreshFp,
        newRefreshTokenFingerprint: tokenFingerprint(newRefreshToken),
        newAccessTokenFingerprint: tokenFingerprint(newAccessToken),
        userEmail: oldInstallation.userEmail,
      },
      'exchangeRefreshToken: success',
    )

    return {
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      token_type: 'bearer',
      expires_in: TOKEN_LIFETIME_S,
    }
  }

  /**
   * Verify an MCP access token and return auth info.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const fp = tokenFingerprint(token)
    const installation = await this.config.storage.getInstallation(token)
    if (!installation) {
      this.config.logger.warn(
        { tokenFingerprint: fp },
        'verifyAccessToken: installation not found',
      )
      throw new InvalidTokenError('Invalid or expired access token')
    }
    // Storage no longer enforces expiry (so refresh can read old installations).
    // Enforce it here at the auth check.
    const now = Math.floor(Date.now() / 1000)
    if (installation.expiresAt < now) {
      this.config.logger.warn(
        {
          tokenFingerprint: fp,
          expiresAt: installation.expiresAt,
          now,
          ageSeconds: now - installation.expiresAt,
        },
        'verifyAccessToken: token expired',
      )
      throw new InvalidTokenError('Invalid or expired access token')
    }

    this.config.logger.info(
      { tokenFingerprint: fp, userEmail: installation.userEmail },
      'verifyAccessToken: ok',
    )

    return {
      token,
      clientId: installation.clientId,
      scopes: [],
      expiresAt: installation.expiresAt,
      extra: {
        userId: installation.userId,
        email: installation.userEmail,
        domain: installation.userDomain,
      },
    }
  }

  /**
   * Revoke an access or refresh token.
   */
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    this.config.logger.info(
      {
        tokenFingerprint: tokenFingerprint(request.token),
        tokenTypeHint: request.token_type_hint,
        clientId: client.client_id,
      },
      'revokeToken',
    )
    if (request.token_type_hint === 'refresh_token') {
      const accessToken = await this.config.storage.getAccessTokenForRefresh(
        request.token,
      )
      if (accessToken) {
        await this.config.storage.deleteInstallation(accessToken)
      }
      await this.config.storage.deleteRefreshMapping(request.token)
    } else {
      await this.config.storage.deleteInstallation(request.token)
    }
  }

  /**
   * Handle the Google OAuth callback.
   *
   * Exchanges the Google authorization code for tokens, verifies the
   * user's domain, creates MCP tokens, and redirects back to the
   * MCP client.
   */
  async handleGoogleCallback(
    googleCode: string,
    mcpAuthorizationCode: string,
  ): Promise<{ redirectUrl: string }> {
    // Exchange Google code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: googleCode,
        client_id: this.config.googleClientId,
        client_secret: this.config.googleClientSecret,
        redirect_uri: `${this.config.baseUrl}/oauth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text()
      throw new Error(`Google token exchange failed: ${text}`)
    }

    const googleTokens = GoogleTokenResponseSchema.parse(
      await tokenResponse.json(),
    )

    // Decode the ID token to get user info
    const idTokenParts = googleTokens.id_token.split('.')
    const payloadPart = idTokenParts[1]
    if (!payloadPart) {
      throw new Error('Invalid Google ID token format')
    }
    const payload = GoogleIdTokenPayloadSchema.parse(
      JSON.parse(Buffer.from(payloadPart, 'base64url').toString()),
    )

    // Enforce domain restriction
    if (payload.hd !== this.config.allowedDomain) {
      throw new Error(
        `Access restricted to @${this.config.allowedDomain} accounts`,
      )
    }

    // Look up the pending authorization
    const pending =
      await this.config.storage.getPendingAuth(mcpAuthorizationCode)
    if (!pending) {
      throw new Error('Authorization session expired')
    }

    // Generate MCP tokens
    const accessToken = generateToken()
    const refreshToken = generateToken()
    const now = Math.floor(Date.now() / 1000)

    const installation = {
      accessToken,
      refreshToken,
      clientId: pending.clientId,
      userId: payload.sub,
      userEmail: payload.email,
      userDomain: payload.hd,
      issuedAt: now,
      expiresAt: now + TOKEN_LIFETIME_S,
    }

    // Save everything. Note: we do NOT delete pending auth here — the
    // SDK's /token handler calls challengeForAuthorizationCode() after
    // this callback completes, which reads the code challenge from the
    // pending auth record. Pending auth has a 10-minute TTL and will
    // expire on its own.
    await this.config.storage.saveInstallation(installation)
    await this.config.storage.saveRefreshMapping(refreshToken, accessToken)
    await this.config.storage.saveTokenExchange(
      mcpAuthorizationCode,
      accessToken,
    )

    // Build redirect URL back to MCP client
    const redirectUrl = new URL(pending.redirectUri)
    redirectUrl.searchParams.set('code', mcpAuthorizationCode)
    if (pending.state) {
      redirectUrl.searchParams.set('state', pending.state)
    }

    return { redirectUrl: redirectUrl.toString() }
  }
}
