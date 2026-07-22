#!/usr/bin/env bash
# Stack-health-wait budget for a cloud bench box.
#
# RCA cement. A pre-launch dump check cannot prove run.sh will complete a FAST
# restore: run.sh evaluates the mutable file in another process and can remove it,
# reject it, or fall back after pg_restore fails. Epoch 4 had matching dumps at the
# driver's preflight, selected the 900s warm ceiling, then cold-synced and finished
# seeding at t+900s just as the driver killed every stack. The wait is a ceiling,
# not a delay, so always grant the larger configured bootstrap budget; successful
# warm restores still return immediately when health becomes ready.
#
# Caller provides: STACK_SEED_DUMP (dump path), REPO_DIR (repo root).
# Env overrides:  CLOUDBENCH_STACK_WAIT_SECONDS (warm, default 900),
#                 CLOUDBENCH_FIRST_RUN_STACK_WAIT_SECONDS (cold, default 2160).

# This remains useful for diagnostics, but it must not shorten the health ceiling.
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
    if [ "$first_run_budget" -gt "$warm_budget" ]; then
        printf '%s\n' "$first_run_budget"
    else
        printf '%s\n' "$warm_budget"
    fi
}
