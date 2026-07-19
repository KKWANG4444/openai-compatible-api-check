#!/bin/sh
set -u

base_url="${1:-}"
model="${2:-}"
api_key="${3:-}"
timeout="${4:-30000}"
report_path="${5:-reports/openai-compatible-api-check.md}"

if [ -z "$base_url" ]; then
  echo "error: input base-url is required" >&2
  exit 2
fi
if [ -z "$model" ]; then
  echo "error: input model is required" >&2
  exit 2
fi
if [ -z "$api_key" ]; then
  echo "error: input api-key is required" >&2
  exit 2
fi

workspace="${GITHUB_WORKSPACE:-$(pwd)}"
case "$report_path" in
  /*)
    echo "error: input report-path must be relative to the workspace" >&2
    exit 2
    ;;
  *'..'*)
    echo "error: input report-path cannot contain .." >&2
    exit 2
    ;;
esac
absolute_report_path="$workspace/$report_path"

root="${MODEL_API_CHECK_ROOT:-/opt/model-api-check}"
export MODEL_API_CHECK_KEY="$api_key"
set +e
node "$root/bin/model-api-check.mjs" \
  --base-url "$base_url" \
  --model "$model" \
  --key-env MODEL_API_CHECK_KEY \
  --timeout "$timeout" \
  --format markdown \
  --output "$absolute_report_path"
status=$?
set -e
unset MODEL_API_CHECK_KEY

result=failed
if [ "$status" -eq 0 ]; then
  result=passed
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'report-path=%s\nresult=%s\n' "$report_path" "$result" >> "$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '# OpenAI Compatible API Check\n\n'
    printf -- '- Result: `%s`\n' "$result"
    printf -- '- Model: `%s`\n' "$model"
    printf -- '- Report: `%s`\n\n' "$report_path"
    if [ -f "$absolute_report_path" ]; then
      cat "$absolute_report_path"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

exit "$status"
