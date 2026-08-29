#!/usr/bin/env bash
# Watch the feat/deepseek-harness-support implementation session.
# Exit 0 = progressing, 2 = stuck (no git/file/heartbeat activity), 1 = usage error.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="${DEEPSEEK_MONITOR_BRANCH:-feat/deepseek-harness-support}"
STALE_SECS="${DEEPSEEK_MONITOR_STALE_SECS:-1500}" # 25 minutes
HEARTBEAT_FILE="${DEEPSEEK_MONITOR_HEARTBEAT:-$REPO_ROOT/.ai/deepseek-adapter-session/heartbeat.json}"
WATCH_GLOBS=(
  "$REPO_ROOT/packages/adapters/deepseek-harness"
  "$REPO_ROOT/doc/plans/2026-08-29-deepseek-harness-adapter.md"
  "$REPO_ROOT/scripts/monitor-deepseek-adapter-session.sh"
)
LOG_DIR="${DEEPSEEK_MONITOR_LOG_DIR:-$REPO_ROOT/.ai/deepseek-adapter-session}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/monitor.log"

now_epoch="$(date +%s)"
iso_now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

latest_epoch=0
latest_source="none"

note_epoch() {
  local src="$1"
  local epoch="$2"
  if [[ -n "$epoch" && "$epoch" =~ ^[0-9]+$ && "$epoch" -gt "$latest_epoch" ]]; then
    latest_epoch="$epoch"
    latest_source="$src"
  fi
}

if git -C "$REPO_ROOT" rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  commit_epoch="$(git -C "$REPO_ROOT" log -1 --format=%ct "$BRANCH" 2>/dev/null || true)"
  note_epoch "git:$BRANCH" "$commit_epoch"
fi

if [[ -f "$HEARTBEAT_FILE" ]]; then
  hb_epoch="$(python3 - "$HEARTBEAT_FILE" <<'PY' 2>/dev/null || true
import json, sys, datetime
path = sys.argv[1]
try:
    data = json.load(open(path))
except Exception:
    sys.exit(0)
raw = data.get("updatedAt") or data.get("ts") or ""
if not raw:
    sys.exit(0)
try:
    dt = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    print(int(dt.timestamp()))
except Exception:
    pass
PY
)"
  note_epoch "heartbeat" "$hb_epoch"
  file_epoch="$(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || true)"
  note_epoch "heartbeat-mtime" "$file_epoch"
fi

for path in "${WATCH_GLOBS[@]}"; do
  if [[ -e "$path" ]]; then
    newest="$(find "$path" -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -print0 2>/dev/null \
      | xargs -0 stat -f %m 2>/dev/null \
      | sort -n \
      | tail -1 || true)"
    if [[ -z "$newest" ]]; then
      newest="$(find "$path" -type f -not -path '*/node_modules/*' -not -path '*/dist/*' -printf '%T@\n' 2>/dev/null \
        | sort -n \
        | tail -1 \
        | cut -d. -f1 || true)"
    fi
    note_epoch "files:$path" "$newest"
  fi
done

age=$((now_epoch - latest_epoch))
status="progressing"
exit_code=0
if [[ "$latest_epoch" -eq 0 || "$age" -gt "$STALE_SECS" ]]; then
  status="stuck"
  exit_code=2
fi

current_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
head_sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
summary=$(cat <<EOF
{
  "checkedAt": "$iso_now",
  "status": "$status",
  "branch": "$current_branch",
  "expectedBranch": "$BRANCH",
  "head": "$head_sha",
  "latestActivitySource": "$latest_source",
  "latestActivityEpoch": $latest_epoch,
  "ageSeconds": $age,
  "staleAfterSeconds": $STALE_SECS
}
EOF
)

printf '%s\n' "$summary" | tee -a "$LOG_FILE"
if [[ "$status" == "stuck" ]]; then
  echo "DEEPSEEK_ADAPTER_SESSION_STUCK ageSeconds=$age source=$latest_source" >&2
fi
exit "$exit_code"
