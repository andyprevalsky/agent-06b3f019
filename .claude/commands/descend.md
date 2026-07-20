---
description: "Descend on a slice of benchmark tasks and drive it to 100% green with zero reward hacks: run → triage infra → RCA every failure to a local repro + fix → report a compressed RCA card deck → on approval, rerun and async-deploy every confirmed fix. Repeat until the whole slice passes."
argument-hint: "<slice> — a group name (daily | pre-deploy | rose-bench) OR an explicit list of task names (space/comma separated)"
---

# /descend

**North star: every task in the given slice PASSES, with ZERO reward hacks.**

"Descend" = keep driving the slice downward toward all-green, iteration after
iteration, RCA'ing and fixing real root causes until nothing fails. You do not
stop when it's "probably fine" — you stop when the slice is genuinely 100%
green on a real rerun and every fix is a legitimate root-cause fix.

This command composes three existing commands — [`/benchmark`](benchmark.md)
(run), [`/rca`](rca.md) (diagnose+fix with a mandatory local repro), and
[`/deploy`](deploy.md) (ship) — into one autonomous loop. Read those three
before you start; this file only adds the orchestration around them.

`$ARGUMENTS` is the **slice**: either a catalog group (`daily`, `pre-deploy`,
`rose-bench`) or an explicit list of task names. Resolve a group name to its
concrete task list before running (see **Resolving the slice** below) and print
the resolved list so the user can see exactly what you're descending on.

---

## The hard rules (violating any of these fails the whole run)

1. **No reward hacking — ever (repo rule 25).** You may NOT change a benchmark's
   definition, prompt, expected tools, pass criteria, load size, timeout,
   concurrency, price cap, or any production behavior to make it pass. You may
   NOT add a fallback path that masks the primary path failing (rule 8). You may
   NOT weaken a repro's assertion. A "fix" that only moves the goalposts is a
   FAILURE, not a pass — call it out instead of shipping it. If you believe a
   task definition is genuinely wrong, STOP and ask the user; do not edit it.
2. **No diagnosis without a local repro (repo rule 6 / `/rca` hard gate).** For
   every failing task you report a root cause for, you must have (a) a local
   reproduction you actually ran and watched FAIL on the buggy code, and (b) a
   fix that makes that SAME repro pass unchanged. A theory is not a deliverable.
   If you cannot reproduce it, label it an **open observability gap**, not an RCA.
3. **Actively drive every background run (repo rule 1 + rule 19).** The bench run
   is a long cloud fleet. Never fire it and passively wait. Poll on the rule-19
   cadence (every 10s for the first 60s, then every 60s), check BOTH output
   growth AND controller liveness (`ps`), and react the instant it dies or
   finishes. A silently-dead fleet leaks paid Fly machines.
4. **Fix the infra you trip over (repo rule 1b + 27).** Infra failures (clone
   races, teardown leaks, stale tokens, pool exhaustion, flaky barriers) are IN
   SCOPE — RCA and fix them so no future run hits them. But **never** kill a
   run-bench fleet you did not launch in this session (rule 27).
5. **Every confirmed fix must land a cemented test.** The repro that proved the
   bug becomes a checked-in test in the suite that owns that boundary, so the
   regression can't silently return (repo rule 1).

---

## Resolving the slice

If `$ARGUMENTS` is a group token (`daily` / `pre-deploy` / `rose-bench` /
`incomplete`), expand it to the concrete task names the backend resolves that
group to — the source of truth is `deriveTaskGroup` /`resolveTaskGroup` in
`back-end/src/domains/benchmarks/hubCatalogService.ts` applied to
`agents/benchmarks/tasks.json` (`status`, `bench`, `tags`, explicit `group`).
Expand it with a small script over `tasks.json` that mirrors that logic, then
print the resolved list + count. If `$ARGUMENTS` is already a list of task
names, use it verbatim. Never silently drop or add tasks — the slice you report
on must equal the slice you ran.

---

## The loop

Repeat until the slice is 100% green on a real rerun with no reward hacks.
Track it with the task tools (one tracked item per failing task is helpful).

### Phase A — RUN the slice

Run through the isolated benchmark entrypoint (never hand-roll a stack):

```bash
scripts/run-bench <resolved task names...>
```

This delegates to the per-bench cloud fleet (each task gets its own isolated
machine; per-task REAL/SIM comes from the catalog's `world_model_mode` — do not
override it). Capture the controller PID + dashboard URL it prints. Monitor per
rule 19 until every bench reports a terminal result. **Include a valid FE link
for each agent run** (`http://localhost:<viewer>/?agent-id=<id>`) and verify it
renders, per CLAUDE.md.

### Phase B — TRIAGE every non-pass into exactly one bucket

- **INFRA** — the harness/fleet failed, not the agent: clone/volume race,
  teardown leak, stale secret, pool exhaustion (`EMAXCONN`), barrier/driver
  death, machine never warmed, control-plane saturation, missing compute-token
  seed, etc. (See the many `project_cloudbench_*` / `project_daily_*` memories
  for known signatures.)
- **TASK** — the agent genuinely failed the task's real pass criteria.

A "pass" that only passed because a fallback/silent-substitute masked the real
path (e.g. `actual_model=gemini` when we assert `claude-*`, a test card bypassing
the Rose card path) is a **TASK failure**, not a pass — bucket it accordingly.

### Phase C — FIX all INFRA first (so the next run gives a clean signal)

`/rca` each distinct infra failure to a local repro + root-cause fix, harden it
(rule 1b), and cement a guard/test where one exists (many already do —
`cloudbench_dependency_sync_test.py`, the multi-workstream scenarios, etc.).
Infra noise makes TASK triage unreliable, so clear it before trusting failures.

### Phase D — RCA every TASK failure to a local repro + fix

For each TASK failure, run the full `/rca` gate:

1. Gather runtime evidence first (worker/backend logs, agent_latency.py,
   agent_logs.py, DB) — never reason from code alone.
2. Build a **local repro** that fails on the bug. Prefer extending the existing
   blackbox/eval suite that owns the boundary over a throwaway script (rule 18).
3. Fix the real root cause. No reward hacks (rule 1 above).
4. Re-run the identical repro → it passes, assertion unchanged.
5. Cement the repro in a consistently-run suite (rule 5 above).

Run independent RCAs in parallel sub-agents when they don't touch the same files.

### Phase E — REPORT to Andy (the RCA card deck)

Emit the compressed card deck defined in **Report format** below. This is the
decision surface: Andy reads it and says which fixes to accept / edit / drop.
STOP here for his input — do not self-approve and barrel into a rerun.

### Phase F — Apply Andy's decisions

Accept the fixes he greenlights; apply any edits he asks for; drop the ones he
rejects. If his feedback (or a follow-on fix) touches any prompt/instruction/
command/skill file, re-request prompt approval for those hunks (repo rule 26) —
approval is snapshot-scoped.

### Phase G — RERUN (back to Phase A) + async-deploy confirmed fixes

Rerun the slice (targeting at least the previously-failing subset —
`scripts/run-bench --rerun-failed latest` or the explicit names; never re-run
passing tasks just to burn time, but the final acceptance rerun must cover the
whole slice to prove no regressions).

**For every fix that now makes its task PASS on the real rerun**, ship it
without slowing the loop: commit that fix on its own branch and fire a
**background sub-agent** that runs [`/deploy`](deploy.md) for it in an **isolated
worktree** (`isolation: "worktree"`, `run_in_background: true`). The descend loop
does NOT block on deploys — it keeps descending on the still-failing tasks while
deploys run in parallel. Track each deploy sub-agent and surface its outcome
(merged / blocked) in the next report. A fix only earns a deploy after the real
bench (not just the local repro) confirms it — local-repro-green alone is not
enough to ship.

Loop until the slice is fully green. Then set up the cron only once a clean run
is reproducible (that's the whole point — stability before scheduling).

---

## Report format (the RCA card deck)

Optimize for **minimum tokens Andy must read** and **maximum parseability**.
One header line, then one compact card per failing task. Passing tasks collapse
to a single count — do not narrate them.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  DESCEND · <slice> · run #<n> · <P>/<T> ✅   <F> ❌
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ <task-name>                                        [TASK | INFRA]
   repro   ✅ <cmd> → FAILED: <one-line observed vs expected>
   fixed   ✅ <same cmd> → PASSED   ·  edit: <file:line>
   problem <≤1 line: the first-bad-boundary root cause>
   fix     <≤1 line: what the fix does>
   cement  <suite/test the repro now lives in>

❌ <task-name>                                             [INFRA]
   repro   ⚠️ NO LOCAL REPRO — open observability gap
   note    <what evidence exists + what capture is missing>
   ...
```

Card rules:
- `repro`/`fixed` are the two verification lines Andy asked for — each is a
  literal command + its pass/fail outcome, so the proof is right there and he
  doesn't have to trust prose. If there's no repro yet, say so plainly (⚠️) and
  mark it an open gap — never fake a ✅.
- `problem` and `fix` are ONE line each. No walls of text; link deeper detail by
  reference (agent-id, log path, PR#) instead of inlining it.
- Flag every reward-hacking temptation you resisted, so Andy can see the
  goalposts didn't move: e.g. `⚠️ resisted: raising the 60s timeout — real cause
  was a retry loop, fixed that instead`.
- After a rerun, add a `deploy` line per shipped fix: `🚀 deploy #<id>: merged` /
  `⏳ in review` / `🚫 blocked: <why>`.
- Keep it pretty and scannable — the whole point is Andy parses it in seconds.

---

## Done means

- Every task in the slice PASSES on a clean rerun (no infra noise, no reward
  hacks, no silent-fallback pseudo-passes).
- Every fix that shipped went through `/deploy` (merged to main) via its
  background sub-agent, and every repro is cemented in a consistently-run suite.
- The run is reproducibly green — only then propose/enable the cron for the
  slice, so we schedule stability rather than scheduling flakiness.
