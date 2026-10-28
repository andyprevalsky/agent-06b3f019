---
description: "Iterate on prompt text against a real diverging LLM call: localize the dump, replay it as the test case, propose a minimal non-overfit prompt edit, then re-run the same local replay after approval."
argument-hint: "<agent_id> [optional: call_site or dump path]"
---

# /update-prompts

Use this whenever a trajectory took the wrong tool/path and you believe a
**prompt** (not a runtime hook, not a special-case injection) should fix it.

This command is for prompt-iteration only. It does not replace `/RCA` for
harness bugs, fixture gaps, or non-prompt first-bad boundaries. If the
diverging call cannot be localized to a dumped LLM request, stop and say so.

## Hard rules

1. **The test case is the real LLM call.** Identify the call that first
   diverged from the correct path and replay that call locally. Do not invent
   a synthetic mini-prompt as the sole proof.
2. **Edit the prompt source, never a runtime hook.** Allowed: checked-in
   prompt constants / builders (`agents/utils/prompts.py`,
   `agents/tools/prompts/*`, tool docstrings that render into the system
   prompt). Disallowed: mid-call string injection, per-task overlays, hidden
   graders that rewrite the prompt, or hard-coded if-goal-contains-X branches.
3. **No task-overfit prompt tokens.** Every added token expands context and
   taxes unrelated tasks. Reject edits that name the concrete incident
   (specific sites, brands, benchmark titles, one-off schemas) when a shorter
   general rule covers the class. Prefer deleting contradictory guidance over
   stacking a new special case.
4. **Stop for confirmation before changing prompt files.** Step 2 proposes;
   Step 3 applies only after the user confirms the exact edit.
5. **Same repro before and after.** Re-run the identical local replay command
   after the approved edit. Do not weaken the assertion.

## Timing hooks

```bash
python3 scripts/record_factory_event.py update-prompts stage localize-replay
```

Run after Step 1 has a failing local replay recorded. Before proposing the
edit:

```bash
python3 scripts/record_factory_event.py update-prompts stage propose-edit
```

After the user confirms and the post-edit replay finishes:

```bash
python3 scripts/record_factory_event.py update-prompts stage verify-summary
python3 scripts/record_factory_event.py update-prompts outcome iterated
# or: outcome blocked
```

## Step 1 — Localize and replay the diverging call

1. Identify the first wrong decision in the trajectory (wrong `tool_name`,
   wrong agent type, skipped tool, premature completion, etc.).
2. Materialize the dump for that agent:
   - Prefer local `.llm-dumps/<agent_id>/`
   - Else R2 trace archive:
     `cd back-end && source .env && npx tsx scripts/fetch-agent-llm-dumps.ts <agent_id>`
   - Else ClickHouse (when reachable):
     `cd agents && source venv/bin/activate && python benchmarks/agent_context.py <agent_id> --from-clickhouse --list`
3. Pick the dump whose `call_site` owns the decision (e.g. `planner`,
   `execute_loop`, `explore_agent`). List with
   `python benchmarks/agent_context.py <agent_id> --list`.
4. Render for humans:
   `python3 scripts/render_llm_dump.py <dump.json> --no-open`
5. Replay locally with the dump's messages/config:

```bash
cd agents && source venv/bin/activate && source .env
python3 ../scripts/replicate_llm_dump.py <dump.json> --mode exact
```

6. Record the assertion the replay must eventually satisfy (examples):
   - planner: ≥1 `spawn_code_agent` and 0 `reasoning` for API bulk-rank work
   - execute: exact tool name / agent type
   - explore: no fan-out beyond N, or handoff signal present

This exact dump + assertion is the test case. Baseline must FAIL the
assertion (or match the original wrong behavior) before any prompt edit.

If the dump cannot be fetched or replayed, stop: that is a dump-capture /
replay-tool gap, not a prompt win.

## Step 2 — Propose a minimal prompt edit (stop here)

Read the dumped system prompt and the owning prompt builder. Propose the
smallest source edit that would flip the assertion, scored against:

| Prefer                                                | Reject                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| One short general invariant                           | Incident-named examples (this site, this benchmark) |
| Resolving a contradiction between existing rules      | Stacking a second rule that fights the first        |
| Deleting/rephrasing the guidance that caused the miss | Broad essays, bullet piles, or tool catalogs        |
| Class of work (API bulk fetch vs unknown discovery)   | Single task goal paraphrase                         |

Output format (mandatory):

```
## Prompt edit proposal

**Call:** <call_site> on <agent_id>
**Dump:** <path>
**Baseline assertion:** <one line>
**Baseline result:** FAIL — <measured wrong behavior>

**Proposed file:** <path>
**Proposed change:** <unified diff or before/after of ≤ ~15 lines>
**Why this is not overfit:** <one sentence naming the general class>
**Token budget:** ~N tokens added / M removed (net …)

Confirm this exact edit to apply and re-run the local replay.
```

Do **not** edit prompt files in this step. Do not run `/deploy`. Wait for
the user to confirm, reject, or ask for a tighter proposal.

## Step 3 — Apply confirmed edit and re-run

After explicit confirmation of the proposed edit (or a user-revised variant):

1. Apply only that confirmed hunk to the prompt source.
2. Rebuild/patch the dump's system prompt from the updated builder when the
   replay mode supports it; otherwise patch the dump text to match the
   approved source edit exactly.
3. Re-run the identical replay command.
4. Print a concise human summary:

```
## Update-prompts result

| | |
| --- | --- |
| Call | `<call_site>` |
| Dump | `<filename>` |
| Assertion | <one line> |
| Baseline | FAIL — <wrong tools/behavior> |
| After edit | PASS/FAIL — <tools/behavior> |
| Net prompt tokens | +N / −M |
| Source | `<file>` |

Next: cement via prompt-invariant blackbox if PASS; otherwise propose a
tighter edit (return to Step 2).
```

If PASS, add/extend a prompt-invariant blackbox that locks the new wording
(string presence / absence), not the incident goal text.

## Fetch / replay cheat sheet

```bash
# Materialize prod dumps via R2
cd back-end && source .env && npx tsx scripts/fetch-agent-llm-dumps.ts <agent_id>

# List call sites
cd agents && source venv/bin/activate
python benchmarks/agent_context.py <agent_id> --list

# Exact replay (baseline)
python3 ../scripts/replicate_llm_dump.py \
  ../.llm-dumps/<agent_id>/<ts>-<id>-planner.json --mode exact

# Replay with current planner system prompt builder (post-edit check)
python3 ../scripts/replicate_llm_dump.py \
  ../.llm-dumps/<agent_id>/<ts>-<id>-planner.json --mode rebuild-system
```

## Required factory execution metadata

Follow `docs/factory-telemetry.md` for every new factory run. Record exact
model/provider, effort, speed/service tier, harness/version, scoped token/cache
usage and cost, worker attribution, resource/concurrency context, disjoint wait
times and validation provenance. Every known value requires a timestamped source;
unavailable values stay explicitly unknown. Never guess historical settings or
publish raw transcripts, secrets or signed URLs. Set `FACTORY_METADATA_FILE`
before collection, append snapshots for changes and publish the ledger. Final
scorecards report model/effort/tier and collection gaps alongside timings.
