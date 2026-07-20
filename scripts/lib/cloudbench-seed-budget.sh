#!/usr/bin/env bash
# Stack-health-wait budget for a cloud bench box.
#
# RCA cement. The budget MUST mirror run.sh's seed-dump RESTORE GATE. run.sh does
# a FAST restore only when the dump exists AND its baked schemahash matches the
# current schema; otherwise it falls back to the full ~15-min prod cold-sync. The
# original budget granted the tight warm deadline whenever the dump FILE merely
# existed — so a schema-STALE dump (present but hash-mismatched) got the 900s warm
# budget while run.sh actually cold-synced, and the box was SIGKILLed mid-sync
# (observed: killed at t+900s, ~50s before the cold-sync finished → every first-run
# box in a fresh-schema fleet was excluded as an infra failure). Aligning the two
# conditions is the fix: cold-sync ⇒ first-run budget; fast-restore ⇒ warm budget.
#
# Caller provides: STACK_SEED_DUMP (dump path), REPO_DIR (repo root).
# Env overrides:  CLOUDBENCH_STACK_WAIT_SECONDS (warm, default 900),
#                 CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS (cold, default 2160).

# 0 = run.sh WILL fast-restore the dump (warm budget suffices);
# 1 = run.sh will cold-sync (dump absent OR schema-stale → needs first-run budget).
cloudbench_seed_dump_restorable() {
    local dump="${STACK_SEED_DUMP:-}" schema="${REPO_DIR:-}/back-end/prisma/schema.prisma"
    [ -n "$dump" ] && [ -s "$dump" ] || return 1
    [ -f "$schema" ] || return 1
    local baked current
    baked="$(cat "${dump}.schemahash" 2>/dev/null || echo x)"
    current="$( (shasum "$schema" 2>/dev/null || sha1sum "$schema" 2>/dev/null) | awk '{print $1}')"
    [ -n "$current" ] && [ "$baked" = "$current" ]
}

stack_wait_budget_seconds() {
    local warm_budget first_run_budget
    warm_budget="${CLOUDBENCH_STACK_WAIT_SECONDS:-900}"
    first_run_budget="${CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS:-2160}"
    # A newly cloned guest whose dump is absent OR schema-stale pays the full prod
    # cold-sync, which legitimately exceeds the warm 900s startup budget. Grant the
    # longer first-run budget in exactly the cases run.sh will cold-sync.
    if ! cloudbench_seed_dump_restorable && [ "$first_run_budget" -gt "$warm_budget" ]; then
        printf '%s\n' "$first_run_budget"
    else
        printf '%s\n' "$warm_budget"
    fi
}
