#!/usr/bin/env bash
set -euo pipefail

# ------------------------------------------------------------
# Donations ETL provisioning (GCP CLI-only, idempotent)
# ------------------------------------------------------------
# Expected to be run via dotenvx:
#   dotenvx run -- ./infra/provision.sh
#
# Reads config from env (injected from .env):
#   PROJECT_ID, REGION, LOCATION, BUCKET, AR_REPO, IMAGE_NAME, JOB_NAME,
#   DATASET_RAW, DATASET_CANON, RUNTIME_SA, SCHEDULER_SA,
#   SCHEDULER_JOB_NAME, SCHEDULE, TIME_ZONE,
#   SKIP_BUILD, SKIP_SCHEMA, SKIP_SECRETS, SKIP_SCHEDULER, SKIP_MONITORING,
#   ALERT_SLACK_CHANNEL (Slack channel for Cloud Monitoring alerts),
#   SECRET_* (optional initial secret values)

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
QUERY_SA="${QUERY_SA:-donations-etl-query-sa}"

RUNTIME_SA_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
SCHEDULER_SA_EMAIL="${SCHEDULER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
QUERY_SA_EMAIL="${QUERY_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

SCHEDULER_JOB_NAME="${SCHEDULER_JOB_NAME:-${JOB_NAME}-daily}"
SCHEDULE="${SCHEDULE:-0 9 * * *}"
TIME_ZONE="${TIME_ZONE:-America/Los_Angeles}"

# Google Sheets - Check Deposits source
CHECK_DEPOSITS_SPREADSHEET_ID="${CHECK_DEPOSITS_SPREADSHEET_ID:-}"

# Wise API settings
WISE_PROFILE_ID="${WISE_PROFILE_ID:-}"

# Slack and donation reports (optional)
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
REPORT_SLACK_CHANNEL="${REPORT_SLACK_CHANNEL:-}"

SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_SCHEMA="${SKIP_SCHEMA:-0}"
SKIP_SECRETS="${SKIP_SECRETS:-0}"
SKIP_SCHEDULER="${SKIP_SCHEDULER:-0}"
SKIP_MONITORING="${SKIP_MONITORING:-0}"
ALERT_SLACK_CHANNEL="${ALERT_SLACK_CHANNEL:-}"

SCHEMA_SQL_PATH="${SCHEMA_SQL_PATH:-packages/bq/src/schema.sql}"

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${IMAGE_NAME}:latest"
RUN_URL="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}:run"

# If SECRET_* not set, create placeholder secret versions.
PLACEHOLDER_SECRET_VALUE="${PLACEHOLDER_SECRET_VALUE:-REPLACE_ME}"

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

  # Query SA: read-only BigQuery access (for donation query bot)
  ensure_project_role "serviceAccount:${QUERY_SA_EMAIL}" "roles/bigquery.jobUser"
  ensure_project_role "serviceAccount:${QUERY_SA_EMAIL}" "roles/bigquery.dataViewer"

  # Scheduler SA: permission to run Cloud Run Jobs
  ensure_project_role "serviceAccount:${SCHEDULER_SA_EMAIL}" "roles/run.developer"

  # Cloud Scheduler service agent must be able to mint tokens for SCHEDULER_SA when using --oauth-service-account-email
  local project_number
  project_number="$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")"
  local scheduler_agent="service-${project_number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
  log "Ensuring Cloud Scheduler service agent can impersonate ${SCHEDULER_SA_EMAIL}: ${scheduler_agent}"
  ensure_sa_role_on_sa "${SCHEDULER_SA_EMAIL}" "serviceAccount:${scheduler_agent}" "roles/iam.serviceAccountTokenCreator"
}

ensure_secret() {
  local name="$1" envvar="$2"

  if gcloud secrets describe "${name}" >/dev/null 2>&1; then
    log "Secret ${name} exists."
  else
    log "Creating secret ${name}..."
    gcloud secrets create "${name}" --replication-policy="automatic" >/dev/null
  fi

  # If it already has a version, do not add another (idempotent).
  local vcount
  vcount="$(gcloud secrets versions list "${name}" --limit=1 --format="value(name)" 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${vcount}" -ge 1 ]; then
    log "Secret ${name} already has at least one version."
    return
  fi

  local value="${PLACEHOLDER_SECRET_VALUE}"
  if [ -n "${!envvar:-}" ]; then
    value="${!envvar}"
    log "Adding initial version for ${name} from env var ${envvar}."
  else
    log "Adding placeholder initial version for ${name}. Set ${envvar} in .env to avoid this."
  fi

  printf "%s" "${value}" | gcloud secrets versions add "${name}" --data-file=- >/dev/null
}

ensure_secrets() {
  if [ "${SKIP_SECRETS}" = "1" ]; then
    log "SKIP_SECRETS=1; skipping secrets."
    return
  fi

  log "Ensuring secrets (idempotent)..."
  ensure_secret "MERCURY_API_KEY" "SECRET_MERCURY_API_KEY"
  ensure_secret "PAYPAL_CLIENT_ID" "SECRET_PAYPAL_CLIENT_ID"
  ensure_secret "PAYPAL_SECRET" "SECRET_PAYPAL_SECRET"

  # Optional: Givebutter
  if [ -n "${SECRET_GIVEBUTTER_API_KEY:-}" ]; then
    ensure_secret "GIVEBUTTER_API_KEY" "SECRET_GIVEBUTTER_API_KEY"
  fi

  # Optional: Wise
  if [ -n "${SECRET_WISE_TOKEN:-}" ]; then
    ensure_secret "WISE_TOKEN" "SECRET_WISE_TOKEN"
  fi

  # Optional: Slack Bot Token (for reports and service)
  if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
    ensure_secret "SLACK_BOT_TOKEN" "SLACK_BOT_TOKEN"
  fi
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

  # Add Check Deposits spreadsheet ID if configured
  if [ -n "${CHECK_DEPOSITS_SPREADSHEET_ID}" ]; then
    env_vars="${env_vars},CHECK_DEPOSITS_SPREADSHEET_ID=${CHECK_DEPOSITS_SPREADSHEET_ID}"
  fi

  # Add Wise profile ID if configured
  if [ -n "${WISE_PROFILE_ID}" ]; then
    env_vars="${env_vars},WISE_PROFILE_ID=${WISE_PROFILE_ID}"
  fi

  # Add report Slack channel if configured
  if [ -n "${REPORT_SLACK_CHANNEL}" ]; then
    env_vars="${env_vars},REPORT_SLACK_CHANNEL=${REPORT_SLACK_CHANNEL}"
  fi

  local secrets
  secrets="MERCURY_API_KEY=MERCURY_API_KEY:latest,PAYPAL_CLIENT_ID=PAYPAL_CLIENT_ID:latest,PAYPAL_SECRET=PAYPAL_SECRET:latest"

  # Add Givebutter if secret exists
  if gcloud secrets describe "GIVEBUTTER_API_KEY" >/dev/null 2>&1; then
    secrets="${secrets},GIVEBUTTER_API_KEY=GIVEBUTTER_API_KEY:latest"
  fi

  # Add Wise if secret exists
  if gcloud secrets describe "WISE_TOKEN" >/dev/null 2>&1; then
    secrets="${secrets},WISE_TOKEN=WISE_TOKEN:latest"
  fi

  # Add Slack bot token if secret exists (for reports)
  if gcloud secrets describe "SLACK_BOT_TOKEN" >/dev/null 2>&1; then
    secrets="${secrets},SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest"
  fi

  if gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    gcloud run jobs update "${JOB_NAME}" \
      --region "${REGION}" \
      --image "${IMAGE_URI}" \
      --service-account "${RUNTIME_SA_EMAIL}" \
      --set-env-vars "${env_vars}" \
      --set-secrets "${secrets}" \
      --memory 1Gi \
      --cpu 1 \
      --max-retries 1 \
      --tasks 1 \
      --task-timeout 3600s >/dev/null
    log "Cloud Run Job updated."
  else
    gcloud run jobs create "${JOB_NAME}" \
      --region "${REGION}" \
      --image "${IMAGE_URI}" \
      --service-account "${RUNTIME_SA_EMAIL}" \
      --set-env-vars "${env_vars}" \
      --set-secrets "${secrets}" \
      --memory 1Gi \
      --cpu 1 \
      --max-retries 1 \
      --tasks 1 \
      --task-timeout 3600s >/dev/null
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
      --headers "Content-Type=application/json" >/dev/null
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
      --time-zone "${TIME_ZONE}" \
      --uri "${RUN_URL}" \
      --http-method POST \
      --message-body "${weekly_body}" \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --headers "Content-Type=application/json" >/dev/null
    log "Weekly report scheduler updated."
  else
    gcloud scheduler jobs create http "${weekly_name}" \
      --location "${REGION}" \
      --schedule "${weekly_schedule}" \
      --time-zone "${TIME_ZONE}" \
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
      --time-zone "${TIME_ZONE}" \
      --uri "${RUN_URL}" \
      --http-method POST \
      --message-body "${monthly_body}" \
      --oauth-service-account-email "${SCHEDULER_SA_EMAIL}" \
      --oauth-token-scope "https://www.googleapis.com/auth/cloud-platform" \
      --headers "Content-Type=application/json" >/dev/null
    log "Monthly report scheduler updated."
  else
    gcloud scheduler jobs create http "${monthly_name}" \
      --location "${REGION}" \
      --schedule "${monthly_schedule}" \
      --time-zone "${TIME_ZONE}" \
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
  ensure_bucket
  ensure_bq_datasets

  ensure_service_account "${RUNTIME_SA}" "${RUNTIME_SA_EMAIL}" "Donations ETL runtime"
  ensure_service_account "${SCHEDULER_SA}" "${SCHEDULER_SA_EMAIL}" "Donations ETL scheduler"
  ensure_service_account "${QUERY_SA}" "${QUERY_SA_EMAIL}" "Donations ETL query (read-only)"
  ensure_iam

  ensure_secrets
  apply_schema
  apply_migrations
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
