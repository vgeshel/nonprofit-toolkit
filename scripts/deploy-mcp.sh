#!/usr/bin/env bash
# Deploy the MCP server to GCP Cloud Run
#
# Usage: ./scripts/deploy-mcp.sh [--dry-run] [--skip-secrets] [--skip-build]
#
# This script:
# 1. Creates GCP secrets in Secret Manager
# 2. Builds the Docker image via Cloud Build
# 3. Deploys the Cloud Run Service
#
# Prerequisites:
# - gcloud CLI authenticated
# - .env file with PROJECT_ID, REGION, GOOGLE_CLIENT_ID, MCP_ALLOWED_DOMAIN, etc.
#
# Re-invokes itself with dotenvx to load .env variables

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[mcp]${NC} $1"; }
warn()  { echo -e "${YELLOW}[mcp]${NC} $1"; }
error() { echo -e "${RED}[mcp]${NC} $1" >&2; }
info()  { echo -e "${CYAN}[mcp]${NC} $1"; }

# Re-invoke with dotenvx if not already running under it
if [[ -z "${__MCP_DEPLOY_LOADED:-}" ]]; then
  if [[ ! -f .env ]]; then
    error ".env file not found. Copy from .env.example and configure."
    exit 1
  fi
  export __MCP_DEPLOY_LOADED=1
  exec dotenvx run -- bash "$0" "$@"
fi

# Parse arguments
DRY_RUN=false
SKIP_SECRETS=false
SKIP_BUILD=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)       DRY_RUN=true;      shift ;;
    --skip-secrets)  SKIP_SECRETS=true;  shift ;;
    --skip-build)    SKIP_BUILD=true;    shift ;;
    *)               error "Unknown option: $1"; exit 1 ;;
  esac
done

# Configuration
PROJECT_ID="${PROJECT_ID:?PROJECT_ID must be set}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-donations}"
DATASET_CANON="${DATASET_CANON:-donations}"
RUNTIME_SA="${RUNTIME_SA:-donations-etl-sa}"
RUNTIME_SA_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:?GOOGLE_CLIENT_ID must be set}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:?GOOGLE_CLIENT_SECRET must be set}"
MCP_ALLOWED_DOMAIN="${MCP_ALLOWED_DOMAIN:?MCP_ALLOWED_DOMAIN must be set}"

SERVICE_NAME="mcp-server"
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:latest"
COMPLIANCE_DISCOVER_JOB_NAME="${COMPLIANCE_DISCOVER_JOB_NAME:-compliance-discover}"

log "Deployment configuration:"
log "  Project:  ${PROJECT_ID}"
log "  Region:   ${REGION}"
log "  Service:  ${SERVICE_NAME}"
log "  Image:    ${IMAGE_URI}"
log "  SA:       ${RUNTIME_SA_EMAIL}"
log "  Domain:   @${MCP_ALLOWED_DOMAIN}"
echo ""

if [[ "$DRY_RUN" == "true" ]]; then
  warn "DRY RUN — no changes will be made"
  echo ""
fi

# ── Verify prerequisites ──────────────────────────────────────────

log "Verifying gcloud authentication..."
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  error "Not authenticated with gcloud. Run: gcloud auth login"
  exit 1
fi

if ! gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  error "Project ${PROJECT_ID} not found or not accessible"
  exit 1
fi

echo ""

# ── Firestore ────────────────────────────────────────────────────

log "Ensuring Firestore is provisioned..."
if [[ "$DRY_RUN" != "true" ]]; then
  # Enable the API (idempotent)
  gcloud services enable firestore.googleapis.com \
    --project="${PROJECT_ID}" --quiet >/dev/null 2>&1

  # Create the default database if it doesn't exist
  if ! gcloud firestore databases describe \
      --project="${PROJECT_ID}" >/dev/null 2>&1; then
    log "  Creating Firestore database in ${REGION}..."
    gcloud firestore databases create \
      --project="${PROJECT_ID}" \
      --location="${REGION}" \
      --type=firestore-native \
      --quiet >/dev/null 2>&1
  fi

  # Grant the runtime SA access
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/datastore.user" \
    --condition=None \
    --quiet >/dev/null 2>&1
  log "  Firestore ready"
fi

echo ""

# ── GCP Secrets ───────────────────────────────────────────────────

if [[ "$SKIP_SECRETS" == "true" ]]; then
  warn "Skipping secrets (--skip-secrets)"
else
  log "Ensuring secrets in Secret Manager..."

  ensure_secret() {
    local name="$1"
    local value="$2"

    if [[ "$DRY_RUN" == "true" ]]; then
      log "  Would ensure secret: ${name}"
      return
    fi

    gcloud secrets create "${name}" \
      --project="${PROJECT_ID}" \
      --replication-policy="automatic" 2>/dev/null || true

    echo -n "${value}" | gcloud secrets versions add "${name}" \
      --project="${PROJECT_ID}" \
      --data-file=- >/dev/null 2>&1

    log "  ${name} — set"
  }

  ensure_secret "MCP_GOOGLE_CLIENT_SECRET" "${GOOGLE_CLIENT_SECRET}"
  ensure_secret "ORG_NAME" "${ORG_NAME:-}"
  ensure_secret "ORG_ADDRESS" "${ORG_ADDRESS:-}"
  ensure_secret "ORG_MISSION" "${ORG_MISSION:-}"
  ensure_secret "ORG_TAX_STATUS" "${ORG_TAX_STATUS:-}"
  ensure_secret "DEFAULT_SIGNER_NAME" "${DEFAULT_SIGNER_NAME:-}"
  ensure_secret "DEFAULT_SIGNER_TITLE" "${DEFAULT_SIGNER_TITLE:-}"

  # Grant SA access to secrets
  if [[ "$DRY_RUN" != "true" ]]; then
    log "Granting ${RUNTIME_SA} access to secrets..."
    # MCP-owned secrets, plus compliance-entity-ids (which is created
    # on-demand by the compliance-onboard skill, not by this script —
    # but the MCP server still needs read access at runtime so the
    # compliance-status tool can return identifiers).
    for SECRET_NAME in MCP_GOOGLE_CLIENT_SECRET ORG_NAME ORG_ADDRESS ORG_MISSION ORG_TAX_STATUS DEFAULT_SIGNER_NAME DEFAULT_SIGNER_TITLE compliance-entity-ids; do
      gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
        --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
        --role="roles/secretmanager.secretAccessor" \
        --project="${PROJECT_ID}" \
        --quiet >/dev/null 2>&1 || warn "  Skipping grant on ${SECRET_NAME} (secret may not exist yet)"
    done
    log "  Access granted"
  fi
fi

echo ""

# ── Build ─────────────────────────────────────────────────────────

if [[ "$SKIP_BUILD" == "true" ]]; then
  warn "Skipping build (--skip-build)"
else
  log "Building Docker image via Cloud Build..."
  if [[ "$DRY_RUN" == "true" ]]; then
    log "  Would run: gcloud builds submit --tag ${IMAGE_URI} --dockerfile apps/mcp/Dockerfile"
  else
    gcloud builds submit \
      --project "${PROJECT_ID}" \
      --config apps/mcp/cloudbuild.yaml \
      --substitutions "_IMAGE_URI=${IMAGE_URI}" \
      --quiet \
      .
    log "Build complete."
  fi
fi

echo ""

# ── Deploy ────────────────────────────────────────────────────────

log "Deploying Cloud Run Service..."
if [[ "$DRY_RUN" == "true" ]]; then
  log "  Would deploy ${SERVICE_NAME} to Cloud Run"
else
  # If the service already exists, read its URL so we can deploy with
  # the correct BASE_URL in a single step. Otherwise, use a placeholder
  # and patch it after the first deploy creates the service.
  EXISTING_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --format='value(status.url)' 2>/dev/null || echo '')

  if [[ -n "${EXISTING_URL}" ]]; then
    BASE_URL_VALUE="${EXISTING_URL}"
    log "  Reusing existing service URL: ${BASE_URL_VALUE}"
  else
    BASE_URL_VALUE="https://placeholder.example.com"
    log "  First deploy — BASE_URL will be patched after the service is created"
  fi

  gcloud run deploy "${SERVICE_NAME}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --image "${IMAGE_URI}" \
    --service-account "${RUNTIME_SA_EMAIL}" \
    --set-env-vars "\
PROJECT_ID=${PROJECT_ID},\
DATASET_CANON=${DATASET_CANON},\
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},\
MCP_ALLOWED_DOMAIN=${MCP_ALLOWED_DOMAIN},\
BASE_URL=${BASE_URL_VALUE},\
COMPLIANCE_BROWSER_HEADLESS=1" \
    --set-secrets "\
GOOGLE_CLIENT_SECRET=MCP_GOOGLE_CLIENT_SECRET:latest,\
ORG_NAME=ORG_NAME:latest,\
ORG_ADDRESS=ORG_ADDRESS:latest,\
ORG_MISSION=ORG_MISSION:latest,\
ORG_TAX_STATUS=ORG_TAX_STATUS:latest,\
DEFAULT_SIGNER_NAME=DEFAULT_SIGNER_NAME:latest,\
DEFAULT_SIGNER_TITLE=DEFAULT_SIGNER_TITLE:latest" \
    --memory 4Gi \
    --cpu 2 \
    --min-instances 0 \
    --max-instances 3 \
    --timeout 600s \
    --port 8080 \
    --allow-unauthenticated \
    --quiet

  # Read the actual service URL (it's stable across deploys, so for
  # redeploys this matches what we already passed in)
  SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --format='value(status.url)')

  # Only patch BASE_URL on the first deploy (when we used the placeholder)
  if [[ "${BASE_URL_VALUE}" != "${SERVICE_URL}" ]]; then
    log "Patching BASE_URL to ${SERVICE_URL}..."
    gcloud run services update "${SERVICE_NAME}" \
      --region "${REGION}" \
      --project "${PROJECT_ID}" \
      --update-env-vars "BASE_URL=${SERVICE_URL}" \
      --quiet
  fi

  log "Deploy complete."
fi

echo ""

# ── Compliance discovery Cloud Run Job ────────────────────────────
# The compliance-discover-start MCP tool triggers an execution of this
# Job (same image, different entrypoint) so discovery runs out-of-band —
# surviving the service scaling to zero and the 600s request timeout.

log "Ensuring Cloud Run Job: ${COMPLIANCE_DISCOVER_JOB_NAME}..."
if [[ "$DRY_RUN" == "true" ]]; then
  log "  Would create/update job ${COMPLIANCE_DISCOVER_JOB_NAME} (entrypoint: bun dist/compliance-discover-job.js)"
  log "  Would grant ${RUNTIME_SA_EMAIL} permission to run it"
else
  JOB_ENV="PROJECT_ID=${PROJECT_ID},DATASET_CANON=${DATASET_CANON},REGION=${REGION},COMPLIANCE_BROWSER_HEADLESS=1"
  if gcloud run jobs describe "${COMPLIANCE_DISCOVER_JOB_NAME}" \
      --region "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud run jobs update "${COMPLIANCE_DISCOVER_JOB_NAME}" \
      --region "${REGION}" --project "${PROJECT_ID}" \
      --image "${IMAGE_URI}" \
      --service-account "${RUNTIME_SA_EMAIL}" \
      --command bun \
      --args dist/compliance-discover-job.js \
      --set-env-vars "${JOB_ENV}" \
      --memory 4Gi --cpu 2 --max-retries 1 --tasks 1 --task-timeout 3600s \
      --quiet
    log "  Job updated."
  else
    gcloud run jobs create "${COMPLIANCE_DISCOVER_JOB_NAME}" \
      --region "${REGION}" --project "${PROJECT_ID}" \
      --image "${IMAGE_URI}" \
      --service-account "${RUNTIME_SA_EMAIL}" \
      --command bun \
      --args dist/compliance-discover-job.js \
      --set-env-vars "${JOB_ENV}" \
      --memory 4Gi --cpu 2 --max-retries 1 --tasks 1 --task-timeout 3600s \
      --quiet
    log "  Job created."
  fi

  # Let the MCP service's runtime SA trigger executions of this Job.
  # roles/run.invoker carries run.jobs.run for job execution; if a future
  # IAM change requires more, grant roles/run.developer instead.
  gcloud run jobs add-iam-policy-binding "${COMPLIANCE_DISCOVER_JOB_NAME}" \
    --region "${REGION}" --project "${PROJECT_ID}" \
    --member "serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role "roles/run.invoker" \
    --quiet >/dev/null
  log "  Granted ${RUNTIME_SA_EMAIL} run.invoker on the job."
fi

echo ""

# ── Summary ───────────────────────────────────────────────────────

if [[ "$DRY_RUN" == "false" ]]; then
  echo ""
  log "Done!"
  echo ""
  info "Service URL:  ${SERVICE_URL}"
  info "MCP endpoint: ${SERVICE_URL}/mcp"
  info "Health check: curl ${SERVICE_URL}/health"
  echo ""
  info "Google OAuth redirect URI (add to GCP Console):"
  info "  ${SERVICE_URL}/oauth/google/callback"
  echo ""
  info "Add to .mcp.json:"
  echo ""
  echo "  \"mcpServers\": {"
  echo "    \"donations\": {"
  echo "      \"type\": \"http\","
  echo "      \"url\": \"${SERVICE_URL}/mcp\""
  echo "    }"
  echo "  }"
fi
