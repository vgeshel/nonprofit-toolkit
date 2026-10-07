#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------
# Donations ETL provisioning (GCP CLI-only, idempotent)
# ------------------------------------------------------------
# Expected to be run via dotenvx:
#   dotenvx run --overload -- ./infra/provision.sh
# --overload makes .env win over variables already exported in the shell, so a
# stale exported credential can never be written to Secret Manager.
#
# Reads config from env (injected from .env):
#   PROJECT_ID, REGION, LOCATION, BUCKET, AR_REPO, IMAGE_NAME, JOB_NAME,
#   DATASET_RAW, DATASET_CANON, RUNTIME_SA, SCHEDULER_SA,
#   SCHEDULER_JOB_NAME, SCHEDULE, TIME_ZONE,
#   SKIP_BUILD, SKIP_SCHEMA, SKIP_SECRETS, SKIP_SCHEDULER, SKIP_MONITORING,
#   ALERT_SLACK_CHANNEL (Slack channel for alerts), REPORT_TIME_ZONE,
#   DISBURSEMENT_ALIASES (bank descriptors platforms pay out under),
#   SECRET_* (connector credentials; a source is enabled by setting its secret.
#   An unset value never overwrites a secret already in Secret Manager.)

log() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }

PROJECT_ID="${PROJECT_ID:?PROJECT_ID must be set in .env}"
REGION="${REGION:-us-central1}"
LOCATION="${LOCATION:-US}" # BigQuery multi-region

BUCKET="${BUCKET:-${PROJECT_ID}-donations-etl}"
AR_REPO="${AR_REPO:-donations}"
IMAGE_NAME="${IMAGE_NAME:-etl}"
JOB_NAME="${JOB_NAME:-donations-etl}"

DATASET_RAW="${DATASET_RAW:-donations_raw}"
DATASET_CANON="${DATASET_CANON:-donations}"

RUNTIME_SA="${RUNTIME_SA:-donations-etl-sa}"
SCHEDULER_SA="${SCHEDULER_SA:-donations-etl-scheduler-sa}"

RUNTIME_SA_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA_EMAIL="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-${JOB_NAME}-daily}"
SCHEDULE="${SCHEDULE:-0 9 * * *}"
TIME_ZONE="${TIME_ZONE:-America/Los_Angeles}"

# Google Sheets - Check Deposits source
CHECK_DEPOSITS_SPREADSHEET_ID="${CHECK_DEPOSITS_SPREADSHEET_ID:-}"
CHECK_DEPOSITS_SHEET_NAME="${CHECK_DEPOSITS_SHEET_NAME:-}"

# Patreon campaign (the access token is the PATREON_ACCESS_TOKEN secret)
PATREON_CAMPAIGN_ID="${PATREON_CAMPAIGN_ID:-}"

# Wise API settings
WISE_PROFILE_ID="${WISE_PROFILE_ID:-}"

# Slack and donation reports (optional)
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
REPORT_SLACK_CHANNEL="${REPORT_SLACK_CHANNEL:-}"
REPORT_TIME_ZONE="${REPORT_TIME_ZONE:-${TIME_ZONE}}"

SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_SCHEMA="${SKIP_SCHEMA:-0}"
SKIP_SECRETS="${SKIP_SECRETS:-0}"
SKIP_SCHEDULER="${SKIP_SCHEDULER:-0}"
SKIP_MONITORING="${SKIP_MONITORING:-0}"
ALERT_SLACK_CHANNEL="${ALERT_SLACK_CHANNEL:-}"

SCHEMA_SQL_PATH="${SCHEMA_SQL_PATH:-packages/bq/src/schema.sql}"

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${IMAGE_NAME}:latest"
RUN_URL="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run"


ensure_project() {
  log "Setting gcloud project: ${PROJECT_ID}"
  gcloud config set project "${PROJECT_ID}" >/dev/null
}

enable_apis() {
  log "Enabling required APIs (idempotent)..."
  gcloud services enable \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    bigquery.googleapis.com \
    cloudscheduler.googleapis.com \
    secretmanager.googleapis.com \
    monitoring.googleapis.com \
    aiplatform.googleapis.com \
    logging.googleapis.com \
    sheets.googleapis.com \
    iam.googleapis.com >/dev/null
}

ensure_ar_repo() {
  log "Ensuring Artifact Registry repo: ${AR_REPO} (${REGION})"
  if gcloud artifacts repositories describe "${AR_REPO}" --location "${REGION}" >/dev/null 2>&1; then
    log "Artifact Registry repo exists."
  else
    gcloud artifacts repositories create "${AR_REPO}" \
      --repository-format=docker \
      --location="${REGION}" \
      --description="Docker images for donations ETL" >/dev/null
    log "Artifact Registry repo created."
  fi
}

# Keep the newest image versions and delete the rest after a grace period,
# so the registry does not grow without bound. Policy: infra/artifact-cleanup-policy.json
ensure_ar_cleanup_policy() {
  log "Ensuring Artifact Registry cleanup policy on ${AR_REPO}"
  gcloud artifacts repositories set-cleanup-policies "${AR_REPO}" \
    --location="${REGION}" \
    --policy=infra/artifact-cleanup-policy.json \
    --no-dry-run >/dev/null
}

ensure_bucket() {
  log "Ensuring GCS bucket: gs://${BUCKET}"
  if gsutil ls -b "gs://${BUCKET}" >/dev/null 2>&1; then
    log "Bucket exists."
  else
    # Use multi-region US for best compatibility with BigQuery US datasets.
    gsutil mb -p "${PROJECT_ID}" -l US -c STANDARD "gs://${BUCKET}" >/dev/null
    log "Bucket created."
  fi
}

ensure_bq_datasets() {
  log "Ensuring BigQuery datasets (${LOCATION})..."
  if bq --location="${LOCATION}" show "${PROJECT_ID}:${DATASET_RAW}" >/dev/null 2>&1; then
    log "Dataset ${DATASET_RAW} exists."
  else
    bq --location="${LOCATION}" mk -d "${DATASET_RAW}" >/dev/null
    log "Dataset ${DATASET_RAW} created."
  fi

  if bq --location="${LOCATION}" show "${PROJECT_ID}:${DATASET_CANON}" >/dev/null 2>&1; then
    log "Dataset ${DATASET_CANON} exists."
  else
    bq --location="${LOCATION}" mk -d "${DATASET_CANON}" >/dev/null
    log "Dataset ${DATASET_CANON} created."
  fi
}

ensure_service_account() {
  local name="$1" email="$2" display="$3"
  log "Ensuring service account: ${email}"
  if gcloud iam service-accounts describe "${email}" >/dev/null 2>&1; then
    log "Service account exists."
  else
    gcloud iam service-accounts create "${name}" --display-name "${display}" >/dev/null
    log "Service account created."
  fi
}

ensure_project_role() {
  local member="$1" role="$2"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member "${member}" \
    --role "${role}" \
    --quiet >/dev/null
}

ensure_sa_role_on_sa() {
  local target_sa_email="$1" member="$2" role="$3"
  gcloud iam service-accounts add-iam-policy-binding "${target_sa_email}" \
    --member "${member}" \
    --role "${role}" \
    --quiet >/dev/null
}

ensure_iam() {
  log "Ensuring IAM bindings..."

  # Runtime SA: BigQuery jobs + edit data, read secrets, write to bucket, Vertex AI
  ensure_project_role "serviceAccount:${RUNTIME_SA_EMAIL}" "roles/bigquery.jobUser"
  ensure_project_role "serviceAccount:${RUNTIME_SA_EMAIL}" "roles/bigquery.dataEditor"
  ensure_project_role "serviceAccount:${RUNTIME_SA_EMAIL}" "roles/secretmanager.secretAccessor"
  ensure_project_role "serviceAccount:${RUNTIME_SA_EMAIL}" "roles/storage.objectAdmin"
  ensure_project_role "serviceAccount:${RUNTIME_SA_EMAIL}" "roles/aiplatform.user"

  # Scheduler SA: permission to run Cloud Run Jobs
  ensure_project_role "serviceAccount:${SCHEDULER_SA_EMAIL}" "roles/run.developer"

  # Cloud Scheduler service agent must be able to mint tokens for SCHEDULER_SA when using --oauth-service-account-email
  local project_number
  project_number="$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")"
  local scheduler_agent="service-${project_number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
  log "Ensuring Cloud Scheduler service agent can impersonate ${SCHEDULER_SA_EMAIL}: ${scheduler_agent}"
  ensure_sa_role_on_sa "${SCHEDULER_SA_EMAIL}" "serviceAccount:${scheduler_agent}" "roles/iam.serviceAccountTokenCreator"
}

# Write a secret from an env var. An unset/empty value keeps whatever Secret
# Manager already holds, and an unchanged value adds no version.
# Logic lives in scripts/secret-lib.ts.
ensure_secret() {
  local name="$1" envvar="$2"
  bun scripts/ensure-secret.ts --project "${PROJECT_ID}" --name "${name}" --from-env "${envvar}"
}

ensure_secrets() {
  if [ "${SKIP_SECRETS}" = "1" ]; then
    log "SKIP_SECRETS=1; skipping secrets."
    return
  fi

  log "Ensuring secrets (idempotent)..."
  # Each source is optional: its secret is written only when set in .env,
  # and the job mounts only the secrets that exist.
  local pair name envvar
  for pair in \
    MERCURY_API_KEY:SECRET_MERCURY_API_KEY \
    PAYPAL_CLIENT_ID:SECRET_PAYPAL_CLIENT_ID \
    PAYPAL_SECRET:SECRET_PAYPAL_SECRET \
    GIVEBUTTER_API_KEY:SECRET_GIVEBUTTER_API_KEY \
    WISE_TOKEN:SECRET_WISE_TOKEN \
    PATREON_ACCESS_TOKEN:SECRET_PATREON_ACCESS_TOKEN \
    SLACK_BOT_TOKEN:SLACK_BOT_TOKEN; do
    name="${pair%%:*}"
    envvar="${pair#*:}"
    if [ -n "${!envvar:-}" ]; then
      ensure_secret "${name}" "${envvar}"
    fi
  done
}

apply_schema() {
  if [ "${SKIP_SCHEMA}" = "1" ]; then
    log "SKIP_SCHEMA=1; skipping BigQuery schema apply."
    return
  fi

  if [ ! -f "${SCHEMA_SQL_PATH}" ]; then
    echo "Schema SQL not found at ${SCHEMA_SQL_PATH}" >&2
    echo "Agent must add packages/bq/src/schema.sql or set SCHEMA_SQL_PATH." >&2
    exit 1
  fi

  log "Applying BigQuery schema from ${SCHEMA_SQL_PATH}..."
  bq query --use_legacy_sql=false < "${SCHEMA_SQL_PATH}" >/dev/null
  log "Schema applied."
}

# Make source_coverage's alias rows match DISBURSEMENT_ALIASES (per-nonprofit
# bank descriptors). Logic lives in scripts/disbursement-aliases-lib.ts.
sync_disbursement_aliases() {
  if [ "${SKIP_SCHEMA}" = "1" ]; then
    log "SKIP_SCHEMA=1; skipping disbursement aliases."
    return
  fi
  log "Syncing disbursement aliases..."
  bun scripts/sync-disbursement-aliases.ts --project "${PROJECT_ID}" \
    --dataset-raw "${DATASET_RAW}" --dataset-canon "${DATASET_CANON}"
}

apply_migrations() {
  if [ "${SKIP_SCHEMA}" = "1" ]; then
    log "SKIP_SCHEMA=1; skipping BigQuery migrations."
    return
  fi

  local migrations_dir="packages/bq/src/migrations"

  if [ ! -d "${migrations_dir}" ]; then
    log "No migrations directory found, skipping."
    return
  fi

  log "Applying BigQuery migrations..."
  for migration in "${migrations_dir}"/*.sql; do
    if [ -f "${migration}" ]; then
      log "Running migration: $(basename "${migration}")"
      bq query --use_legacy_sql=false < "${migration}" >/dev/null
    fi
  done
  log "Migrations complete."
}

build_image() {
  if [ "${SKIP_BUILD}" = "1" ]; then
    log "SKIP_BUILD=1; skipping Cloud Build."
    return
  fi

  log "Building & pushing image via Cloud Build: ${IMAGE_URI}"
  gcloud builds submit --tag "${IMAGE_URI}" . >/dev/null
  log "Image built and pushed."
}

ensure_cloud_run_job() {
  log "Ensuring Cloud Run Job: ${JOB_NAME}"

  local env_vars
  env_vars="PROJECT_ID=${PROJECT_ID},DATASET_RAW=${DATASET_RAW},DATASET_CANON=${DATASET_CANON},BUCKET=${BUCKET},LOOKBACK_HOURS=48,LOG_LEVEL=info"

  # Optional settings, passed only when configured
  local var
  for var in CHECK_DEPOSITS_SPREADSHEET_ID CHECK_DEPOSITS_SHEET_NAME WISE_PROFILE_ID \
    PATREON_CAMPAIGN_ID REPORT_SLACK_CHANNEL ALERT_SLACK_CHANNEL; do
    if [ -n "${!var:-}" ]; then
      env_vars="${env_vars},${var}=${!var}"
    fi
  done

  # Mount every connector secret that exists
  local secrets="" name
  for name in MERCURY_API_KEY PAYPAL_CLIENT_ID PAYPAL_SECRET GIVEBUTTER_API_KEY \
    WISE_TOKEN PATREON_ACCESS_TOKEN SLACK_BOT_TOKEN; do
    if gcloud secrets describe "${name}" >/dev/null 2>&1; then
      secrets="${secrets:+${secrets},}${name}=${name}:latest"
    fi
  done

  local common=(
    --region "${REGION}"
    --image "${IMAGE_URI}"
    --service-account "${RUNTIME_SA_EMAIL}"
    --set-env-vars "${env_vars}"
    --memory 1Gi
    --cpu 1
    --max-retries 1
    --tasks 1
    --task-timeout 3600s
  )
  if [ -n "${secrets}" ]; then
    common+=(--set-secrets "${secrets}")
  fi

  if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" "${common[@]}" >/dev/null
    log "Cloud Run Job updated."
  else
    gcloud run jobs create "${JOB_NAME}" "${common[@]}" >/dev/null
    log "Cloud Run Job created."
  fi
}

ensure_scheduler_job() {
  if [ "${SKIP_SCHEDULER}" = "1" ]; then
    log "SKIP_SCHEDULER=1; skipping scheduler."
    return
  fi

  log "Ensuring Cloud Scheduler job: ${SCHEDULER_JOB_NAME} (${REGION})"

  if gcloud scheduler jobs describe "${SCHEDULER_JOB_NAME}" --location "${REGION}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${SCHEDULER_JOB_NAME}" \
      --location "${REGION}" \
      --schedule "${SCHEDULE}" \
      --time-zone "${TIME_ZONE}" \
      --uri "${RUN_URL}" \
      --http-method POST \
      --message-body '{}' \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --update-headers "Content-Type=application/json" >/dev/null
    log "Scheduler job updated."
  else
    gcloud scheduler jobs create http "${SCHEDULER_JOB_NAME}" \
      --location "${REGION}" \
      --schedule "${SCHEDULE}" \
      --time-zone "${TIME_ZONE}" \
      --uri "${RUN_URL}" \
      --http-method POST \
      --message-body '{}' \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --headers "Content-Type=application/json" >/dev/null
    log "Scheduler job created."
  fi
}

# Alert policies for failed jobs and scheduler triggers, sent to
# ALERT_SLACK_CHANNEL. Logic lives in scripts/monitoring-lib.ts.
ensure_monitoring() {
  if [ "${SKIP_MONITORING}" = "1" ]; then
    log "SKIP_MONITORING=1; skipping alert policies."
    return
  fi
  log "Ensuring Cloud Monitoring alert policies..."
  bun scripts/provision-monitoring.ts --project "${PROJECT_ID}" --slack-channel "${ALERT_SLACK_CHANNEL}"
}

ensure_report_scheduler_jobs() {
  if [ "${SKIP_SCHEDULER}" = "1" ]; then
    log "SKIP_SCHEDULER=1; skipping report schedulers."
    return
  fi

  if [ -z "${REPORT_SLACK_CHANNEL}" ]; then
    log "REPORT_SLACK_CHANNEL not set; skipping report schedulers."
    return
  fi

  local weekly_name="${JOB_NAME}-report-weekly"
  local monthly_name="${JOB_NAME}-report-monthly"
  local weekly_schedule="${REPORT_WEEKLY_SCHEDULE:-0 8 * * 1}"
  local monthly_schedule="${REPORT_MONTHLY_SCHEDULE:-0 8 1 * *}"

  # Weekly report scheduler
  local weekly_body='{"overrides":{"containerOverrides":[{"args":["bun","dist/apps/runner/main.js","report","--period","weekly"]}]}}'

  log "Ensuring weekly report scheduler: ${weekly_name}"
  if gcloud scheduler jobs describe "${weekly_name}" --location "${REGION}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${weekly_name}" \
      --location "${REGION}" \
      --schedule "${weekly_schedule}" \
      --time-zone "${REPORT_TIME_ZONE}" \
      --uri "${RUN_URL}" \
      --http-method POST \
      --message-body "${weekly_body}" \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --update-headers "Content-Type=application/json" >/dev/null
    log "Weekly report scheduler updated."
  else
    gcloud scheduler jobs create http "${weekly_name}" \
      --location "${REGION}" \
      --schedule "${weekly_schedule}" \
      --time-zone "${REPORT_TIME_ZONE}" \
      --uri "${RUN_URL}" \
      --http-method POST \
      --message-body "${weekly_body}" \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --headers "Content-Type=application/json" >/dev/null
    log "Weekly report scheduler created."
  fi

  # Monthly report scheduler
  local monthly_body='{"overrides":{"containerOverrides":[{"args":["bun","dist/apps/runner/main.js","report","--period","monthly"]}]}}'

  log "Ensuring monthly report scheduler: ${monthly_name}"
  if gcloud scheduler jobs describe "${monthly_name}" --location "${REGION}" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "${monthly_name}" \
      --location "${REGION}" \
      --schedule "${monthly_schedule}" \
      --time-zone "${REPORT_TIME_ZONE}" \
      --uri "${RUN_URL}" \
      --http-method POST \
      --message-body "${monthly_body}" \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --update-headers "Content-Type=application/json" >/dev/null
    log "Monthly report scheduler updated."
  else
    gcloud scheduler jobs create http "${monthly_name}" \
      --location "${REGION}" \
      --schedule "${monthly_schedule}" \
      --time-zone "${REPORT_TIME_ZONE}" \
      --uri "${RUN_URL}" \
      --http-method POST \
      --message-body "${monthly_body}" \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --headers "Content-Type=application/json" >/dev/null
    log "Monthly report scheduler created."
  fi
}

main() {
  need_cmd gcloud
  need_cmd bun
  need_cmd bq
  need_cmd gsutil

  log "Starting provisioning for ${PROJECT_ID} (region=${REGION})"

  ensure_project
  enable_apis
  ensure_ar_repo
  ensure_ar_cleanup_policy
  ensure_bucket
  ensure_bq_datasets

  ensure_service_account "${RUNTIME_SA}" "${RUNTIME_SA_EMAIL}" "Donations ETL runtime"
  ensure_service_account "${SCHEDULER_SA}" "${SCHEDULER_SA_EMAIL}" "Donations ETL scheduler"
  ensure_iam

  ensure_secrets
  apply_schema
  apply_migrations
  sync_disbursement_aliases
  build_image

  ensure_cloud_run_job
  ensure_scheduler_job
  ensure_report_scheduler_jobs
  ensure_monitoring

  log "Provisioning complete."
  log "Next commands:"
  log "  - Execute job now:    gcloud run jobs execute ${JOB_NAME} --region ${REGION}"
  log "  - Run scheduler now:  gcloud scheduler jobs run ${SCHEDULER_JOB_NAME} --location ${REGION}"

  # Remind about Google Sheets setup if spreadsheet ID is configured
  if [ -n "${CHECK_DEPOSITS_SPREADSHEET_ID}" ]; then
    log ""
    log "Google Sheets setup:"
    log "  Share the Check Deposits spreadsheet with the runtime service account:"
    log "    ${RUNTIME_SA_EMAIL}"
    log "  Grant 'Viewer' permission for read-only access."
  fi
}

main "$@"
