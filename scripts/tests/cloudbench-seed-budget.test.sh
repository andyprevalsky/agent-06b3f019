#!/usr/bin/env bash
# Focused test for the cloud bench box stack-health-wait budget
# (scripts/lib/cloudbench-seed-budget.sh).
#
# RCA cement. A fresh clone forks the warm snapshot, which carries a seed dump +
# a baked .schemahash. When the current schema differs from the baked hash, run.sh
# does the full ~15-min prod COLD-SYNC (its restore gate requires a hash match),
# but the old budget check only tested whether the dump FILE existed — so it
# granted the tight 900s warm budget and the box was SIGKILLed mid-sync at t+900s.
# The driver and run.sh evaluate that mutable dump in different processes. Even
# a matching dump can disappear, fail pg_restore, or be rejected after the
# driver's preflight, so a warm proof cannot safely shorten the health ceiling.
# These cases prove the larger configured ceiling always remains available:
#   case 1 — dump absent            → cold-sync budget (first-run).
#   case 2 — dump present, hash MISMATCH → cold-sync budget (the bug: was warm).
#   case 3 — dump present, hash MATCH    → cold ceiling (fast restore still exits early).
#   case 4 — schema file missing    → cold-sync budget (fail safe / long).
#   case 5 — warm ceiling is larger → warm ceiling (true maximum, order independent).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB="$ROOT_DIR/scripts/lib/cloudbench-seed-budget.sh"
[ -f "$LIB" ] || { echo "FATAL: missing $LIB" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A throwaway repo tree with a real schema.prisma to hash.
mkdir -p "$TMP/repo/back-end/prisma" "$TMP/cache"
SCHEMA="$TMP/repo/back-end/prisma/schema.prisma"
printf 'model A { id String @id }\n' > "$SCHEMA"
CUR_HASH="$( (shasum "$SCHEMA" 2>/dev/null || sha1sum "$SCHEMA" 2>/dev/null) | awk '{print $1}')"

export REPO_DIR="$TMP/repo"
export STACK_SEED_DUMP="$TMP/cache/victoria-seed.dump"
export CLOUDBENCH_STACK_WAIT_SECONDS=900
export CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS=2160

fail() { echo "FAIL: $*" >&2; exit 1; }
budget() { ( source "$LIB"; stack_wait_budget_seconds ); }

# ── case 1: dump absent → cold-sync (first-run) budget ───────────────────────
rm -f "$STACK_SEED_DUMP" "$STACK_SEED_DUMP.schemahash"
[ "$(budget)" = "2160" ] || fail "case 1: absent dump must use first-run budget, got $(budget)"
echo "PASS case 1 — dump absent → 2160s cold-sync budget"

# ── case 2 (THE BUG): dump present but schema-STALE → cold-sync budget ────────
printf 'seed-bytes\n' > "$STACK_SEED_DUMP"
printf '%s' "deadbeefstalehashdeadbeefstalehash0000" > "$STACK_SEED_DUMP.schemahash"
[ "$(budget)" = "2160" ] || fail "case 2: schema-stale dump must use first-run budget (bug: used warm 900), got $(budget)"
echo "PASS case 2 — dump present + hash MISMATCH → 2160s cold-sync budget (was 900, the bug)"

# ── case 3 (fast restore): dump present + hash MATCH → warm budget ────────────
printf '%s' "$CUR_HASH" > "$STACK_SEED_DUMP.schemahash"
[ "$(budget)" = "2160" ] || fail "case 3: matching preflight dump must retain the cold fallback ceiling, got $(budget)"
echo "PASS case 3 — dump present + hash MATCH → 2160s fallback-safe ceiling"

# ── case 4: schema file missing → cold-sync budget (cannot prove a fast restore)
rm -f "$SCHEMA"
[ "$(budget)" = "2160" ] || fail "case 4: missing schema must fall to first-run budget, got $(budget)"
echo "PASS case 4 — schema file missing → 2160s cold-sync budget (fail safe)"

# ── case 5: warm configured above cold → retain the true larger ceiling ──────
export CLOUDBENCH_STACK_WAIT_SECONDS=2500
export CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS=2160
[ "$(budget)" = "2500" ] || fail "case 5: maximum must be order independent, got $(budget)"
echo "PASS case 5 — warm 2500s > cold 2160s → 2500s true maximum"

echo "ALL PASS: cloudbench seed budget"
