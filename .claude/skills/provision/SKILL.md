---
name: provision
description: Provision GCP infrastructure for the Donations ETL pipeline. Creates .env from template if needed, guides through API key setup for Mercury, PayPal, Givebutter, and Check Deposits (Google Sheets), then runs the provisioning script.
---

# Provision Infrastructure

This skill walks you through provisioning GCP infrastructure for the Donations ETL pipeline.

## Workflow

Follow these steps in order:

### Step 1: Environment File Setup

Check if `.env` exists. If not, create it:

```bash
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example"
else
  echo ".env already exists"
fi
```

### Step 2: Verify GCP Configuration

Ask the user to confirm or update these core settings in `.env`:

| Variable     | Current Default | Description           |
| ------------ | --------------- | --------------------- |
| `PROJECT_ID` | (must be set)   | GCP project ID        |
| `REGION`     | `us-central1`   | Cloud Run region      |
| `LOCATION`   | `US`            | BigQuery multi-region |

Ask the user to confirm the GCP project is correct before proceeding.

### Step 3: API Key Setup

Guide the user through obtaining API keys for each source. For each source, use `WebFetch` or `WebSearch` to find current documentation, then ask the user for their key.

#### Mercury API Key

1. Fetch documentation: https://docs.mercury.com/reference/getting-started
2. Guide the user:
   - Log in to Mercury dashboard at https://app.mercury.com
   - Go to Settings → Developers → API Keys
   - Create a new API key with read access to transactions
   - Copy the key (it won't be shown again)
3. Ask user for `SECRET_MERCURY_API_KEY`

#### PayPal API Credentials

1. Fetch documentation: https://developer.paypal.com/api/rest/
2. Guide the user:
   - Log in to PayPal Developer Dashboard: https://developer.paypal.com/dashboard/
   - Go to Apps & Credentials
   - Create or select an app (use Live mode for production, Sandbox for testing)
   - Copy the Client ID and Client Secret
3. Ask user for:
   - `SECRET_PAYPAL_CLIENT_ID`
   - `SECRET_PAYPAL_SECRET`

#### Givebutter API Key

1. Fetch documentation: https://docs.givebutter.com/reference/getting-started
2. Guide the user:
   - Log in to Givebutter dashboard at https://givebutter.com
   - Go to Settings → Integrations → API
   - Generate a new API key
   - Copy the key
3. Ask user for `SECRET_GIVEBUTTER_API_KEY`

#### Check Deposits (Google Sheets)

This source reads check deposit data from a Google Sheets spreadsheet.

1. Ask user: "Do you want to enable check deposits from Google Sheets?"
2. If yes, ask for the spreadsheet ID:
   - The ID is found in the spreadsheet URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`
   - Example: `YOUR_SPREADSHEET_ID`
3. Ask user for:
   - `CHECK_DEPOSITS_SPREADSHEET_ID` (required if enabling)
   - `CHECK_DEPOSITS_SHEET_NAME` (optional, defaults to `checks`)

**Note:** After provisioning, the user must share the spreadsheet with the runtime service account. This is covered in Step 7.

### Step 4: Update .env with Secrets

After collecting all keys, update `.env` with the provided values:

```bash
# Use sed or Edit tool to update .env with the collected secrets
# Example for Mercury:
sed -i '' "s/^SECRET_MERCURY_API_KEY=.*/SECRET_MERCURY_API_KEY=${MERCURY_KEY}/" .env
```

### Step 5: Install/Update Prerequisites

Ensure all required tools are installed and up to date.

#### Google Cloud SDK (gcloud, bq, gsutil)

Check if gcloud is installed:

```bash
command -v gcloud && gcloud version
```

**If not installed**, install via Homebrew (macOS):

```bash
brew install --cask google-cloud-sdk
```

**If installed but outdated**, update:

```bash
gcloud components update
```

After installation, authenticate and configure:

```bash
# Login to GCP
gcloud auth login

# Set the project
gcloud config set project PROJECT_ID

# Configure Docker authentication for Artifact Registry
gcloud auth configure-docker us-central1-docker.pkg.dev
```

Verify all components are available:

```bash
gcloud version        # Should show gcloud CLI version
bq version            # BigQuery CLI (included with gcloud)
gsutil version        # GCS CLI (included with gcloud)
```

#### Docker

Check if Docker is installed and running:

```bash
docker info > /dev/null 2>&1 && echo "Docker is running" || echo "Docker is NOT running"
```

**If not installed**, install Docker Desktop from https://www.docker.com/products/docker-desktop/

**If installed but not running**, start Docker Desktop.

#### dotenvx

Check if dotenvx is available:

```bash
command -v dotenvx || bun add -g @dotenvx/dotenvx
```

### Step 6: Run Provisioning

Execute the provisioning script:

```bash
dotenvx run -- ./infra/provision.sh
```

This script is idempotent and will:

- Enable required GCP APIs
- Create Artifact Registry repository
- Create GCS bucket for staging files
- Create BigQuery datasets and tables
- Create service accounts with proper IAM bindings
- Store secrets in Secret Manager
- Build and push Docker image
- Create Cloud Run job
- Set up Cloud Scheduler for daily runs
- Set up Cloud Scheduler for weekly/monthly reports (if `REPORT_SLACK_CHANNEL` is set)

### Step 7: Donation Reports Setup (Optional)

After provisioning, ask: "Do you want to enable weekly and monthly donation reports to Slack?"

If yes:

1. If `REPORT_SLACK_CHANNEL` is not set in `.env`, ask the user for the Slack channel ID
   (right-click channel > View channel details > Channel ID at bottom) and update `.env`.
2. Ensure `SLACK_BOT_TOKEN` is in Secret Manager (provisioning handles this if set in `.env`).
   The bot must be invited to the target channel.
3. Verify the report scheduler jobs were created:
   ```bash
   gcloud scheduler jobs list --location ${REGION} | grep report
   ```
4. If the scheduler jobs don't exist (e.g., `REPORT_SLACK_CHANNEL` was added after provisioning),
   re-run provisioning or create them manually:
   ```bash
   dotenvx run -- ./infra/provision.sh
   ```
5. Optionally adjust the schedule and timezone by updating `.env`:
   - `REPORT_WEEKLY_SCHEDULE` (default: `0 8 * * 1` — Monday 8 AM)
   - `REPORT_MONTHLY_SCHEDULE` (default: `0 8 1 * *` — 1st of month 8 AM)
   - The timezone is set during scheduler job creation via `TIME_ZONE` in `.env`

If no: skip. Reports can be enabled later by setting `REPORT_SLACK_CHANNEL` and re-provisioning.

### Step 8: Donation Query Bot (Optional)

Ask: "Do you want to enable a Slack bot that answers natural language questions about donations?"

If yes:

1. Enable the Generative Language API and create an API key:
   ```bash
   gcloud services enable generativelanguage.googleapis.com
   gcloud services api-keys create --display-name="Donation Query Bot" \
     --api-target=service=generativelanguage.googleapis.com
   ```
   Store the key in Secret Manager and mount as `GOOGLE_GENERATIVE_AI_API_KEY` on the
   Cloud Run service.
2. Ask which AI model to use (set `AGENT_MODEL` env var on the Cloud Run service):
   - Default: `gemini-3.1-flash-lite-preview`
   - Alternative: `gemini-2.5-flash` (more capable)
3. The Slack app needs the `app_mentions:read` scope and Event Subscriptions:
   - Go to Slack app settings > OAuth & Permissions > add `app_mentions:read`
   - Go to Event Subscriptions > enable > subscribe to `app_mention` bot event
   - Set Request URL to `https://<service-url>/slack/events`
4. Provisioning automatically creates a read-only BigQuery service account (`donations-etl-query-sa`)
   with only `bigquery.dataViewer` and `bigquery.jobUser` permissions

If no: skip. The query bot activates automatically when `AI_GATEWAY_API_KEY` is set.

### Step 9: Post-Provisioning Verification

After provisioning completes:

1. Verify the Cloud Run job was created:

   ```bash
   gcloud run jobs describe donations-etl --region us-central1
   ```

2. Test the job manually:

   ```bash
   gcloud run jobs execute donations-etl --region us-central1 --wait
   ```

3. Check logs for any errors:

   ```bash
   gcloud run jobs logs read donations-etl --region us-central1
   ```

4. **If check_deposits is configured**, share the spreadsheet with the service account:
   - Open the Google Sheets spreadsheet
   - Click the "Share" button
   - Add the runtime service account email: `donations-etl-sa@{PROJECT_ID}.iam.gserviceaccount.com`
   - Grant "Viewer" permission (read-only access)
   - Click "Share" to confirm

5. **Verify check_deposits access** (optional local test):

   ```bash
   # Authenticate locally with ADC
   gcloud auth application-default login

   # Test the check_deposits source
   bun etl:run --sources check_deposits --skip-merge
   ```

### Step 10: MCP Server Deployment (Optional)

Ask: "Do you want to deploy the MCP server? This lets AI assistants (Claude.ai, Claude Code, ChatGPT) query your donation data and generate donor letters via MCP."

If yes: invoke the `/mcp-server` skill to handle the full deployment — it covers architecture choice, authentication, Cloud Run deployment, and client configuration.

If no: skip. The MCP server can be deployed later by running `/mcp-server`.

## Troubleshooting

### "Permission denied" errors

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### "API not enabled" errors

Wait 2-3 minutes after the script enables APIs, then retry.

### Docker authentication errors

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```

### Secret already exists

The script handles this gracefully - it will skip existing secrets.

## Skip Flags

If you need to skip certain steps (e.g., during re-provisioning), set these in `.env`:

| Flag               | Effect                        |
| ------------------ | ----------------------------- |
| `SKIP_BUILD=1`     | Skip Docker build and push    |
| `SKIP_SCHEMA=1`    | Skip BigQuery schema creation |
| `SKIP_SECRETS=1`   | Skip Secret Manager setup     |
| `SKIP_SCHEDULER=1` | Skip Cloud Scheduler setup    |

## Related Documentation

- `infra/README.md` - Full provisioning documentation
- `infra/provision.sh` - The provisioning script
- `.env.example` - Environment variable template

## Quick Reference: API Documentation URLs

- Mercury: https://docs.mercury.com/reference
- PayPal: https://developer.paypal.com/docs/api/overview/
- Givebutter: https://docs.givebutter.com/reference
