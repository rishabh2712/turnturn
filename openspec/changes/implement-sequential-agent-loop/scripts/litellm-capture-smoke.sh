#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${LITELLM_BASE_URL:-https://litellm.test.asapp.com}"
MODEL="${LITELLM_MODEL:-}"
PROXY_PORT="${CAPTURE_LISTEN_PORT:-8765}"
CASE="${CAPTURE_CASE:-litellm-openai-chat-smoke}"
CHANGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${LITELLM_API_KEY:-}" ]]; then
  echo "LITELLM_API_KEY is required. Export a fresh LiteLLM key before running." >&2
  exit 2
fi

if [[ "${1:-}" == "models" ]]; then
  curl --fail --show-error --silent \
    "${BASE_URL}/v2/model/info?include_team_models=true&page=1&size=50" \
    -H "Authorization: Bearer ${LITELLM_API_KEY}" \
    -H "Content-Type: application/json"
  echo
  exit 0
fi

if [[ -z "${MODEL}" ]]; then
  echo "LITELLM_MODEL is required for streaming smoke tests." >&2
  echo "Run '$0 models' first, then export one model name as LITELLM_MODEL." >&2
  exit 2
fi

request_body="$(
  python3 - "${MODEL}" <<'PY'
import json
import sys

print(json.dumps({
    "model": sys.argv[1],
    "stream": True,
    "messages": [
        {"role": "user", "content": "Say hello in one short sentence."}
    ],
}))
PY
)"

if [[ "${1:-}" == "direct" ]]; then
  curl --fail --show-error --no-buffer \
    "${BASE_URL}/v1/chat/completions" \
    -H "Authorization: Bearer ${LITELLM_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "${request_body}"
  exit 0
fi

if [[ "${1:-}" != "proxy" ]]; then
  echo "Usage:" >&2
  echo "  $0 models   # list available LiteLLM models" >&2
  echo "  $0 direct   # stream directly from LiteLLM" >&2
  echo "  $0 proxy    # stream through scripts/capture-provider-streams.py" >&2
  exit 2
fi

CAPTURE_UPSTREAM_BASE_URL="${BASE_URL}" \
CAPTURE_PROVIDER=litellm \
CAPTURE_CASE="${CASE}" \
CAPTURE_LISTEN_PORT="${PROXY_PORT}" \
python3 "${CHANGE_DIR}/scripts/capture-provider-streams.py" &
proxy_pid="$!"
trap 'kill "${proxy_pid}" 2>/dev/null || true' EXIT

sleep 1

curl --fail --show-error --no-buffer \
  "http://127.0.0.1:${PROXY_PORT}/v1/chat/completions" \
  -H "Authorization: Bearer ${LITELLM_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${request_body}"
