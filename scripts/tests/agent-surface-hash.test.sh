#!/usr/bin/env bash
# Contract test for the Temporal replay-surface hash (the zero-downtime cutover
# generation key). Proves the hash is deterministic and *scoped*: it changes iff
# a file inside the workflow's transitive import closure changes, and is inert to
# files outside it. Under-inclusion (a surface change that does NOT move the hash)
# would let a determinism-breaking deploy ship without a rollover and crash
# replay in prod — so that direction is the primary thing this test guards.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TOOL="$ROOT/scripts/agent_workflow_surface_hash.py"

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$TOOL" ] || fail "surface-hash tool missing: $TOOL"

hash_of() { python3 "$TOOL" --agents-dir "$1/agents" --root "$1/agents/workflows/agent_workflow.py" "${@:2}"; }

# ---- Hermetic fixture: a miniature agents/ tree with a known import graph -----
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/agents/workflows" "$TMP/agents/helpers"

cat > "$TMP/agents/workflows/agent_workflow.py" <<'PY'
from helpers.surfacemod import thing
from helpers.pkg import other
def run():
    return thing() + other()
PY
cat > "$TMP/agents/helpers/surfacemod.py" <<'PY'
def thing():
    return 1
PY
mkdir -p "$TMP/agents/helpers/pkg"
cat > "$TMP/agents/helpers/pkg/__init__.py" <<'PY'
def other():
    return 2
PY
# A file that is NOT imported by the workflow — must be invisible to the hash.
cat > "$TMP/agents/helpers/offmod.py" <<'PY'
def unused():
    return 99
PY

BASE=$(hash_of "$TMP")
[ -n "$BASE" ] || fail "empty hash on fixture"
[ "$BASE" = "$(hash_of "$TMP")" ] || fail "hash is not deterministic across runs"

# The entry and every imported module (including the package __init__) are in scope.
LIST=$(hash_of "$TMP" --list)
grep -q 'workflows/agent_workflow.py' <<<"$LIST" || fail "surface must include the workflow entry"
grep -q 'helpers/surfacemod.py'       <<<"$LIST" || fail "surface must include a directly-imported module"
grep -q 'helpers/pkg/__init__.py'     <<<"$LIST" || fail "surface must follow imported packages"
grep -q 'helpers/offmod.py'           <<<"$LIST" && fail "surface must NOT include un-imported files"

# Editing a SURFACE file must move the hash (rollover fires).
echo "# touched" >> "$TMP/agents/helpers/surfacemod.py"
CHANGED=$(hash_of "$TMP")
[ "$CHANGED" != "$BASE" ] || fail "editing an in-surface module did not change the hash (would MISS a rollover)"

# Reverting restores the exact hash (content-addressed, not timestamp/path noise).
cat > "$TMP/agents/helpers/surfacemod.py" <<'PY'
def thing():
    return 1
PY
[ "$(hash_of "$TMP")" = "$BASE" ] || fail "reverting the surface file did not restore the hash"

# Editing a NON-surface file must NOT move the hash (no needless rollover).
echo "# touched" >> "$TMP/agents/helpers/offmod.py"
[ "$(hash_of "$TMP")" = "$BASE" ] || fail "editing an out-of-surface file changed the hash (needless rollover)"

# ---- Real tree invariants ----------------------------------------------------
REAL=$(python3 "$TOOL")
[ "${#REAL}" -eq 12 ] || fail "default output must be the 12-char short hash, got '$REAL'"
[ "$REAL" = "$(python3 "$TOOL")" ] || fail "real-tree hash is not deterministic"
FULL=$(python3 "$TOOL" --full)
[ "${#FULL}" -eq 64 ] || fail "--full must be the 64-char sha256, got length ${#FULL}"
REAL_LIST=$(python3 "$TOOL" --list)
grep -q 'agents/workflows/agent_workflow.py' <<<"$REAL_LIST" || fail "real surface must include the workflow entry"
# Scoped, not coarse: benchmark and test files are never part of the replay surface.
grep -q 'agents/benchmarks/' <<<"$REAL_LIST" && fail "benchmarks must not be in the replay surface"
grep -q 'agents/tests/'      <<<"$REAL_LIST" && fail "tests must not be in the replay surface"

echo "PASS agent-surface-hash: deterministic, scoped, content-addressed generation key"
