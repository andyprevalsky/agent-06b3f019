#!/usr/bin/env bash
# Benchmark check (C16): a finished run's root-agent replies, code-agent replies
# and code-agent command output render as markdown structure.
#
# Usage:
#   BACKEND_API_KEY=... front-end/scripts/check-agent-markdown.sh \
#     --backend http://localhost:3001 --agent-id <root agent id> [--agent-id <id> ...] \
#     [--user-id <user id>] [--require-root-reply] [--require-code-reply] [--report <path>]
#
# Fetches GET <backend>/api/agents/<id> for each id (X-API-Key, optional X-User-Id),
# then runs src/tests/blackbox/agent-markdown-benchmark.blackbox.tsx on those
# bodies. Prints the JSON report {ok, checked, violations}.
# Exit 0: every reply renders as structure. 1: violations. 2: bad input / fetch.
set -euo pipefail

backend=""
user_id=""
report=""
require=()
agent_ids=()
while [ $# -gt 0 ]; do
  case "$1" in
    --backend) backend="${2%/}"; shift 2 ;;
    --agent-id) agent_ids+=("$2"); shift 2 ;;
    --user-id) user_id="$2"; shift 2 ;;
    --report) report="$2"; shift 2 ;;
    --require-root-reply) require+=("root"); shift ;;
    --require-code-reply) require+=("code"); shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$backend" ] || [ ${#agent_ids[@]} -eq 0 ]; then
  echo "usage: $0 --backend <url> --agent-id <id> [--agent-id <id> ...]" >&2
  exit 2
fi
if [ -z "${BACKEND_API_KEY:-}" ]; then
  echo "BACKEND_API_KEY is not set" >&2
  exit 2
fi

FRONTEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

files=()
for id in "${agent_ids[@]}"; do
  headers=(-H "X-API-Key: $BACKEND_API_KEY")
  [ -n "$user_id" ] && headers+=(-H "X-User-Id: $user_id")
  status="$(curl -sS -o "$work/$id.json" -w '%{http_code}' "${headers[@]}" "$backend/api/agents/$id")" || {
    echo "GET /api/agents/$id failed" >&2
    exit 2
  }
  if [ "$status" != "200" ]; then
    echo "GET /api/agents/$id -> HTTP $status" >&2
    exit 2
  fi
  files+=("$work/$id.json")
done

report_path="${report:-$work/report.json}"
cd "$FRONTEND_DIR"
set +e
AGENT_MARKDOWN_RUN_FILES="$(IFS=,; echo "${files[*]}")" \
  AGENT_MARKDOWN_REQUIRE="$(IFS=,; echo "${require[*]:-}")" \
  AGENT_MARKDOWN_REPORT="$report_path" \
  npx vitest run src/tests/blackbox/agent-markdown-benchmark.blackbox.tsx \
  -t 'every root reply' >"$work/vitest.log" 2>&1
code=$?
set -e
if [ ! -s "$report_path" ]; then
  echo "check did not produce a report (vitest exit $code):" >&2
  tail -40 "$work/vitest.log" >&2
  exit 2
fi
cat "$report_path"
[ "$code" -eq 0 ] && exit 0
exit 1
