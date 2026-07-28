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
readonly LOCK_DIR="/tmp/stock-daily-codex-weekly.lock"
readonly LOG_FILE="${PROJECT_DIR}/work/weekly-task.log"
readonly AGENT_RESULT="${PROJECT_DIR}/work/weekly-agent-result.txt"
readonly REPORT_FILE="${PROJECT_DIR}/work/weekly-report.json"
readonly PROMPT_FILE="${PROJECT_DIR}/docs/codex-weekly-agent-prompt.md"
readonly LAST_SUCCESS_FILE="${PROJECT_DIR}/work/last-weekly-date"

force_run=false
requested_week=""
while (( $# > 0 )); do
  case "$1" in
    --force)
      force_run=true
      ;;
    --week-end)
      shift
      requested_week="${1:-}"
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

beijing_date="$(TZ=Asia/Shanghai /bin/date +%F)"
week_end="${requested_week:-${beijing_date}}"
if [[ "${force_run}" != true && -z "${requested_week}" ]]; then
  beijing_time="$(TZ=Asia/Shanghai /bin/date +%H%M)"
  beijing_weekday="$(TZ=Asia/Shanghai /bin/date +%u)"
  if [[ "${beijing_weekday}" != "7" || "${beijing_time}" < "2030" ]]; then
    exit 0
  fi
  if [[ -f "${LAST_SUCCESS_FILE}" ]] && [[ "$(< "${LAST_SUCCESS_FILE}")" == "${week_end}" ]]; then
    exit 0
  fi
fi

if ! /bin/mkdir "${LOCK_DIR}" 2>/dev/null; then
  exit 0
fi
trap '/bin/rmdir "${LOCK_DIR}" 2>/dev/null || true' EXIT

cd "${PROJECT_DIR}"
/bin/mkdir -p "${PROJECT_DIR}/work"

{
  echo
  echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Stock Daily weekly Codex run started"
  npm run weekly:collect -- --week-end "${week_end}"
  /bin/rm -f "${REPORT_FILE}" "${AGENT_RESULT}"
  "${CODEX_BIN}" exec \
    --ephemeral \
    --ignore-user-config \
    --model gpt-5.6-sol \
    --config 'model_reasoning_effort="medium"' \
    --sandbox workspace-write \
    --cd "${PROJECT_DIR}" \
    --output-last-message "${AGENT_RESULT}" \
    - < "${PROMPT_FILE}"
  npm run weekly:check
  npm run weekly:publish
  npm run weekly:verify
  if [[ "${force_run}" != true && -z "${requested_week}" ]]; then
    printf "%s\n" "${week_end}" > "${LAST_SUCCESS_FILE}"
  fi
  echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Stock Daily weekly Codex run completed"
} >> "${LOG_FILE}" 2>&1
