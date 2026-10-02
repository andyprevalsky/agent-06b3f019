#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MANIFEST="${1:-$REPO_DIR/.context/services.json}"

# Step 6c runs in a new shell. Read the live stack's actual ports rather than
# assuming that Step 5's LOCAL_DB_PORT export survived or that Docker owns DB.
if ! jq -er --arg worktree "$REPO_DIR" '
  def valid_port: type == "number" and . == floor and . >= 1 and . <= 65535;
  select(.status == "running" and .worktree == $worktree)
  | select((.ports.backend | valid_port) and (.database.runtime_port | valid_port))
  | [.ports.backend, .database.runtime_port] | @tsv
' "$MANIFEST"; then
  echo "FAIL: Cannot resolve the running deploy stack ports from $MANIFEST" >&2
  exit 1
fi
