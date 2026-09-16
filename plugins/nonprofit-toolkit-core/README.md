# nonprofit-toolkit-core

Core skills for the [nonprofit-toolkit](https://github.com/vgeshel/nonprofit-toolkit) project. Install via the nonprofit-toolkit marketplace.

## What this plugin contains

- **Skills:** `donor-letter`, `donations-query`, `running-etl-locally`, `deploying-etl`, `bootstrap`, `create-connector`, `provision`, `agentic-analytics`, `slack-bot`, `mcp-server`.
- **MCP server registration:** declares the remote `nonprofit-toolkit` MCP server in `.mcp.json` (HTTP transport).

## Configuring the MCP server URL

`.mcp.json` ships with a placeholder URL (`https://your-mcp-server.example.com/mcp`). Edit it to point at your deployed Cloud Run instance after the nonprofit-toolkit MCP server is provisioned. The skills work standalone if you don't deploy the server, but the conversational query and letter-generation flows expect it.

## Compliance

For the federal/California compliance toolkit (entity onboarding, status, discovery), install the companion plugin **nonprofit-toolkit-compliance** from the same marketplace.

## See also

- Marketplace: [`.claude-plugin/marketplace.json`](../../.claude-plugin/marketplace.json)
- Project README: [`/README.md`](../../README.md)
- Plan: [`docs/compliance-mcp/PLAN.md`](../../docs/compliance-mcp/PLAN.md)
