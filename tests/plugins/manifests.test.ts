/**
 * Tests for the Claude Code plugin manifests + marketplace catalog.
 *
 * Each manifest is parsed against a Zod schema that mirrors the
 * documented shape (https://docs.claude.com/en/docs/claude-code/plugins-reference).
 * The skill symlinks under each plugin's skills/ directory are verified to
 * point at the corresponding entries in .claude/skills/.
 */
import { readdir, readFile, readlink, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const REPO_ROOT = resolve(__dirname, '..', '..')

const MarketplacePluginSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  description: z.string().min(1).optional(),
})

const MarketplaceSchema = z.object({
  name: z.string().min(1),
  owner: z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
  }),
  metadata: z
    .object({
      description: z.string().min(1).optional(),
      version: z.string().min(1).optional(),
    })
    .optional(),
  plugins: z.array(MarketplacePluginSchema).min(1),
})

const PluginManifestSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  description: z.string().min(1),
  license: z.string().min(1).optional(),
  repository: z.string().url().optional(),
  keywords: z.array(z.string().min(1)).optional(),
})

const McpServerEntrySchema = z.object({
  type: z.enum(['stdio', 'http', 'sse']),
  url: z.string().url().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
})

const McpJsonSchema = z.object({
  mcpServers: z.record(z.string(), McpServerEntrySchema),
})

describe('marketplace.json', () => {
  it('parses against the marketplace schema', async () => {
    const raw = await readFile(
      join(REPO_ROOT, '.claude-plugin', 'marketplace.json'),
      'utf-8',
    )
    const parsed: unknown = JSON.parse(raw)
    const marketplace = MarketplaceSchema.parse(parsed)
    expect(marketplace.name).toBe('nonprofit-toolkit')
    expect(marketplace.plugins.length).toBeGreaterThan(0)
  })

  it('every plugin source path points at an existing directory', async () => {
    const raw = await readFile(
      join(REPO_ROOT, '.claude-plugin', 'marketplace.json'),
      'utf-8',
    )
    const parsed: unknown = JSON.parse(raw)
    const marketplace = MarketplaceSchema.parse(parsed)
    for (const plugin of marketplace.plugins) {
      const absolutePluginPath = resolve(REPO_ROOT, plugin.source)
      const stats = await stat(absolutePluginPath)
      expect(stats.isDirectory()).toBe(true)
    }
  })
})

const EXPECTED_PLUGINS: readonly {
  readonly slug: string
  readonly expectedSkills: readonly string[]
}[] = [
  {
    slug: 'nonprofit-toolkit-core',
    expectedSkills: [
      'agentic-analytics',
      'bootstrap',
      'create-connector',
      'deploying-etl',
      'donations-query',
      'donor-letter',
      'mcp-server',
      'provision',
      'running-etl-locally',
      'slack-bot',
    ],
  },
  {
    slug: 'nonprofit-toolkit-compliance',
    expectedSkills: [
      'compliance-discover',
      'compliance-onboard',
      'compliance-status',
    ],
  },
]

describe.each(EXPECTED_PLUGINS)('plugin: $slug', ({ slug, expectedSkills }) => {
  const pluginRoot = join(REPO_ROOT, 'plugins', slug)

  it('parses plugin.json against the manifest schema', async () => {
    const raw = await readFile(
      join(pluginRoot, '.claude-plugin', 'plugin.json'),
      'utf-8',
    )
    const parsed: unknown = JSON.parse(raw)
    const manifest = PluginManifestSchema.parse(parsed)
    expect(manifest.name).toBe(slug)
  })

  it('parses .mcp.json against the MCP-config schema', async () => {
    const raw = await readFile(join(pluginRoot, '.mcp.json'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    const config = McpJsonSchema.parse(parsed)
    expect(Object.keys(config.mcpServers)).toContain('nonprofit-toolkit')
    const server = config.mcpServers['nonprofit-toolkit']
    expect(server?.type).toBe('http')
    expect(server?.url).toMatch(/^https?:\/\//)
  })

  it('ships a README.md', async () => {
    const raw = await readFile(join(pluginRoot, 'README.md'), 'utf-8')
    expect(raw.length).toBeGreaterThan(0)
    expect(raw).toContain(slug)
  })

  it('skills/ directory contains exactly the expected symlinks pointing at .claude/skills/', async () => {
    const skillsDir = join(pluginRoot, 'skills')
    const entries = (await readdir(skillsDir)).sort()
    expect(entries).toEqual([...expectedSkills].sort())
    for (const entry of entries) {
      const linkTarget = await readlink(join(skillsDir, entry))
      // The symlink may be relative; resolve it from the symlink's directory
      // and confirm it lands under .claude/skills/.
      const resolved = resolve(skillsDir, linkTarget)
      expect(resolved.endsWith(`/.claude/skills/${entry}`)).toBe(true)
      const skillStats = await stat(resolved)
      expect(skillStats.isDirectory()).toBe(true)
    }
  })
})
