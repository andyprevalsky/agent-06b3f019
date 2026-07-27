#!/usr/bin/env bash
# Focused test for the first-run seed retry loop's exit-code reporting
# (scripts/run.sh, "first-run seed attempt" block).
#
# RCA cement (descend daily, epoch 1). Every one of 44 cloud bench boxes was
# OOM-killed (SIGKILL, rc=137) while seeding, three times each, and then
# aborted the whole stack. The retry loop reported every one of those kills as
# "rc=0" because it read `$?` AFTER `fi`:
#
#     if seed; then _seed_ok=1; break; fi
#     _seed_rc=$?          # <-- status of the *if statement*, not the seed
#
# A completed `if` whose condition was false and which has no `else` exits 0,
# so the real signal was destroyed at the exact place an operator reads it. The
# run looked like "stuck in queue" for 40 minutes instead of "OOM-killed".
#
# These cases pin that the loop surfaces the seed's OWN status:
#   case 1 — seed exits 137 (SIGKILL/OOM) → reported rc=137, named as OOM.
#   case 2 — seed exits 139 (SIGSEGV)     → reported rc=139, named as SIGSEGV.
#   case 3 — seed exits 1                 → reported rc=1, no signal name.
#   case 4 — seed succeeds on retry 2     → loop breaks, no abort.
#   case 5 — never reports a failure as rc=0.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# SEED_LOOP_RUN_SH lets the RCA point this same suite at a historical run.sh to
# confirm it goes red on the buggy revision. Deploy always runs the default.
RUN_SH="${SEED_LOOP_RUN_SH:-$ROOT_DIR/scripts/run.sh}"
[ -f "$RUN_SH" ] || { echo "FATAL: missing $RUN_SH" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# Extract the real retry loop from run.sh so this test exercises the shipped
# code, not a copy that could drift away from it.
awk '/^    _seed_ok=0$/,/^    done$/' "$RUN_SH" > "$TMP/loop.sh"
grep -q '_seed_ok=0' "$TMP/loop.sh" || fail "could not extract the seed retry loop from run.sh"
grep -q 'seed-local.ts' "$TMP/loop.sh" || fail "extracted loop does not invoke the seed"

# Drive the extracted loop with a stub seed whose exit code we control.
# `cd back-end && npx tsx scripts/seed-local.ts` is replaced by a stub that
# reads SEED_EXITS (a per-attempt, space separated list of exit codes).
run_loop() { # run_loop <exit codes...>
  local codes="$*"
  # run.sh invokes the seed inside a ( … ) subshell, so the attempt counter must
  # live in a file — an in-memory variable would not survive back to the loop.
  printf '0\n' > "$TMP/attempt"
  cat > "$TMP/harness.sh" <<HARNESS
set -uo pipefail
cd() { :; }
sleep() { :; }   # the loop's real backoff would make this suite take minutes
CODES=($codes)
npx() {
  local n rc
  n="\$(cat "$TMP/attempt")"
  rc="\${CODES[\$n]:-0}"
  printf '%s\n' "\$((n + 1))" > "$TMP/attempt"
  return "\$rc"
}
$(cat "$TMP/loop.sh")
echo "SEED_OK=\$_seed_ok"
HARNESS
  bash "$TMP/harness.sh" 2>&1
}

# ── case 1: OOM kill must be reported as 137 and named ───────────────────────
out="$(run_loop 137 137 137)"
grep -q 'rc=137' <<<"$out" || fail "case 1: expected rc=137, got: $out"
grep -qi 'out of memory' <<<"$out" || fail "case 1: expected rc=137 to be named as OOM, got: $out"
grep -q 'SEED_OK=0' <<<"$out" || fail "case 1: three kills must not report success"
echo "PASS case 1 — SIGKILL/OOM reported as rc=137 and named"

# ── case 2: SIGSEGV must be reported as 139 and named ────────────────────────
out="$(run_loop 139 139 139)"
grep -q 'rc=139' <<<"$out" || fail "case 2: expected rc=139, got: $out"
grep -q 'SIGSEGV' <<<"$out" || fail "case 2: expected rc=139 named as SIGSEGV, got: $out"
echo "PASS case 2 — SIGSEGV reported as rc=139 and named"

# ── case 3: an ordinary failure keeps its own code ───────────────────────────
out="$(run_loop 1 1 1)"
grep -q 'rc=1' <<<"$out" || fail "case 3: expected rc=1, got: $out"
grep -q 'SIGSEGV' <<<"$out" && fail "case 3: rc=1 must not be labelled SIGSEGV"
echo "PASS case 3 — plain failure reported as rc=1"

# ── case 4: recovery on a later attempt still succeeds ───────────────────────
out="$(run_loop 137 0)"
grep -q 'SEED_OK=1' <<<"$out" || fail "case 4: seed succeeding on retry must set _seed_ok=1, got: $out"
grep -q 'rc=137' <<<"$out" || fail "case 4: the first attempt's kill must still be reported, got: $out"
echo "PASS case 4 — retry recovery preserved, first failure still surfaced"

# ── case 5: a failure is NEVER reported as rc=0 (the original bug) ───────────
for code in 1 2 137 139; do
  out="$(run_loop "$code" "$code" "$code")"
  grep -q 'rc=0' <<<"$out" && fail "case 5: exit $code was reported as rc=0 — the \$?-after-fi bug is back"
done
echo "PASS case 5 — no failing exit code is ever reported as rc=0"

# ── case 6: the last attempt must not promise a retry it will not make ───────
# (CodeRabbit, PR #909) The whole point of this block is that operator-facing
# output tells the truth; "retrying..." on the attempt that aborts the stack is
# the same class of lie as rc=0.
out="$(run_loop 137 137 137)"
grep -q 'attempts exhausted' <<<"$out" || fail "case 6: final failure must say attempts exhausted, got: $out"
[ "$(grep -c 'retrying' <<<"$out")" = 2 ] \
  || fail "case 6: expected exactly 2 'retrying' lines before the final failure, got: $out"
echo "PASS case 6 — final attempt reports exhaustion, not a phantom retry"

echo "ALL PASS — run.sh first-run seed retry loop reports the seed's own exit status"
