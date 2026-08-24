#!/bin/sh

set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -z "${AI_GATEWAY_BASE_URL:-}" ]; then
  echo "AI_GATEWAY_BASE_URL is required (for example, https://ai-gateway.example.workers.dev)." >&2
  exit 1
fi
gateway_base_url=$AI_GATEWAY_BASE_URL
gateway_base_url=${gateway_base_url%/}

if [ -z "${MANAGEMENT_API_KEY:-}" ]; then
  if [ ! -f "$project_dir/.dev.vars" ]; then
    echo "MANAGEMENT_API_KEY is not set and $project_dir/.dev.vars does not exist." >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1091
  . "$project_dir/.dev.vars"
  set +a
fi

if [ -z "${MANAGEMENT_API_KEY:-}" ]; then
  echo "MANAGEMENT_API_KEY is required." >&2
  exit 1
fi

for command_name in curl jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "$command_name is required." >&2
    exit 1
  fi
done

register_app() {
  app_id=$1
  config_path=$2

  curl -fsS \
    -X POST \
    "$gateway_base_url/v1/admin/apps/$app_id" \
    -H "Authorization: Bearer $MANAGEMENT_API_KEY" \
    -H "Content-Type: application/json" \
    --data-binary "@$project_dir/$config_path" |
    jq '{
      id: .app.id,
      name: .app.name,
      status: .app.status,
      bundle_id: .app.authentication.app_attest.bundle_id,
      appattest_environments: .app.authentication.app_attest.environments,
      required_claims: .app.authentication.issuer.required_claims,
      dev_access_enabled: .app.authentication.development_access,
      provider_mode: .app.routing.providerMode,
      endpoints: (.app.endpoints // {} | keys)
    }'
}

register_app calorie-tracker-dev config/calorie-tracker.dev.json
register_app calorie-tracker config/calorie-tracker.production.json
