# Infrastructure Provisioning

This directory contains the GCP provisioning script for the Donations ETL pipeline.

## Prerequisites

- Google Cloud SDK (`gcloud`) installed and authenticated
- `bq` command (part of Google Cloud SDK)
- `gsutil` command (part of Google Cloud SDK)
- Docker (for building images)
- `dotenvx` installed (`bun add -g @dotenvx/dotenvx`)

## Quick Start

1. Copy `.env.example` to `.env` and fill in your values:

   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

2. Run the provisioning script:
   ```bash
   dotenvx run -- ./infra/provision.sh
   ```

## What It Provisions

The script is **idempotent** - safe to run multiple times.

### GCP Resources Created

| Resource              | Description                                              |
| --------------------- | -------------------------------------------------------- |
| **Artifact Registry** | Docker image repository for ETL container                |
| **GCS Bucket**        | Storage for NDJSON staging files                         |
| **BigQuery Datasets** | `donations_raw` (staging) and `donations` (canonical)    |
| **BigQuery Tables**   | `staging_events`, `events`, `etl_runs`, `etl_watermarks` |
| **Service Accounts**  | Runtime SA for ETL job, Scheduler SA for triggering      |
| **Secret Manager**    | API keys for Mercury, PayPal, Givebutter                 |
| **Cloud Run Job**     | The ETL container job                                    |
| **Cloud Scheduler**   | Daily trigger for the ETL job                            |
| **APIs Enabled**      | Sheets API for Check Deposits Google Spreadsheet access  |

### IAM Bindings

- Runtime SA gets: BigQuery Data Editor, GCS Object Admin, Secret Accessor
- Scheduler SA gets: Cloud Run Invoker on the job

## Environment Variables

### Required

| Variable     | Description       | Example          |
| ------------ | ----------------- | ---------------- |
| `PROJECT_ID` | GCP project ID    | `my-project-123` |
| `REGION`     | Cloud Run region  | `us-central1`    |
| `LOCATION`   | BigQuery location | `US`             |

### Optional (with defaults)

| Variable                        | Default                       | Description                         |
| ------------------------------- | ----------------------------- | ----------------------------------- |
| `BUCKET`                        | `${PROJECT_ID}-donations-etl` | GCS bucket name                     |
| `AR_REPO`                       | `donations`                   | Artifact Registry repo name         |
| `IMAGE_NAME`                    | `etl`                         | Docker image name                   |
| `JOB_NAME`                      | `donations-etl`               | Cloud Run job name                  |
| `DATASET_RAW`                   | `donations_raw`               | Staging dataset                     |
| `DATASET_CANON`                 | `donations`                   | Canonical dataset                   |
| `RUNTIME_SA`                    | `donations-etl-sa`            | Runtime service account             |
| `SCHEDULER_SA`                  | `donations-etl-scheduler-sa`  | Scheduler service account           |
| `SCHEDULE`                      | `0 9 * * *`                   | Cron schedule (9am daily)           |
| `TIME_ZONE`                     | `America/Los_Angeles`         | Scheduler timezone                  |
| `CHECK_DEPOSITS_SPREADSHEET_ID` | (none)                        | Google Sheets ID for Check Deposits |

### Skip Flags

Set to `1` to skip specific provisioning steps:

| Variable          | Description                          |
| ----------------- | ------------------------------------ |
| `SKIP_BUILD`      | Skip Docker build and push           |
| `SKIP_SCHEMA`     | Skip BigQuery schema creation        |
| `SKIP_SECRETS`    | Skip Secret Manager setup            |
| `SKIP_SCHEDULER`  | Skip Cloud Scheduler setup           |
| `SKIP_MONITORING` | Skip Cloud Monitoring alert policies |

### Secrets

Each source is enabled by setting its credential in `.env`; provisioning
writes it to Secret Manager and the job mounts every secret that exists. An
unset value never overwrites a secret already in Secret Manager, and an
unchanged value adds no new version, so re-running with a partial `.env` is
safe.

| Variable                      | Secret                 | Description                |
| ----------------------------- | ---------------------- | -------------------------- |
| `SECRET_MERCURY_API_KEY`      | `MERCURY_API_KEY`      | Mercury API key            |
| `SECRET_PAYPAL_CLIENT_ID`     | `PAYPAL_CLIENT_ID`     | PayPal OAuth client ID     |
| `SECRET_PAYPAL_SECRET`        | `PAYPAL_SECRET`        | PayPal OAuth client secret |
| `SECRET_GIVEBUTTER_API_KEY`   | `GIVEBUTTER_API_KEY`   | Givebutter API key         |
| `SECRET_WISE_TOKEN`           | `WISE_TOKEN`           | Wise API token             |
| `SECRET_PATREON_ACCESS_TOKEN` | `PATREON_ACCESS_TOKEN` | Patreon creator token      |
| `SLACK_BOT_TOKEN`             | `SLACK_BOT_TOKEN`      | Slack bot (reports/alerts) |

## Manual Steps After Provisioning

1. **Connect Slack to Cloud Monitoring** (one-time, console only — Slack
   OAuth has no API): Monitoring > Alerting > Edit notification channels >
   Slack > Add new, choose `ALERT_SLACK_CHANNEL`, then re-run provisioning.
   Invite the Slack bot to that channel too, so job failure alerts reach it.

2. **Verify the job** runs correctly:

   ```bash
   gcloud run jobs execute donations-etl --region us-central1
   ```

3. **Check logs**:
   ```bash
   gcloud run jobs logs read donations-etl --region us-central1
   ```

## Google Sheets Setup (Check Deposits)

The Check Deposits source reads data from a Google Spreadsheet. The ETL job uses Application Default Credentials (ADC) in Cloud Run, which automatically inherits the runtime service account identity.

### Setup Steps

1. **Set the spreadsheet ID** in your `.env`:

   ```bash
   CHECK_DEPOSITS_SPREADSHEET_ID=YOUR_SPREADSHEET_ID
   ```

   The spreadsheet ID is the long string in the Google Sheets URL between `/d/` and `/edit`.

2. **Share the spreadsheet** with the runtime service account:
   - Open your Google Spreadsheet
   - Click "Share" button
   - Add the service account email: `donations-etl-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com`
   - Grant "Viewer" permission (read-only access is sufficient)

3. **Re-run provisioning** to update the Cloud Run job with the spreadsheet ID:
   ```bash
   dotenvx run -- ./infra/provision.sh
   ```

### Local Development

For local development, you need to authenticate with Google Cloud:

```bash
# Authenticate with your user account
gcloud auth application-default login

# Or use a service account key (not recommended for security reasons)
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

The `google-auth-library` will automatically pick up these credentials.

### Troubleshooting Google Sheets Access

**Permission denied errors:**

- Ensure the spreadsheet is shared with the service account email
- Verify the `sheets.googleapis.com` API is enabled in your GCP project
- Check the spreadsheet ID is correct (no extra characters or spaces)

**Service account email:**

```bash
# Get the runtime service account email
echo "donations-etl-sa@$(gcloud config get-value project).iam.gserviceaccount.com"
```

## Troubleshooting

### Permission Denied

Ensure you're authenticated with sufficient permissions:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

### Missing APIs

The script enables required APIs automatically. If you see API errors, wait a few minutes and retry.

### Docker Build Fails

Ensure Docker is running and you're authenticated to Artifact Registry:

```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```
