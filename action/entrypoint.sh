#!/bin/sh
set -u

if [ -z "${INPUT_BASE_URL:-}" ]; then
  echo "error: input base-url is required" >&2
  exit 2
fi
if [ -z "${INPUT_MODEL:-}" ]; then
  echo "error: input model is required" >&2
  exit 2
fi
if [ -z "${INPUT_API_KEY:-}" ]; then
  echo "error: input api-key is required" >&2
  exit 2
fi

report_path="${INPUT_REPORT_PATH:-reports/openai-compatible-api-check.md}"
timeout="${INPUT_TIMEOUT:-30000}"
workspace="${GITHUB_WORKSPACE:-$(pwd)}"
case "$report_path" in
  /*) absolute_report_path="$report_path" ;;
  *) absolute_report_path="$workspace/$report_path" ;;
esac

root="${MODEL_API_CHECK_ROOT:-/opt/model-api-check}"
export MODEL_API_CHECK_KEY="$INPUT_API_KEY"
set +e
node "$root/bin/model-api-check.mjs" \
  --base-url "$INPUT_BASE_URL" \
  --model "$INPUT_MODEL" \
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
    printf -- '- Model: `%s`\n' "$INPUT_MODEL"
    printf -- '- Report: `%s`\n\n' "$report_path"
    if [ -f "$absolute_report_path" ]; then
      cat "$absolute_report_path"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi

exit "$status"
