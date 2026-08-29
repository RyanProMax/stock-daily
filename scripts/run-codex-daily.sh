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

codex_bin="${STOCK_DAILY_CODEX_BIN:-}"
if [[ -z "${codex_bin}" ]]; then
  bundled_codex="/Applications/ChatGPT.app/Contents/Resources/codex"
  if [[ -x "${bundled_codex}" ]]; then
    codex_bin="${bundled_codex}"
  else
    codex_bin="$(command -v codex 2>/dev/null || true)"
  fi
fi
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
readonly REVIEW_FILE="${PROJECT_DIR}/work/daily-review.json"
readonly REVIEW_EVENTS_FILE="${PROJECT_DIR}/work/daily-review-events.jsonl"
readonly REVIEW_PROMPT_FILE="${PROJECT_DIR}/docs/codex-daily-review-prompt.md"
readonly REVIEW_SCHEMA_FILE="${PROJECT_DIR}/docs/daily-review.schema.json"
readonly ATTEMPT_ERROR_FILE="${PROJECT_DIR}/work/daily-attempt-error.txt"
readonly MAX_RESEARCH_ATTEMPTS="${STOCK_DAILY_MAX_RESEARCH_ATTEMPTS:-3}"
readonly RESEARCH_TIMEOUT_SECONDS="${STOCK_DAILY_RESEARCH_TIMEOUT_SECONDS:-900}"
readonly REVIEW_TIMEOUT_SECONDS="${STOCK_DAILY_REVIEW_TIMEOUT_SECONDS:-600}"
readonly RESEARCH_IDLE_TIMEOUT_SECONDS="${STOCK_DAILY_RESEARCH_IDLE_TIMEOUT_SECONDS:-300}"
readonly REVIEW_IDLE_TIMEOUT_SECONDS="${STOCK_DAILY_REVIEW_IDLE_TIMEOUT_SECONDS:-240}"
readonly RESEARCH_REASONING_EFFORT="${STOCK_DAILY_RESEARCH_REASONING_EFFORT:-low}"
readonly TIMEOUT_RUNNER="${PROJECT_DIR}/scripts/run-with-timeout.mjs"
readonly LEGACY_LAST_SUCCESS_FILE="${PROJECT_DIR}/work/last-scheduled-date"

if [[ ! "${MAX_RESEARCH_ATTEMPTS}" == <1-3> ]]; then
  echo "STOCK_DAILY_MAX_RESEARCH_ATTEMPTS must be between 1 and 3" >&2
  exit 2
fi
if [[ "${RESEARCH_TIMEOUT_SECONDS}" != <-> ]] || (( RESEARCH_TIMEOUT_SECONDS < 1 || RESEARCH_TIMEOUT_SECONDS > 3600 )); then
  echo "STOCK_DAILY_RESEARCH_TIMEOUT_SECONDS must be between 1 and 3600" >&2
  exit 2
fi
if [[ "${REVIEW_TIMEOUT_SECONDS}" != <-> ]] || (( REVIEW_TIMEOUT_SECONDS < 1 || REVIEW_TIMEOUT_SECONDS > 3600 )); then
  echo "STOCK_DAILY_REVIEW_TIMEOUT_SECONDS must be between 1 and 3600" >&2
  exit 2
fi
if [[ "${RESEARCH_IDLE_TIMEOUT_SECONDS}" != <-> ]] || (( RESEARCH_IDLE_TIMEOUT_SECONDS < 1 || RESEARCH_IDLE_TIMEOUT_SECONDS > RESEARCH_TIMEOUT_SECONDS )); then
  echo "STOCK_DAILY_RESEARCH_IDLE_TIMEOUT_SECONDS must be between 1 and the research timeout" >&2
  exit 2
fi
if [[ "${REVIEW_IDLE_TIMEOUT_SECONDS}" != <-> ]] || (( REVIEW_IDLE_TIMEOUT_SECONDS < 1 || REVIEW_IDLE_TIMEOUT_SECONDS > REVIEW_TIMEOUT_SECONDS )); then
  echo "STOCK_DAILY_REVIEW_IDLE_TIMEOUT_SECONDS must be between 1 and the review timeout" >&2
  exit 2
fi
if [[ "${RESEARCH_REASONING_EFFORT}" != "low" && "${RESEARCH_REASONING_EFFORT}" != "medium" ]]; then
  echo "STOCK_DAILY_RESEARCH_REASONING_EFFORT must be low or medium" >&2
  exit 2
fi

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

readonly LOCK_PID_FILE="${LOCK_DIR}/pid"
if ! /bin/mkdir "${LOCK_DIR}" 2>/dev/null; then
  stale_lock_pid=""
  if [[ -r "${LOCK_PID_FILE}" ]]; then
    stale_lock_pid="$(< "${LOCK_PID_FILE}")"
  fi
  if [[ "${stale_lock_pid}" == <-> ]] && kill -0 "${stale_lock_pid}" 2>/dev/null; then
    exit 0
  fi
  /bin/rm -f "${LOCK_PID_FILE}"
  /bin/rmdir "${LOCK_DIR}" 2>/dev/null || exit 0
  /bin/mkdir "${LOCK_DIR}" 2>/dev/null || exit 0
fi
printf "%s\n" "$$" > "${LOCK_PID_FILE}"
cleanup_lock() {
  /bin/rm -f "${LOCK_PID_FILE}"
  /bin/rmdir "${LOCK_DIR}" 2>/dev/null || true
}
trap cleanup_lock EXIT
trap 'exit 130' HUP INT TERM

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
  node scripts/structured-output-schema-audit.mjs \
    "${REPORT_SCHEMA_FILE}" \
    "${REVIEW_SCHEMA_FILE}"
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
  /bin/rm -f \
    "${REPORT_FILE}" \
    "${AGENT_EVENTS_FILE}" \
    "${REVIEW_FILE}" \
    "${REVIEW_EVENTS_FILE}" \
    "${ATTEMPT_ERROR_FILE}"
  attempt=1
  research_accepted=false
  while (( attempt <= MAX_RESEARCH_ATTEMPTS )); do
    echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Research attempt ${attempt}/${MAX_RESEARCH_ATTEMPTS} started"
    /bin/rm -f "${REPORT_FILE}" "${AGENT_EVENTS_FILE}" "${REVIEW_EVENTS_FILE}"
    research_exit=0
    node "${TIMEOUT_RUNNER}" \
      --timeout-ms "$(( RESEARCH_TIMEOUT_SECONDS * 1000 ))" \
      --idle-timeout-ms "$(( RESEARCH_IDLE_TIMEOUT_SECONDS * 1000 ))" \
      -- "${CODEX_BIN}" \
      --disable plugins \
      --disable remote_plugin \
      --disable recommended_plugins \
      --disable apps \
      --disable unbounded_connection_retries \
      --disable in_app_updates \
      --disable tui_app_server \
      --search exec \
      --ephemeral \
      --ignore-user-config \
      --model gpt-5.6-sol \
      --config "model_reasoning_effort=\"${RESEARCH_REASONING_EFFORT}\"" \
      --config 'check_for_update_on_startup=false' \
      --sandbox read-only \
      --cd "${PROJECT_DIR}" \
      --json \
      --output-schema "${REPORT_SCHEMA_FILE}" \
      --output-last-message "${REPORT_FILE}" \
      - < "${PROMPT_FILE}" > "${AGENT_EVENTS_FILE}" || research_exit=$?
    if (( research_exit != 0 )); then
      if (( research_exit == 124 )); then
        print -r -- "上一轮在生成阶段连续 ${RESEARCH_IDLE_TIMEOUT_SECONDS} 秒无进展或超过 ${RESEARCH_TIMEOUT_SECONDS} 秒，已终止。请减少无效搜索，优先验证最显著异动；不得复用未完成输出。" > "${ATTEMPT_ERROR_FILE}"
      else
        print -r -- "上一轮在生成阶段失败。请重新读取输入，缩小查询范围并输出完整合法 JSON。" > "${ATTEMPT_ERROR_FILE}"
      fi
      (( attempt += 1 ))
      continue
    fi
    if ! node scripts/daily-agent-audit.mjs "${AGENT_EVENTS_FILE}" "${REPORT_FILE}" > "${ATTEMPT_ERROR_FILE}" 2>&1; then
      /bin/cat "${ATTEMPT_ERROR_FILE}"
      (( attempt += 1 ))
      continue
    fi
    /bin/cat "${ATTEMPT_ERROR_FILE}"
    if ! node scripts/daily-source-audit.mjs "${REPORT_FILE}" > "${ATTEMPT_ERROR_FILE}" 2>&1; then
      /bin/cat "${ATTEMPT_ERROR_FILE}"
      (( attempt += 1 ))
      continue
    fi
    /bin/cat "${ATTEMPT_ERROR_FILE}"
    if ! npm run daily:check > "${ATTEMPT_ERROR_FILE}" 2>&1; then
      /bin/cat "${ATTEMPT_ERROR_FILE}"
      (( attempt += 1 ))
      continue
    fi
    /bin/cat "${ATTEMPT_ERROR_FILE}"
    /bin/rm -f "${REVIEW_FILE}" "${REVIEW_EVENTS_FILE}"
    review_exit=0
    node "${TIMEOUT_RUNNER}" \
      --timeout-ms "$(( REVIEW_TIMEOUT_SECONDS * 1000 ))" \
      --idle-timeout-ms "$(( REVIEW_IDLE_TIMEOUT_SECONDS * 1000 ))" \
      -- "${CODEX_BIN}" \
      --disable plugins \
      --disable remote_plugin \
      --disable recommended_plugins \
      --disable apps \
      --disable unbounded_connection_retries \
      --disable in_app_updates \
      --disable tui_app_server \
      --search exec \
      --ephemeral \
      --ignore-user-config \
      --model gpt-5.6-sol \
      --config 'model_reasoning_effort="medium"' \
      --config 'check_for_update_on_startup=false' \
      --sandbox read-only \
      --cd "${PROJECT_DIR}" \
      --json \
      --output-schema "${REVIEW_SCHEMA_FILE}" \
      --output-last-message "${REVIEW_FILE}" \
      - < "${REVIEW_PROMPT_FILE}" > "${REVIEW_EVENTS_FILE}" || review_exit=$?
    if (( review_exit != 0 )); then
      if (( review_exit == 124 )); then
        print -r -- "上一轮在独立复盘阶段连续 ${REVIEW_IDLE_TIMEOUT_SECONDS} 秒无进展或超过 ${REVIEW_TIMEOUT_SECONDS} 秒，已终止。请逐一核对已引用来源，不要扩大搜索范围。" > "${ATTEMPT_ERROR_FILE}"
      else
        print -r -- "上一轮在独立复盘阶段失败。请检查引用来源可访问性和报告完整性。" > "${ATTEMPT_ERROR_FILE}"
      fi
      (( attempt += 1 ))
      continue
    fi
    if ! node scripts/daily-review-audit.mjs \
      "${REVIEW_EVENTS_FILE}" \
      "${REVIEW_FILE}" \
      "${REPORT_FILE}" > "${ATTEMPT_ERROR_FILE}" 2>&1; then
      /bin/cat "${ATTEMPT_ERROR_FILE}"
      (( attempt += 1 ))
      continue
    fi
    /bin/cat "${ATTEMPT_ERROR_FILE}"
    if ! node scripts/daily-review-check.mjs "${REVIEW_FILE}" "${REPORT_FILE}" > "${ATTEMPT_ERROR_FILE}" 2>&1; then
      /bin/cat "${ATTEMPT_ERROR_FILE}"
      (( attempt += 1 ))
      continue
    fi
    /bin/cat "${ATTEMPT_ERROR_FILE}"
    /bin/rm -f "${ATTEMPT_ERROR_FILE}"
    research_accepted=true
    echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Research attempt ${attempt}/${MAX_RESEARCH_ATTEMPTS} accepted"
    break
  done
  if [[ "${research_accepted}" != true ]]; then
    echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Research review failed after ${MAX_RESEARCH_ATTEMPTS} attempts; publication skipped"
    exit 1
  fi
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
