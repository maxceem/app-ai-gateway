#!/bin/sh

set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -z "${AI_GATEWAY_BASE_URL:-}" ]; then
  echo "AI_GATEWAY_BASE_URL is required (for example, https://ai-gateway.example.workers.dev)." >&2
  exit 1
fi
gateway_base_url=$AI_GATEWAY_BASE_URL
gateway_base_url=${gateway_base_url%/}

if [ -z "${ADMIN_TOKEN:-}" ]; then
  if [ ! -f "$project_dir/.dev.vars" ]; then
    echo "ADMIN_TOKEN is not set and $project_dir/.dev.vars does not exist." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  . "$project_dir/.dev.vars"
  set +a
fi

if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ADMIN_TOKEN is required." >&2
  exit 1
fi

for command_name in curl jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required." >&2
    exit 1
  fi
done

curl -fsS \
    -X POST \
    "$gateway_base_url/v1/admin/apps/calorie-tracker-dev" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary "@$project_dir/config/calorie-tracker.development.json" |
  jq '{
    id: .app.id,
    status: .app.status,
    appattest_environments: .app.authentication.app_attest.environments,
    required_claims: .app.authentication.issuer.required_claims,
    dev_access_enabled: .app.authentication.development_access,
    provider_mode: .app.routing.providerMode
  }'

curl -fsS \
  -X POST \
  "$gateway_base_url/v1/admin/apps/calorie-tracker-dev/development-credential" \
  -H "Authorization: Bearer $ADMIN_TOKEN" |
  jq '{
    development_secret: .secret,
    secret_prefix: .secret_prefix,
    warning: "Copy development_secret now; the gateway stores only its hash."
  }'

curl -fsS \
  -X POST \
  "$gateway_base_url/v1/admin/apps/calorie-tracker" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$project_dir/config/calorie-tracker.production.json" |
  jq '{
    id: .app.id,
    status: .app.status,
    appattest_environments: .app.authentication.app_attest.environments,
    required_claims: .app.authentication.issuer.required_claims,
    dev_access_enabled: .app.authentication.development_access,
    provider_mode: .app.routing.providerMode
  }'
