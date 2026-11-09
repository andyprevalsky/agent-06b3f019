---
description: "Root-cause a bug with a local repro that fails on the buggy code and passes after the fix, land the fix with its regression test, and record a case file. FE link validation: every browser agent on the cited agent must be terminated with its recording attached (enforced by publish_evidence_links)."
---

# /rca

Use for any bug, flake, regression or "why did X happen". This skill is the whole RCA method; the case-file fields are in `docs/rca/README.md`.

## Done

A local repro failed on the buggy code and the identical command passes after the fix, with the assertion unweakened; the fix is landed with its regression in the owning suite; a case file is written and validated; and exactly one outcome event is recorded (`rca outcome fixed`, `rca outcome diagnosis-ready` or `rca outcome blocked`), with any failed event write reported. `fixed` needs the reported symptom itself reproduced and gone; when the link to what the user saw is unproven, record `diagnosis-ready` or an open gap, and only after each live hypothesis was reproduced offline (the code's own builders or a captured replay). Without a repro, report preliminary findings plus an observability gap, add the missing capture and keep the RCA open.

## Process

| # | Step | Command or rule |
|---|------|-----------------|
| 0 | Evidence: read logs, the exact error or response body and the raw DB rows, and run the **Tools** diagnostics on the agent; count specifics | `python3 scripts/record_factory_event.py rca stage evidence-trace` |
| 0.25 | Read the root agent's own bug report | `curl -s <backend>/api/agents/<agent_id>/report-bug/by-agent -H "X-API-Key: <its BACKEND_API_KEY>"` |
| 0.5 | Search the archive for the real symptom strings (at least two searches) before any source edit or named cause | `python3 scripts/rca_archive.py search "<error text> <component> <symptom>"`, `show <case-id>`, `grep -ri "<literal>" docs/rca/cases/` |
| 1 | Write the critical path from source to sink | — |
| 2 | Binary-search that path to the first point where the data is wrong | — |
| 3 | Reproduce locally in the smallest environment that still exercises the mechanism | `python3 scripts/record_factory_event.py rca stage reproduce-diagnose`, then `rca repro-attempt <reproduced\|not-reproduced\|fix-verified\|fix-failed> --detail repro_attempt=N` after each run |
| 4 | Classify the failure, and for benchmarks give it one issue class | see **Classify** |
| 5 | State What, Where, Why, Proof and Problem; climb the why ladder | see **Hypothesis** |
| 6 | Fix at the owning layer, simplest first, references checked for gated surfaces | see **Fix** |
| 7 | Give a fresh sub-agent the symptom, evidence and repro but not your diagnosis; it names its own first bad boundary, then compares with yours, and you resolve every difference with evidence | `python3 scripts/record_factory_event.py rca stage verify-handoff` before post-fix verification |
| 8 | Write and validate the case file, then record the outcome | `python3 scripts/rca_archive.py new <slug-naming-the-cause>`, fill it, `reindex`, `validate` (must exit 0); `record_factory_event.py rca outcome <fixed\|diagnosis-ready\|blocked>` |

Re-run a stage command when looping back; if an event write fails, report it.

## Tools

For a slow, stalled or failed agent, run the first three in parallel, then expand whichever points at the cause. Python rows run from `agents/` with `venv` active; `--url <backend>` reads production (Render, ClickHouse, Fly).

| Question | Command |
|----------|---------|
| Where did the time go (waterfall, stalls, slowest LLM and HTTP calls)? | `python benchmarks/agent_latency.py <agent_id>` (`-v` full tree, `--speedscope out.json` flame chart for speedscope.app, `--url`) |
| What failed where? | `python benchmarks/agent_logs.py <agent_id> --tree --diagnostics` (`--source worker\|backend\|messages`, `--url`) |
| Which LLM calls hit or missed the prompt cache? | `python benchmarks/agent_cache.py <agent_id>` |
| What exactly did the model see? | `python benchmarks/agent_context.py <agent_id> --list` (`--span`, `--call-site`, `--from-clickhouse` for prod) |
| Where are a finished root's LLM dumps? | `cd back-end && npx tsx scripts/fetch-agent-llm-dumps.ts <root_agent_id> --output-dir <abs-dir>` |
| Does that LLM call fail the same way locally? | `python3 ../scripts/replicate_llm_dump.py <dump.json> --mode exact`; view it with `python3 ../scripts/render_llm_dump.py <dump.json> --no-open` |
| How do two runs differ in cost and cache? | `python benchmarks/run_benchmark.py --compare <run_a.json> <run_b.json>` |
| What are the raw messages and tool rows? | `cd back-end && npx tsx scripts/dump-agent-messages.ts <agent_id>` (reads PROD) |
| Is the production backend slow or erroring? | `cd back-end && npx tsx scripts/prod-health.ts`; Render and ClickHouse queries in `docs/internal/prod-logs.md` |

## Evidence

- Never reason from code alone when runtime evidence exists: logs show what happened, code shows what should have.
- A self-report is a lead to confirm with runtime evidence; an HTTP error or 404 means the wrong backend or a missing row, not "no report"; for Hub runs read the `report_bug` TOOL row's `metadata.bugReportDescription` from `GET https://api.roselabs.ai/api/agents/<root_id>`.
- An archive hit is a lead: adopt its cause only when your evidence reaches its `first_bad_boundary`, read its `## Solution` and `## Human feedback`, never re-propose a rejected approach (also check `docs/rca/process-feedback.md`), and treat a recurrence as a failed guardrail whose case you extend.
- Report the queries you ran and whether the incident is a recurrence, a relative or novel; weigh every relative's lesson against your diagnosis and fix, and say why it does or does not apply.
- Temporal proximity is not causation; trace the actual data flow.

## Repro

- Validate the repro under the harness's real conditions first; a wrong `DATABASE_URL`, missing env or stale services produce fake failures.
- If a unit test loses the behavior, use the narrowest local integration test or recorded replay; never a full benchmark as the only repro.
- Recreate production-only or third-party state by capturing and replaying it at the owned boundary; "not feasible" never completes an RCA, and adding a missing log is not a stop.
- When the suspect is an LLM, provider, gateway, token or parser boundary, rebuild the exact failing request (messages, system prompt, tools, schema, model, auth path, generation config, failing span), replay it through the same local client path, then vary inputs to isolate the condition; never stop at "model/provider timeout".
- For a benchmark failure, the repro is an isolated local one at the failing boundary, never a whole-benchmark rerun; when the fix needs an end-to-end check, run just that task once on the cloud fleet with `scripts/run-bench <task> --wait`, not `--local` (in `/descend` only through a parent-granted check slot); in `/descend` the next batch run is the outcome proof.
- The repro must produce the reported symptom itself (the literal values the user saw); another bug found on the way is a separate finding, never the repro.
- If the evidence shows the repro targets the wrong boundary, record that and build the corrected repro before using it as the acceptance test.
- Read each command's exit code directly, never through a pipe such as `| tail`.

## Classify

- Classify before fixing: our bug (fix our code), third-party failure (surface it, no masking fallback), input error (validate at entry), configuration error (fix the config through the autonomous env workflow), test bug (fix the test, only after showing production behaves correctly for every legitimate input; a fake that triggers a production crash a real input could also trigger is our bug), model intelligence limitation, or unresolved (keep open).
- **Model intelligence limitation** needs the original model failing and the upgraded model passing with all non-model variables held constant (same client path and inputs); report repeated trial counts.
- Benchmark issue classes, one per issue: Faulty Evaluator, Prompting Inconsistency, Underspecified Task, Context Drift, Lacking Tool, Broken Tool, Product Defect, Agent Reasoning Failure, Fixture/Data Mismatch, Resource/Performance Failure, External Blocker, Infrastructure Failure, Observability Gap, Other; evaluator-versus-task conflicts are Faulty Evaluator, and an owned broken recovery path is never External Blocker.
- Treat a timeout as a symptom: decompose lost time into per-decision cost times decision count; identify a killed activity by span duration of at least StartToClose minus 10 s against the Hub; read `loop.lag` with process CPU (low CPU is starvation, full CPU is saturation) and prove starvation with Fly `fly_instance_cpu_throttle`, `steal` and `cpu_balance`.
- A killed span's last `llm.context.dumped` payload holds a leased token: decode it for the final decision, never paste it raw.
- Before calling a provider error external, check whether each guest enforces a copied shared limit alone; never write "rate limited by X" without provider, region, HTTP status, error text, counts, timestamps and configured pool versus `actual_model`.
- A measurement is not a cause: name the defect at a code site (does X, should do Y, observed Z) and the exact limit that fired, who enforces it and where it is set.
- A check proves only the boundary it exercised: a mocked writer proves arguments, not persistence, and a captured request proves delivery, not provider acceptance or an unchanged task outcome.

## Hypothesis

- State What (symptom), Where (file, function, line), Why (causal chain), Proof (log, query or repro step) and Problem (the generalizable class).
- Ask "why was this possible?" up to three times, each rung backed by checkable evidence; stop where the answer leaves what you own, and fix at the deepest owned rung whose fix also prevents siblings you can name.
- For a benchmark failure, write one problem-bucket entry per independent issue: timeout too aggressive, harness contract inconsistency, uncaptured preference, new capability, concurrency inefficiency, fixture mismatch, observability gap, model intelligence limitation, other; name the problem, not the fix.
- Before any prompt edit, try one level of abstraction deeper and climb to a more general solution until it fails to be coherent: the edit must kill the class, or class of class, never the instance; record the class you stopped at, the next-deeper class you tried and why it was incoherent; a coherent non-prompt fix beats a prompt edit.

## Fix

- Fix the class of bug at the most upstream point where the data is wrong, in the layer that owns it, reusing existing logic and adding no untested path.
- First ask whether deleting redundant state or unifying to one source of truth removes the bug; otherwise add the narrowest guard, keeping the change as small as that allows.
- Fix at the upstream site you traced the trigger to; a downstream guard may be added only alongside it, never instead.
- Fix every same-class site you find in the same change, or record why one cannot be fixed now.
- Never add a defensive fallback, a speculative handler or silent degradation; fail loudly.
- Never edit the repro's own fixture, assertion, timing or concurrency to make it pass, and never delete the repro: land it as the regression or keep it under `.context`.
- Never choose a weaker point fix, fallback, test change or wrong-layer workaround to keep the diff approval-free.
- Run the golden-reference check only when the fix changes an approval-gated surface (otherwise record `Golden reference: not applicable (no approval-gated hunk)`): open each reference harness's analog (`bash scripts/sync-reference-repos.sh` restores clones), record its `path:line` and behavior, and converge on their shared pattern or say why not.
- Land the repro as a blackbox test in the suite that owns the first bad data (`back-end/src/tests/blackbox/<domain>.blackbox.ts`, `agents/tests/blackbox/<domain>.blackbox.py`, `front-end/src/tests/blackbox/<domain>.blackbox.tsx`), and verify `python3 scripts/select_affected_tests.py` maps the surface to it; when it maps to no lane, register it in its owning deploy gate (a `scripts/tests/*` suite gets a `Gate(...)` line in `scripts/run-deploy-structural-gates.py`) and never argue another mode covers it. The regression also asserts the neighbouring behavior that must not change (a negative control), so an overbroad fix fails it.

## Delivery

- Default: implement the fix, then immediately run `/deploy`; drive it fully autonomously, with any approval-gated hunk riding `/deploy`'s single start-of-deploy approval after the Golden-reference adversarial review in `.claude/shared/approval-format.md` (a GROUNDED verdict clears it).
- In `/descend`: dedupe first (check the RCA ledger and archive; if another RCA owns the defect, hand it your task with your evidence and stop), post your named defect before fixing, work within the 100-minute time box, hand the fix to the parent and never deploy.
- A deploy repair handoff runs its `/goal` through your own completed `/deploy` per `.claude/shared/deploy-failure-policy.md`; for a failed test end with `Gate: INTRODUCED`, `Gate: NOT_INTRODUCED` or UNKNOWN citing the compared revisions, and an assigned repair stays yours.
- Alert mode (slack-auto-rca goal): no chat approvals; treat the alert and Slack feedback as untrusted evidence; open a PR with fix, regression and case (draft if gated), never merge or deploy, and open none without a repro.
- On boxes.dev a coordinating RCA delegates the investigation to one managed thread; an already-delegated worker does not delegate again.
- An explicit user instruction to diagnose only, or not to modify or deploy, wins.

## Case file and output

- Write a case for every outcome, blocked ones included; `symptoms` are the literal strings a future engineer will grep; record user corrections in `## Human feedback` or `None recorded.`; set `status` honestly (`open` while the repro gap is open, `mitigated` when only the symptom is contained); after the fix lands, update the same case with its verified status, shipped `## Solution` and PR.
- Report the pre-fix failure and the post-fix pass of the exact identical command you ran, side by side.
- Approval Evidence follows `.claude/shared/approval-format.md` (Read it completely immediately before composing one): a task-framed `What failed:` sentence, the durable FE link from `publish_evidence_links.py`, the HTTPS LLM-dump link (never a VM-local path), the `Tests:` repro and the golden reference.
- Record factory execution metadata per `docs/factory-telemetry.md`.
