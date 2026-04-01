#!/usr/bin/env bash
# Deploy the service to GCP Cloud Run with Slack app provisioning
#
# Usage: ./scripts/deploy-service.sh [--dry-run] [--skip-secrets] [--skip-build] [--skip-slack]
#
# This script:
# 1. Creates a Slack app via the Slack API (idempotent — skips if app ID in .env)
# 2. Installs the app to your workspace and retrieves the bot token
# 3. Creates GCP secrets in Secret Manager
# 4. Builds the Docker image via Cloud Build
# 5. Deploys the Cloud Run Service
# 6. Updates the Slack app manifest with the final Cloud Run URL
#
# Prerequisites:
# - gcloud CLI authenticated
# - slack CLI authenticated (run `slack login` first)
# - .env file with PROJECT_ID, REGION, etc.
#
# Re-invokes itself with dotenvx to load .env variables

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[service]${NC} $1"; }
warn()  { echo -e "${YELLOW}[service]${NC} $1"; }
error() { echo -e "${RED}[service]${NC} $1" >&2; }
info()  { echo -e "${CYAN}[service]${NC} $1"; }

# Re-invoke with dotenvx if not already running under it
if [[ -z "${__LETTER_DEPLOY_LOADED:-}" ]]; then
  if [[ ! -f .env ]]; then
    error ".env file not found. Copy from .env.example and configure."
    exit 1
  fi
  export __LETTER_DEPLOY_LOADED=1
  exec dotenvx run -- bash "$0" "$@"
fi

# Parse arguments
DRY_RUN=false
SKIP_SECRETS=false
SKIP_BUILD=false
SKIP_SLACK=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)       DRY_RUN=true;      shift ;;
    --skip-secrets)  SKIP_SECRETS=true;  shift ;;
    --skip-build)    SKIP_BUILD=true;    shift ;;
    --skip-slack)    SKIP_SLACK=true;    shift ;;
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

SERVICE_NAME="letter-service"  # Cloud Run service name (kept for backward compatibility)
IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:latest"

# Slack app state (may be set in .env from a previous run)
SLACK_APP_ID="${SLACK_APP_ID:-}"
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"

log "Deployment configuration:"
log "  Project:  ${PROJECT_ID}"
log "  Region:   ${REGION}"
log "  Service:  ${SERVICE_NAME}"
log "  Image:    ${IMAGE_URI}"
log "  SA:       ${RUNTIME_SA_EMAIL}"
if [[ -n "$SLACK_APP_ID" ]]; then
  log "  Slack App: ${SLACK_APP_ID} (from .env)"
fi
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

# ── Slack app provisioning ────────────────────────────────────────

if [[ "$SKIP_SLACK" == "true" ]]; then
  warn "Skipping Slack provisioning (--skip-slack)"
elif [[ "$DRY_RUN" == "true" ]]; then
  log "Would create/update Slack app via API"
else
  # Get a Slack config token — check env/arg first, then prompt
  SLACK_CONFIG_TOKEN="${SLACK_CONFIG_TOKEN:-}"
  if [[ -z "$SLACK_CONFIG_TOKEN" ]]; then
    echo ""
    warn "Need a Slack config token to create the app."
    echo "  Run this in another terminal:  slack auth token"
    echo "  (It will ask you to paste a command into Slack, then give you a token)"
    echo ""
    echo -n "  Paste the service token (xoxp-...): "
    read -r SLACK_CONFIG_TOKEN
    if [[ -z "$SLACK_CONFIG_TOKEN" || ! "$SLACK_CONFIG_TOKEN" == xox* ]]; then
      error "Invalid token. Must start with xoxp- or xoxe-"
      exit 1
    fi
  fi
  log "  Got config token: ${SLACK_CONFIG_TOKEN:0:12}..."

  if [[ -z "$SLACK_APP_ID" ]]; then
    # ── Create the Slack app ──────────────────────────────────────
    log "Creating Slack app via apps.manifest.create..."

    # Build the manifest JSON. Use a placeholder URL — we'll update it after deploy.
    MANIFEST=$(cat <<'MANIFEST_EOF'
{
  "display_information": {
    "name": "Donor Letter",
    "description": "Generate donor confirmation letters"
  },
  "features": {
    "bot_user": {
      "display_name": "Donor Letter",
      "always_online": true
    },
    "slash_commands": [
      {
        "command": "/donor-letter",
        "url": "https://placeholder.example.com/slack/commands",
        "description": "Generate a donor confirmation letter",
        "usage_hint": "(opens a form)"
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": ["commands", "chat:write", "files:write"]
    }
  },
  "settings": {
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://placeholder.example.com/slack/interactivity"
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false
  }
}
MANIFEST_EOF
)

    # Escape the manifest for the API call
    MANIFEST_ESCAPED=$(echo "$MANIFEST" | jq -c .)

    CREATE_RESPONSE=$(curl -s -X POST "https://slack.com/api/apps.manifest.create" \
      -H "Authorization: Bearer ${SLACK_CONFIG_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"manifest\": ${MANIFEST_ESCAPED}}")

    CREATE_OK=$(echo "$CREATE_RESPONSE" | jq -r '.ok')
    if [[ "$CREATE_OK" != "true" ]]; then
      CREATE_ERROR=$(echo "$CREATE_RESPONSE" | jq -r '.error // "unknown error"')
      error "Failed to create Slack app: ${CREATE_ERROR}"
      echo "$CREATE_RESPONSE" | jq . >&2
      exit 1
    fi

    SLACK_APP_ID=$(echo "$CREATE_RESPONSE" | jq -r '.app_id')
    SLACK_SIGNING_SECRET=$(echo "$CREATE_RESPONSE" | jq -r '.credentials.signing_secret')
    SLACK_CLIENT_ID=$(echo "$CREATE_RESPONSE" | jq -r '.credentials.client_id')
    SLACK_CLIENT_SECRET=$(echo "$CREATE_RESPONSE" | jq -r '.credentials.client_secret')

    log "  App created: ${SLACK_APP_ID}"
    log "  Signing secret: ${SLACK_SIGNING_SECRET:0:8}..."

    # Save app ID to .env for future runs
    if ! grep -q "^SLACK_APP_ID=" .env 2>/dev/null; then
      echo "" >> .env
      echo "# Letter Service Slack App (auto-generated)" >> .env
      echo "SLACK_APP_ID=${SLACK_APP_ID}" >> .env
      log "  Saved SLACK_APP_ID to .env"
    fi
  else
    log "Slack app ${SLACK_APP_ID} already exists (from .env)"

    # Read existing signing secret from Secret Manager if available
    if [[ -z "$SLACK_SIGNING_SECRET" ]]; then
      SLACK_SIGNING_SECRET=$(gcloud secrets versions access latest \
        --secret=SLACK_SIGNING_SECRET \
        --project="${PROJECT_ID}" 2>/dev/null || echo "")
    fi
  fi

  # ── Install the app to workspace ────────────────────────────────
  # Check if we already have a bot token
  if [[ -z "$SLACK_BOT_TOKEN" ]]; then
    SLACK_BOT_TOKEN=$(gcloud secrets versions access latest \
      --secret=SLACK_BOT_TOKEN \
      --project="${PROJECT_ID}" 2>/dev/null || echo "")
  fi

  if [[ -z "$SLACK_BOT_TOKEN" || "$SLACK_BOT_TOKEN" == "placeholder" ]]; then
    echo ""
    warn "The app needs to be installed to your workspace to get a bot token."
    warn "Opening the install page in your browser..."
    echo ""

    INSTALL_URL="https://api.slack.com/apps/${SLACK_APP_ID}/install-on-team"
    if command -v open >/dev/null 2>&1; then
      open "$INSTALL_URL"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$INSTALL_URL"
    else
      info "Open this URL: ${INSTALL_URL}"
    fi

    echo ""
    echo "  After installing, go to: https://api.slack.com/apps/${SLACK_APP_ID}/oauth"
    echo "  Copy the 'Bot User OAuth Token' (starts with xoxb-)"
    echo ""
    echo -n "  Paste the bot token here: "
    read -r SLACK_BOT_TOKEN

    if [[ -z "$SLACK_BOT_TOKEN" || ! "$SLACK_BOT_TOKEN" == xoxb-* ]]; then
      error "Invalid bot token. Must start with xoxb-"
      exit 1
    fi

    log "  Bot token received: ${SLACK_BOT_TOKEN:0:12}..."
  else
    log "Bot token already configured"
  fi
fi

echo ""

# ── GCP Secrets ───────────────────────────────────────────────────

if [[ "$SKIP_SECRETS" == "true" ]]; then
  warn "Skipping secrets (--skip-secrets)"
else
  log "Ensuring secrets in Secret Manager..."

  # Helper to create or update a secret
  ensure_secret() {
    local name="$1"
    local value="$2"

    if [[ "$DRY_RUN" == "true" ]]; then
      log "  Would ensure secret: ${name}"
      return
    fi

    # Create the secret if it doesn't exist
    gcloud secrets create "${name}" \
      --project="${PROJECT_ID}" \
      --replication-policy="automatic" 2>/dev/null || true

    # Add the value as a new version
    echo -n "${value}" | gcloud secrets versions add "${name}" \
      --project="${PROJECT_ID}" \
      --data-file=- >/dev/null 2>&1

    log "  ${name} — set"
  }

  # Generate API key if not already in Secret Manager
  SERVICE_API_KEY="${SERVICE_API_KEY:-}"
  if [[ -z "$SERVICE_API_KEY" ]]; then
    SERVICE_API_KEY=$(gcloud secrets versions access latest \
      --secret=SERVICE_API_KEY \
      --project="${PROJECT_ID}" 2>/dev/null || echo "")
  fi
  if [[ -z "$SERVICE_API_KEY" ]]; then
    SERVICE_API_KEY=$(openssl rand -hex 32)
    log "  SERVICE_API_KEY — generated"
  fi

  ensure_secret "LETTER_SERVICE_API_KEY" "$SERVICE_API_KEY"
  ensure_secret "SLACK_BOT_TOKEN" "${SLACK_BOT_TOKEN:-placeholder}"
  ensure_secret "SLACK_SIGNING_SECRET" "${SLACK_SIGNING_SECRET:-placeholder}"
  ensure_secret "GOOGLE_GENERATIVE_AI_API_KEY" "${GOOGLE_GENERATIVE_AI_API_KEY:-placeholder}"
  ensure_secret "ORG_NAME" "${ORG_NAME:-}"
  ensure_secret "ORG_ADDRESS" "${ORG_ADDRESS:-}"
  ensure_secret "ORG_MISSION" "${ORG_MISSION:-}"
  ensure_secret "ORG_TAX_STATUS" "${ORG_TAX_STATUS:-}"
  ensure_secret "DEFAULT_SIGNER_NAME" "${DEFAULT_SIGNER_NAME:-}"
  ensure_secret "DEFAULT_SIGNER_TITLE" "${DEFAULT_SIGNER_TITLE:-}"

  # Grant SA access to secrets
  if [[ "$DRY_RUN" != "true" ]]; then
    log "Granting ${RUNTIME_SA} access to secrets..."
    for SECRET_NAME in LETTER_SERVICE_API_KEY SLACK_BOT_TOKEN SLACK_SIGNING_SECRET GOOGLE_GENERATIVE_AI_API_KEY ORG_NAME ORG_ADDRESS ORG_MISSION ORG_TAX_STATUS DEFAULT_SIGNER_NAME DEFAULT_SIGNER_TITLE; do
      gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
        --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
        --role="roles/secretmanager.secretAccessor" \
        --project="${PROJECT_ID}" \
        --quiet >/dev/null 2>&1
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
    log "  Would run: gcloud builds submit --tag ${IMAGE_URI} --dockerfile apps/service/Dockerfile"
  else
    gcloud builds submit \
      --project "${PROJECT_ID}" \
      --config apps/service/cloudbuild.yaml \
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
  gcloud run deploy "${SERVICE_NAME}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --image "${IMAGE_URI}" \
    --service-account "${RUNTIME_SA_EMAIL}" \
    --set-env-vars "PROJECT_ID=${PROJECT_ID},DATASET_CANON=${DATASET_CANON}" \
    --set-secrets "\
SERVICE_API_KEY=LETTER_SERVICE_API_KEY:latest,\
SLACK_BOT_TOKEN=SLACK_BOT_TOKEN:latest,\
SLACK_SIGNING_SECRET=SLACK_SIGNING_SECRET:latest,\
GOOGLE_GENERATIVE_AI_API_KEY=GOOGLE_GENERATIVE_AI_API_KEY:latest,\
ORG_NAME=ORG_NAME:latest,\
ORG_ADDRESS=ORG_ADDRESS:latest,\
ORG_MISSION=ORG_MISSION:latest,\
ORG_TAX_STATUS=ORG_TAX_STATUS:latest,\
DEFAULT_SIGNER_NAME=DEFAULT_SIGNER_NAME:latest,\
DEFAULT_SIGNER_TITLE=DEFAULT_SIGNER_TITLE:latest" \
    --memory 1Gi \
    --cpu 1 \
    --min-instances 0 \
    --max-instances 3 \
    --timeout 120s \
    --port 8080 \
    --allow-unauthenticated \
    --quiet

  log "Deploy complete."
fi

echo ""

# ── Update Slack app with real URLs ───────────────────────────────

if [[ "$DRY_RUN" == "false" ]]; then
  SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
    --region "${REGION}" \
    --project "${PROJECT_ID}" \
    --format='value(status.url)')

  if [[ -n "$SLACK_APP_ID" && "$SKIP_SLACK" != "true" ]]; then
    log "Updating Slack app manifest with service URL..."

    SLACK_CONFIG_TOKEN="${SLACK_CONFIG_TOKEN:-$(slack auth token 2>/dev/null | tr -d '[:space:]')}"

    UPDATED_MANIFEST=$(cat <<MANIFEST_EOF
{
  "display_information": {
    "name": "Donor Letter",
    "description": "Generate donor confirmation letters"
  },
  "features": {
    "bot_user": {
      "display_name": "Donor Letter",
      "always_online": true
    },
    "slash_commands": [
      {
        "command": "/donor-letter",
        "url": "${SERVICE_URL}/slack/commands",
        "description": "Generate a donor confirmation letter",
        "usage_hint": "(opens a form)"
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": ["commands", "chat:write", "files:write"]
    }
  },
  "settings": {
    "interactivity": {
      "is_enabled": true,
      "request_url": "${SERVICE_URL}/slack/interactivity"
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false
  }
}
MANIFEST_EOF
)

    UPDATED_MANIFEST_ESCAPED=$(echo "$UPDATED_MANIFEST" | jq -c .)

    UPDATE_RESPONSE=$(curl -s -X POST "https://slack.com/api/apps.manifest.update" \
      -H "Authorization: Bearer ${SLACK_CONFIG_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"app_id\": \"${SLACK_APP_ID}\", \"manifest\": ${UPDATED_MANIFEST_ESCAPED}}")

    UPDATE_OK=$(echo "$UPDATE_RESPONSE" | jq -r '.ok')
    if [[ "$UPDATE_OK" == "true" ]]; then
      log "  Slack app manifest updated with ${SERVICE_URL}"
    else
      UPDATE_ERROR=$(echo "$UPDATE_RESPONSE" | jq -r '.error // "unknown error"')
      warn "  Failed to update manifest: ${UPDATE_ERROR}"
      warn "  You may need to update URLs manually at https://api.slack.com/apps/${SLACK_APP_ID}"
    fi
  fi

  # ── Summary ───────────────────────────────────────────────────

  API_KEY=$(gcloud secrets versions access latest \
    --secret=SERVICE_API_KEY \
    --project="${PROJECT_ID}" 2>/dev/null || echo "<could not read>")

  echo ""
  log "Done!"
  echo ""
  info "Service URL:  ${SERVICE_URL}"
  info "Health check: curl ${SERVICE_URL}/health"
  echo ""
  info "Test the API:"
  echo "  curl -X POST ${SERVICE_URL}/api/generate-letter \\"
  echo "    -H 'Authorization: Bearer ${API_KEY}' \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\"emails\": [\"donor@example.com\"], \"format\": \"html\"}'"
  echo ""
  if [[ -n "$SLACK_APP_ID" ]]; then
    info "Slack app:    https://api.slack.com/apps/${SLACK_APP_ID}"
    info "Try it:       Type /donor-letter in any Slack channel"
  fi
fi
