#!/bin/zsh

set -euo pipefail

readonly SCRIPT_DIR="${0:A:h}"
readonly PROJECT_DIR="${SCRIPT_DIR:h}"
readonly BASE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

node_bin_dir="${STOCK_DAILY_NODE_BIN_DIR:-}"
if [[ -z "${node_bin_dir}" ]]; then
  for candidate in /opt/homebrew/bin /usr/local/bin /usr/bin "${HOME}"/.nvm/versions/node/*/bin(N); do
    [[ -x "${candidate}/node" && -x "${candidate}/npm" ]] || continue
    node_major="$("${candidate}/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
    [[ "${node_major}" == <-> ]] || continue
    (( node_major >= 22 )) || continue
    node_bin_dir="${candidate}"
    break
  done
fi
if [[ -z "${node_bin_dir}" || ! -x "${node_bin_dir}/node" || ! -x "${node_bin_dir}/npm" ]]; then
  echo "Node.js >= 22 not found; set STOCK_DAILY_NODE_BIN_DIR" >&2
  exit 127
fi
readonly NODE_BIN_DIR="${node_bin_dir}"
export PATH="${NODE_BIN_DIR}:${BASE_PATH}"

codex_bin="${STOCK_DAILY_CODEX_BIN:-$(command -v codex 2>/dev/null || true)}"
if [[ -z "${codex_bin}" || ! -x "${codex_bin}" ]]; then
  echo "Codex CLI not found; set STOCK_DAILY_CODEX_BIN" >&2
  exit 127
fi
readonly CODEX_BIN="${codex_bin}"
readonly LOCK_DIR="/tmp/stock-daily-codex.lock"
readonly LOG_FILE="${PROJECT_DIR}/work/daily-task.log"
readonly AGENT_EVENTS_FILE="${PROJECT_DIR}/work/daily-agent-events.jsonl"
readonly REPORT_FILE="${PROJECT_DIR}/work/daily-report.json"
readonly PROMPT_FILE="${PROJECT_DIR}/docs/codex-daily-agent-prompt.md"
readonly REPORT_SCHEMA_FILE="${PROJECT_DIR}/docs/daily-report.schema.json"
readonly LEGACY_LAST_SUCCESS_FILE="${PROJECT_DIR}/work/last-scheduled-date"

force_run=false
shadow_run=false
requested_date=""
update_kind=""
while (( $# > 0 )); do
  case "$1" in
    --force)
      force_run=true
      ;;
    --shadow)
      shadow_run=true
      force_run=true
      ;;
    --date)
      shift
      requested_date="${1:-}"
      ;;
    --update-kind)
      shift
      update_kind="${1:-}"
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -n "${requested_date}" ]] && [[ ! "${requested_date}" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ]]; then
  echo "--date must be YYYY-MM-DD" >&2
  exit 2
fi
if [[ -n "${update_kind}" && "${update_kind}" != "morning" && "${update_kind}" != "close" && "${update_kind}" != "evening" ]]; then
  echo "--update-kind must be morning, close, or evening" >&2
  exit 2
fi

beijing_date="${requested_date:-$(TZ=Asia/Shanghai /bin/date +%F)}"
if [[ "${force_run}" != true && -z "${requested_date}" ]]; then
  beijing_time="$(TZ=Asia/Shanghai /bin/date +%H%M)"
  if [[ -z "${update_kind}" && "${beijing_time}" > "0859" && "${beijing_time}" < "1500" ]]; then
    update_kind="morning"
  elif [[ -z "${update_kind}" && "${beijing_time}" > "1559" && "${beijing_time}" < "2100" ]]; then
    update_kind="close"
  elif [[ -z "${update_kind}" && "${beijing_time}" > "2059" ]]; then
    update_kind="evening"
  fi
  if [[ -z "${update_kind}" ]]; then
    exit 0
  fi
else
  update_kind="${update_kind:-morning}"
fi
readonly UPDATE_KIND="${update_kind}"
readonly LAST_SUCCESS_FILE="${PROJECT_DIR}/work/last-scheduled-${UPDATE_KIND}-date"

if [[ "${force_run}" != true && -z "${requested_date}" ]]; then
  if [[ -f "${LAST_SUCCESS_FILE}" ]] && [[ "$(< "${LAST_SUCCESS_FILE}")" == "${beijing_date}" ]]; then
    exit 0
  fi
  if [[ "${UPDATE_KIND}" == "morning" && ! -f "${LAST_SUCCESS_FILE}" && -f "${LEGACY_LAST_SUCCESS_FILE}" ]] &&
    [[ "$(< "${LEGACY_LAST_SUCCESS_FILE}")" == "${beijing_date}" ]]; then
    exit 0
  fi
fi

if ! /bin/mkdir "${LOCK_DIR}" 2>/dev/null; then
  exit 0
fi
trap '/bin/rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

cd "${PROJECT_DIR}"
/bin/mkdir -p "${PROJECT_DIR}/work"

if [[ -f "${LOG_FILE}" ]] && (( $(/usr/bin/stat -f%z "${LOG_FILE}") > 1048576 )); then
  /usr/bin/tail -c 524288 "${LOG_FILE}" > "${LOG_FILE}.tmp"
  /bin/mv "${LOG_FILE}.tmp" "${LOG_FILE}"
fi

{
  echo
  echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Stock Daily ${UPDATE_KIND} run started"
  npm run daily:collect -- --report-date "${beijing_date}" --update-kind "${UPDATE_KIND}"
  if [[ "${force_run}" != true && -z "${requested_date}" ]]; then
    freshness_status=0
    npm run daily:freshness || freshness_status=$?
    if (( freshness_status == 10 )); then
      printf "%s\n" "${beijing_date}" > "${LAST_SUCCESS_FILE}"
      echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] No material advance; ${UPDATE_KIND} run skipped"
      exit 0
    fi
    if (( freshness_status == 11 )); then
      echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Close data not available yet; a later trigger may retry"
      exit 0
    fi
    if (( freshness_status != 0 )); then
      exit "${freshness_status}"
    fi
  fi
  /bin/rm -f "${REPORT_FILE}" "${AGENT_EVENTS_FILE}"
  "${CODEX_BIN}" --search exec \
    --ephemeral \
    --ignore-user-config \
    --model gpt-5.6-sol \
    --config 'model_reasoning_effort="medium"' \
    --sandbox read-only \
    --cd "${PROJECT_DIR}" \
    --json \
    --output-schema "${REPORT_SCHEMA_FILE}" \
    --output-last-message "${REPORT_FILE}" \
    - < "${PROMPT_FILE}" > "${AGENT_EVENTS_FILE}"
  node scripts/daily-agent-audit.mjs "${AGENT_EVENTS_FILE}" "${REPORT_FILE}"
  node scripts/daily-source-audit.mjs "${REPORT_FILE}"
  npm run daily:check
  if [[ "${shadow_run}" == true ]]; then
    echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Stock Daily ${UPDATE_KIND} shadow run completed; publication skipped"
    exit 0
  fi
  npm run daily:publish
  node scripts/daily-verify.mjs
  if [[ "${force_run}" != true && -z "${requested_date}" ]]; then
    printf "%s\n" "${beijing_date}" > "${LAST_SUCCESS_FILE}"
  fi
  echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Stock Daily ${UPDATE_KIND} run completed"
} >> "${LOG_FILE}" 2>&1
