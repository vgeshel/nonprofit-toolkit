---
name: deploying-etl
description: Use when deploying the ETL application to GCP Cloud Run. Triggers on "deploy", "push to production", "release to cloud", "update cloud run", or "ship the ETL". Handles Docker image builds via Cloud Build and Cloud Run Job updates.
---

# Deploying ETL to GCP Cloud Run

Deploy the donations ETL application to Google Cloud Platform using the project's deployment script.

## Prerequisites Check

Before deploying, verify:

1. **Authentication**: User must be authenticated with gcloud
2. **Environment**: `.env` file must exist with `PROJECT_ID` configured
3. **Infrastructure**: Cloud Run Job must already exist (created via `./infra/provision.sh`)

## Deployment Commands

### Standard Deployment

```bash
./scripts/deploy.sh
```

This will:

1. Load environment variables from `.env` via dotenvx
2. Build Docker image using Cloud Build
3. Push image to Artifact Registry
4. Update the Cloud Run Job with the new image

### Dry Run (Preview Changes)

```bash
./scripts/deploy.sh --dry-run
```

Shows what would happen without making changes. Use this to verify configuration before actual deployment.

## Post-Deployment Verification

After deployment, help the user verify:

```bash
# Run the job manually
gcloud run jobs execute donations-etl --region us-central1

# Check job execution status
gcloud run jobs executions list --job donations-etl --region us-central1

# View logs from latest execution
gcloud run jobs executions logs <EXECUTION_ID> --region us-central1
```

## Troubleshooting

| Error                           | Solution                                                 |
| ------------------------------- | -------------------------------------------------------- |
| "Not authenticated with gcloud" | Run `gcloud auth login`                                  |
| ".env file not found"           | Copy `.env.example` to `.env` and configure              |
| "Cloud Run Job not found"       | Run `./infra/provision.sh` first                         |
| "Project not found"             | Verify `PROJECT_ID` in `.env` matches actual GCP project |

## Environment Variables

The script reads from `.env`:

| Variable     | Required | Default         | Description                  |
| ------------ | -------- | --------------- | ---------------------------- |
| `PROJECT_ID` | Yes      | -               | GCP project ID               |
| `REGION`     | No       | `us-central1`   | GCP region                   |
| `AR_REPO`    | No       | `donations`     | Artifact Registry repository |
| `IMAGE_NAME` | No       | `etl`           | Docker image name            |
| `JOB_NAME`   | No       | `donations-etl` | Cloud Run Job name           |
