#!/bin/zsh

set -euo pipefail

readonly SCRIPT_DIR="${0:A:h}"
readonly PROJECT_DIR="${SCRIPT_DIR:h}"
readonly BASE_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
readonly LOCK_DIR="/tmp/stock-daily-codex.lock"
readonly LOG_FILE="${PROJECT_DIR}/work/daily-task.log"
readonly RESULT_FILE="${PROJECT_DIR}/work/daily-workflow-result.json"
readonly LEGACY_LAST_SUCCESS_FILE="${PROJECT_DIR}/work/last-scheduled-date"
readonly HANDLED_MARKETS_FILE="${PROJECT_DIR}/work/last-handled-market-as-of.json"
readonly TIMEOUT_RUNNER="${PROJECT_DIR}/scripts/run-with-timeout.mjs"

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
export PATH="${node_bin_dir}:${BASE_PATH}"

codex_bin="${STOCK_DAILY_CODEX_BIN:-}"
if [[ -z "${codex_bin}" ]]; then
  bundled_codex="/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
  legacy_bundled_codex="/Applications/ChatGPT.app/Contents/Resources/codex"
  if [[ -x "${bundled_codex}" ]]; then
    codex_bin="${bundled_codex}"
  elif [[ -x "${legacy_bundled_codex}" ]]; then
    codex_bin="${legacy_bundled_codex}"
  else
    codex_bin="$(command -v codex 2>/dev/null || true)"
  fi
fi
if [[ -z "${codex_bin}" || ! -x "${codex_bin}" ]]; then
  echo "Codex CLI not found; set STOCK_DAILY_CODEX_BIN" >&2
  exit 127
fi
export STOCK_DAILY_CODEX_BIN="${codex_bin}"

force_run=false
shadow_run=false
requested_date=""
update_kind=""
requested_market=""
while (( $# > 0 )); do
  case "$1" in
    --force) force_run=true ;;
    --shadow) shadow_run=true; force_run=true ;;
    --date) shift; requested_date="${1:-}" ;;
    --update-kind) shift; update_kind="${1:-}" ;;
    --market) shift; requested_market="${1:-}" ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -n "${requested_date}" && ! "${requested_date}" =~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ]]; then
  echo "--date must be YYYY-MM-DD" >&2
  exit 2
fi
if [[ -n "${update_kind}" && "${update_kind}" != "morning" && "${update_kind}" != "close" && "${update_kind}" != "evening" ]]; then
  echo "--update-kind must be morning, close, or evening" >&2
  exit 2
fi
if [[ -n "${requested_market}" && "${requested_market}" != "CN" && "${requested_market}" != "US" ]]; then
  echo "--market must be CN or US" >&2
  exit 2
fi

beijing_date="${requested_date:-$(TZ=Asia/Shanghai /bin/date +%F)}"
if [[ "${force_run}" != true && -z "${requested_date}" ]]; then
  beijing_time="$(TZ=Asia/Shanghai /bin/date +%H%M)"
  if [[ -z "${update_kind}" && "${beijing_time}" > "0859" && "${beijing_time}" < "1500" ]]; then
    update_kind="morning"
  elif [[ -z "${update_kind}" && "${beijing_time}" > "1459" && "${beijing_time}" < "2100" ]]; then
    update_kind="close"
  elif [[ -z "${update_kind}" && "${beijing_time}" > "2059" ]]; then
    update_kind="evening"
  fi
  [[ -n "${update_kind}" ]] || exit 0
else
  update_kind="${update_kind:-morning}"
fi
readonly UPDATE_KIND="${update_kind}"
readonly LAST_SUCCESS_FILE="${PROJECT_DIR}/work/last-scheduled-${UPDATE_KIND}-date"

if [[ "${force_run}" != true && -z "${requested_date}" ]]; then
  if [[ -f "${LAST_SUCCESS_FILE}" && "$(< "${LAST_SUCCESS_FILE}")" == "${beijing_date}" ]]; then
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
  [[ -r "${LOCK_PID_FILE}" ]] && stale_lock_pid="$(< "${LOCK_PID_FILE}")"
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
  echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Stock Daily ${UPDATE_KIND} multi-agent run started"
  export STOCK_DAILY_IMPLEMENTATION_SNAPSHOT="${PROJECT_DIR}/work/scheduled-implementation-${beijing_date}-${UPDATE_KIND}-$$.json"
  node "${SCRIPT_DIR}/workflow-implementation.mjs" --snapshot "${STOCK_DAILY_IMPLEMENTATION_SNAPSHOT}"
  npm run daily:collect -- --report-date "${beijing_date}" --update-kind "${UPDATE_KIND}"
  node "${SCRIPT_DIR}/workflow-implementation.mjs" --check "${STOCK_DAILY_IMPLEMENTATION_SNAPSHOT}"
  node scripts/structured-output-schema-audit.mjs docs/daily-agents/*.schema.json

  if [[ "${force_run}" != true && -z "${requested_date}" ]]; then
    freshness_status=0
    npm run daily:freshness || freshness_status=$?
    if (( freshness_status == 10 )); then
      echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] No market advance; checking pending production readbacks"
    fi
    if (( freshness_status == 11 )); then
      echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Required close data not available; a later trigger may retry"
      exit 0
    fi
    if (( freshness_status != 0 && freshness_status != 10 )); then
      exit "${freshness_status}"
    fi
  fi

  workflow_args=(--input work/daily-input.json)
  [[ -n "${requested_market}" ]] && workflow_args+=(--market "${requested_market}")
  if [[ -n "${requested_date}" || "${shadow_run}" == true ]]; then
    workflow_args+=(--force-markets)
  fi
  if [[ "${force_run}" != true && -z "${requested_date}" ]]; then
    workflow_args+=(--handled-market-as-of "${HANDLED_MARKETS_FILE}")
  fi
  if [[ "${shadow_run}" == true ]]; then
    workflow_args+=(--shadow)
  else
    workflow_args+=(--publish)
  fi
  /bin/rm -f "${RESULT_FILE}"
  node "${TIMEOUT_RUNNER}" \
    --timeout-ms 6900000 \
    --idle-timeout-ms 900000 \
    -- node scripts/daily-workflow.mjs "${workflow_args[@]}" > "${RESULT_FILE}"
  /bin/cat "${RESULT_FILE}"

  if [[ "${shadow_run}" == true ]]; then
    node -e '
      const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      process.exit(["shadow_complete", "skipped"].includes(result.status) ? 0 : 1);
    ' "${RESULT_FILE}"
  else
    publication_status=0
    node scripts/daily-handled-markets.mjs \
      "${RESULT_FILE}" \
      "${HANDLED_MARKETS_FILE}"
    node -e '
      const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      if (result.status === "skipped") process.exit(12);
      if (result.status === "pending_no_claims") process.exit(11);
      if (result.status !== "complete") process.exit(1);
      const fullyPublished = result.results?.length > 0 && result.results.every(
        (item) => item.status === "ready" &&
          ["published", "superseded"].includes(item.publication?.status),
      );
      process.exit(fullyPublished ? 0 : 1);
    ' "${RESULT_FILE}" || publication_status=$?
    if (( publication_status == 11 )); then
      echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] No publishable attribution yet; prior production analysis preserved and this market remains pending"
      exit 0
    fi
    if (( publication_status == 12 )); then
      echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] No newly confirmed market close; this checkpoint remains eligible for a compensation trigger"
      exit 0
    fi
    (( publication_status == 0 )) || exit "${publication_status}"
  fi
  if [[ "${force_run}" != true && -z "${requested_date}" ]]; then
    printf "%s\n" "${beijing_date}" > "${LAST_SUCCESS_FILE}"
  fi
  echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Stock Daily ${UPDATE_KIND} multi-agent run completed"
} >> "${LOG_FILE}" 2>&1
