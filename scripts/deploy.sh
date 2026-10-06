#!/usr/bin/env bash
# Deploy ETL code to GCP Cloud Run Job
#
# Usage: ./scripts/deploy.sh [--dry-run]
#
# This script:
# 1. Builds the Docker image via Cloud Build
# 2. Updates the existing Cloud Run Job with the new image
#
# Prerequisites:
# - gcloud CLI authenticated
# - .env file with PROJECT_ID, REGION, etc.
#
# Re-invokes itself with dotenvx to load .env variables

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $1"; }
error() { echo -e "${RED}[deploy]${NC} $1" >&2; }

# Re-invoke with dotenvx if not already running under it
if [[ -z "${__DEPLOY_DOTENVX_LOADED:-}" ]]; then
  if [[ ! -f .env ]]; then
    error ".env file not found. Copy from .env.example and configure."
    exit 1
  fi
  export __DEPLOY_DOTENVX_LOADED=1
  exec dotenvx run --overload -- bash "$0" "$@"
fi

# Parse arguments
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Configuration with defaults (loaded from .env via dotenvx)
PROJECT_ID="${PROJECT_ID:?PROJECT_ID must be set}"
REGION="${REGION:-us-central1}"
AR_REPO="${AR_REPO:-donations}"
IMAGE_NAME="${IMAGE_NAME:-etl}"
JOB_NAME="${JOB_NAME:-donations-etl}"

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${IMAGE_NAME}:latest"

log "Deployment configuration:"
log "  Project:    ${PROJECT_ID}"
log "  Region:     ${REGION}"
log "  Image:      ${IMAGE_URI}"
log "  Job:        ${JOB_NAME}"

if [[ "$DRY_RUN" == "true" ]]; then
  warn "DRY RUN - no changes will be made"
fi

# Verify gcloud is authenticated
log "Verifying gcloud authentication..."
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  error "Not authenticated with gcloud. Run: gcloud auth login"
  exit 1
fi

# Verify project exists
if ! gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  error "Project ${PROJECT_ID} not found or not accessible"
  exit 1
fi

# Verify Cloud Run Job exists
log "Verifying Cloud Run Job exists..."
if ! gcloud run jobs describe "${JOB_NAME}" --region "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  error "Cloud Run Job '${JOB_NAME}' not found in ${REGION}"
  error "Run the provision script first: ./infra/provision.sh"
  exit 1
fi

# Build and push image via Cloud Build
log "Building and pushing Docker image via Cloud Build..."
if [[ "$DRY_RUN" == "true" ]]; then
  log "  Would run: gcloud builds submit --tag ${IMAGE_URI}"
else
  gcloud builds submit \
    --tag "${IMAGE_URI}" \
    --project "${PROJECT_ID}" \
    --quiet \
    .
fi

# Update Cloud Run Job with new image
log "Updating Cloud Run Job with new image..."
if [[ "$DRY_RUN" == "true" ]]; then
  log "  Would run: gcloud run jobs update ${JOB_NAME} --image ${IMAGE_URI}"
else
  gcloud run jobs update "${JOB_NAME}" \
    --image "${IMAGE_URI}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --quiet
fi

log "Deployment complete!"
log ""
log "To run the job manually:"
log "  gcloud run jobs execute ${JOB_NAME} --region ${REGION}"
log ""
log "To check job status:"
log "  gcloud run jobs executions list --job ${JOB_NAME} --region ${REGION}"
