#!/usr/bin/env bun
/**
 * Injects a test MCP installation into Firestore for end-to-end testing.
 * Useful for verifying the /mcp endpoint without going through the full
 * Google OAuth flow.
 *
 * Usage: dotenvx run -- bun scripts/inject-test-token.ts
 * Prints the access token to stdout so you can curl /mcp with it.
 */
import { Firestore } from '@google-cloud/firestore'
import crypto from 'node:crypto'
import { z } from 'zod'

const EnvSchema = z.object({
  PROJECT_ID: z.string(),
  // The Google Workspace domain the MCP server accepts; the fake installation
  // claims a user in that domain.
  MCP_ALLOWED_DOMAIN: z.string().min(1),
})
const env = EnvSchema.parse(process.env)

const db = new Firestore({
  projectId: env.PROJECT_ID,
  ignoreUndefinedProperties: true,
})

const TOKEN = 'test-' + crypto.randomBytes(32).toString('hex')
const REFRESH_TOKEN = 'test-refresh-' + crypto.randomBytes(32).toString('hex')

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

const now = Math.floor(Date.now() / 1000)
const installation = {
  accessToken: TOKEN,
  refreshToken: REFRESH_TOKEN,
  clientId: 'test-client',
  userId: 'test-user',
  userEmail: `test@${env.MCP_ALLOWED_DOMAIN}`,
  userDomain: env.MCP_ALLOWED_DOMAIN,
  issuedAt: now,
  expiresAt: now + 3600,
}

await db.doc(`mcp_installations/${hashToken(TOKEN)}`).set({
  installation,
  expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
})

console.log(TOKEN)
