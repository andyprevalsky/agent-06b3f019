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
from helpers import reexported
from helpers.surfacemod import thing
from helpers.pkg import other
def run():
    return thing() + other() + reexported()
PY
cat > "$TMP/agents/helpers/surfacemod.py" <<'PY'
def thing():
    return 1
PY
# Package __init__ that re-exports a local module via a RELATIVE import. The
# workflow imports the re-exported name from the package, never `helpers.relmod`
# directly, so only relative-import resolution keeps relmod.py in the surface.
cat > "$TMP/agents/helpers/__init__.py" <<'PY'
from .relmod import reexported
PY
cat > "$TMP/agents/helpers/relmod.py" <<'PY'
def reexported():
    return 3
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
grep -q 'helpers/relmod.py'           <<<"$LIST" || fail "surface must resolve relative-import re-exports (else a change slips past the hash)"
grep -q 'helpers/offmod.py'           <<<"$LIST" && fail "surface must NOT include un-imported files"

# A change in a module reached ONLY via a package __init__'s relative re-export
# must move the hash — this is the under-inclusion CodeRabbit flagged.
echo "# touched" >> "$TMP/agents/helpers/relmod.py"
[ "$(hash_of "$TMP")" != "$BASE" ] || fail "editing a relative-import re-exported module did not change the hash (MISSED rollover)"
cat > "$TMP/agents/helpers/relmod.py" <<'PY'
def reexported():
    return 3
PY
[ "$(hash_of "$TMP")" = "$BASE" ] || fail "reverting the re-exported module did not restore the hash"

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

# A class re-export must not become a case-folded alias of a lowercase module.
# This is a real case-insensitive filesystem boundary; exact uppercase module
# and package names remain valid imports and must stay in the closure.
CASE_TREE="$TMP/casefold"
mkdir -p "$CASE_TREE/agents/workflows" "$CASE_TREE/agents/keycap/CamelPackage"
cat > "$CASE_TREE/agents/workflows/agent_workflow.py" <<'PYCASE'
from keycap import Controller, Plant
from keycap import ExactModule
from keycap.CamelPackage import thing
PYCASE
cat > "$CASE_TREE/agents/keycap/__init__.py" <<'PYCASE'
from .controller import Controller
from .plant import Plant
PYCASE
cat > "$CASE_TREE/agents/keycap/controller.py" <<'PYCASE'
class Controller:
    pass
PYCASE
cat > "$CASE_TREE/agents/keycap/plant.py" <<'PYCASE'
class Plant:
    pass
PYCASE
cat > "$CASE_TREE/agents/keycap/ExactModule.py" <<'PYCASE'
value = 1
PYCASE
cat > "$CASE_TREE/agents/keycap/CamelPackage/__init__.py" <<'PYCASE'
def thing():
    return 1
PYCASE
CASE_LIST=$(hash_of "$CASE_TREE" --list)
grep -Fq 'agents/keycap/controller.py' <<<"$CASE_LIST" || fail "class re-export must retain its real lowercase module"
grep -Fq 'agents/keycap/plant.py' <<<"$CASE_LIST" || fail "class re-export must retain its real lowercase module"
if grep -Fq 'agents/keycap/Controller.py' <<<"$CASE_LIST" || grep -Fq 'agents/keycap/Plant.py' <<<"$CASE_LIST"; then
  fail "class re-exports must not add filesystem case aliases to the generation hash"
fi
grep -Fq 'agents/keycap/ExactModule.py' <<<"$CASE_LIST" || fail "exact uppercase module must remain in the closure"
grep -Fq 'agents/keycap/CamelPackage/__init__.py' <<<"$CASE_LIST" || fail "exact mixed-case package must remain in the closure"
CASE_HASH=$(hash_of "$CASE_TREE")
echo '# actual replay surface edit' >> "$CASE_TREE/agents/keycap/ExactModule.py"
[ "$(hash_of "$CASE_TREE")" != "$CASE_HASH" ] || fail "editing the exact uppercase module must change the generation hash"

# A package-directory alias must not enter the surface even when the final
# __init__.py basename has the exact spelling. The only directory is CamelPackage.
cat > "$CASE_TREE/agents/workflows/agent_workflow.py" <<'PYCASE'
from keycap.camelpackage import thing
PYCASE
DIR_CASE_LIST=$(hash_of "$CASE_TREE" --list)
if grep -Fq 'agents/keycap/CamelPackage/' <<<"$DIR_CASE_LIST" || grep -Fq 'agents/keycap/camelpackage/' <<<"$DIR_CASE_LIST"; then
  fail "case-folded package directories must not enter the generation surface"
fi

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
