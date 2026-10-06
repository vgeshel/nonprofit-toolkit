---
name: bootstrap
description: >
  Bootstrap donations-etl on a fresh machine. Use this skill when the user says "bootstrap",
  "set up from scratch", "fresh install", "new machine setup", "onboard me", "getting started",
  "install everything", "clone and set up", or asks how to get the project running on a new
  machine. Also use when the user encounters missing dependencies or environment issues that
  suggest the project hasn't been fully set up. Covers installing Bun, dependencies, and walks
  through full configuration and optional deployment.
---

# Bootstrap donations-etl

Set up the project from scratch on a new machine. This skill handles everything from
installing the runtime to deploying to GCP.

## Step 1: Check prerequisites

### Bun runtime

```bash
command -v bun && bun --version
```

If Bun is not installed, install it:

```bash
curl -fsSL https://bun.sh/install | bash
```

After installation, reload the shell:

```bash
source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null
bun --version
```

If the user is on macOS and prefers Homebrew:

```bash
brew install oven-sh/bun/bun
```

### Git

```bash
git --version
```

If not installed, guide the user to install Git for their platform.

## Step 2: Clone the repository (if needed)

Check if we're already in the project directory:

```bash
[ -f package.json ] && grep -q '"donations-etl"' package.json && echo "Already in project" || echo "Not in project directory"
```

If not in the project:

```bash
git clone <repo-url> donations-etl
cd donations-etl
```

Ask the user for the repository URL if you don't know it.

## Step 3: Install dependencies

```bash
bun install
```

You may see a warning `.git can't be found` from husky. This is harmless if you
haven't initialized git yet.

Create `.env.test.local` if it doesn't exist (needed for tests):

```bash
touch .env.test.local
```

Verify the installation:

```bash
bun typecheck
```

If typecheck fails, check for Node.js/Bun version issues.

## Step 4: Verify the build

Run the full verification suite:

```bash
bun typecheck && echo "typecheck OK"
bun lint && echo "lint OK"
bun test:run && echo "tests OK"
```

If tests fail, help the user debug. Common issues:

- Missing `.env.test.local` file: `touch .env.test.local`
- Zod import issues: check `vitest.config.ts` has `ssr: { noExternal: ['zod'] }`

## Step 5: Configuration

Now hand off to the `/setup` skill which walks through:

1. Organization identity (name, address, mission, tax status, signer)
2. GCP project configuration
3. Data source credentials (Mercury, PayPal, Wise, Givebutter, Venmo, Funraise, Google Sheets)
4. Slack integration (optional)
5. Letter service configuration

Tell the user:

> The project builds and tests pass. Now let's configure it for your organization.
> I'll walk you through setting up your organization details, data sources, and deployment.

Then invoke the `/setup` skill workflow inline (don't literally invoke it - follow the same
steps described in the setup skill's SKILL.md).

## Step 6: Test ETL locally (optional)

Ask: "Would you like to test the ETL locally?"

If yes:

```bash
dotenvx run --overload -- bun apps/runner/src/main.ts daily
```

Review the output with the user. Verify that configured sources are fetching data and
that there are no authentication errors. If a source fails, help debug (wrong API key,
expired token, etc.).

## Step 7: Google Cloud SDK (if deploying)

Ask: "Do you plan to deploy to GCP?"

If yes, check for gcloud:

```bash
command -v gcloud && gcloud version
```

If not installed:

- macOS: `brew install --cask google-cloud-sdk`
- Linux: `curl https://sdk.cloud.google.com | bash`
- Then: `exec -l $SHELL` to reload PATH

Authenticate:

```bash
gcloud auth login
gcloud auth application-default login
gcloud config set project PROJECT_ID
```

Configure Docker for Artifact Registry:

```bash
gcloud auth configure-docker REGION-docker.pkg.dev
```

### Docker

```bash
docker info > /dev/null 2>&1 && echo "Docker is running" || echo "Docker is NOT running"
```

If not installed, guide to https://www.docker.com/products/docker-desktop/

### dotenvx

```bash
command -v dotenvx || bun add -g @dotenvx/dotenvx
```

## Step 8: Provision and deploy (optional)

Ask: "Would you like to provision GCP infrastructure and deploy now?"

If yes, invoke the provisioning workflow:

```bash
dotenvx run --overload -- ./infra/provision.sh
```

After provisioning, verify:

```bash
gcloud run jobs describe donations-etl --region REGION
```

## Summary

Print a summary of what was set up:

- Bun version
- Dependencies installed
- Tests passing
- Configuration status (which data sources are configured)
- GCP deployment status (provisioned or skipped)

Suggest next steps:

- Run ETL locally: `/running-etl-locally`
- Deploy: `/deploying-etl`
- Generate donor letter: `/donor-letter`
- Query donations: `/donations-query`
- Add a new data source connector: `/create-connector`
