---
id: 2026-10-27-polar-browser-substrate-unbound
date: 2026-10-27
title: Polar BU browser benchmarks ran as unrestricted roots and completed through explore
surface: harness
component: polar-execution-adapter
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_benchmark.create_agent selects unrestricted AgentWorkflow for a browser-substrate suite; deterministic admission repro corrected, unchanged live task outcome pending
symptoms:
  - "Expected tool 'spawn_browser_agent' not found in messages"
  - "No browser agent trajectory was recorded; expected at least 5 steps per browser agent"
  - "deployment_disabled: Insufficient quota available for instant inference"
  - "rose.complete.cerebras.fall_through reason=RoseRateLimitError call_site=response_schema"
tags:
  - polar
  - browser-substrate
  - explore
  - provider-fallback
sources:
  - benchmark run campaign-20261027-060019-631588 on devbox f8f1d5ab
  - commit 35ae7f4a7 (campaign source)
  - commit 0c96ea5a86edf9f3267e6a4edacf4870cf834bd0 (R1 inspection base)
  - agent de3c7162-6bda-4a00-a64a-593e146bbd66 (failure)
  - agent 1d252f2f-855b-477f-90c2-9603bcd7765f (same-task pass)
  - task boxes.dev reviewer ph79x0wes55k0qxakj3rtvt8yh8h3ets
repro: agents/tests/blackbox/browser_execution.blackbox.py
status: open
---

## Problem

R1 of the Polar k3 descent initially reported 27 no-browser failures. The final
producer TSV instead contains **26 no-browser failures, two distinct judge
failures, and two passes** (30 scheduled copies). Do not preserve the earlier
27 as a terminal count. All 26 no-browser roots reached COMPLETED, used explore
agents, and generated a response schema successfully. None launched a browser.
The two polar-bu-002 judge failures belong to R2, not this cohort.

The unchanged polar-bu-074 prompt is:

> According to github, when was Regression added to the oldest closed numpy.polynomial issue that has the Regression label in MM/DD/YY?

Its failure de3c7162 answered 04/15/18, agreeing with the catalog ground truth;
the native verifier awarded 100%. The benchmark rejected the absent browser
trajectory. This is a real benchmark failure; semantic correctness does not
waive its browser requirement. No task prompt, evaluator, expected tool,
minimum steps, timeout, fixture, load, or price cap was edited.
Catalog preservation receipts (SHA256, identical before/after this patch):
`polar_tasks.json` = `0b631780c080d1022f5acb52400bbe46e81a45337a832f288a3641bc495796a9`;
`polar_catalog.py` = `23809eb3426240e01271dff3b562388ca42974cff5a6466413ac7c949a7de319`;
`benchmark_tasks.py` = `035b959ee6d9a5df71a88db4d821462d1e5c08074766e2c2059ab18bd350ea33`.

## Diagnosis

### Provider hypothesis falsified

The failure's request c5e81fc2 / span 8b8c0dbb2f63 is fully correlated:

- 06:19:21.468204Z: response_schema begins on rose-1-flash, deadline 90s.
- 06:19:21.784599Z: Cerebras pre-content RoseRateLimitError falls through.
- 06:19:22.226383Z: Foundry sends an SSE error with type/code
  deployment_disabled, message "Insufficient quota available for instant inference."
- 06:19:22.227693Z: Foundry RoseServerError falls through.
- 06:19:25.043044Z: OpenRouter Qwen finishes successfully, elapsed 3.595s.
- 06:19:25.045093Z: generated schema has regression_label_added_date and issue_number.

The passing contrast has the same schema failures followed by Qwen success in
3.120s. All 26 failed copies generated schemas: 25 via the waterfall and one
(polar-bu-095 r3, request 604ec4f9) directly on Cerebras in 1.384s. Therefore
provider quota is **not the shared first-bad cause**, and the configured fallback
is not absent. The external Foundry rejection remains unrepaired, but there is
no measured numeric quota cap, usage balance, or provider exhaustion blocker in
this cohort. Do not request funding or add a new fallback on this evidence.

### First observed execution divergence

Both BU-074 roots first select an explore agent. Their initial actor tool arrays
and generation configuration are identical; first two system messages are
identical. The third system message differs only in nullable output-field flags;
user-message references differ in UUID. Neither actor sees an explicit browser
execution requirement or minimum-five-step instruction.

The second actor call is the first observed trajectory divergence:

- Failure: request e1f4853e, dump b096b1161850, span b18b1609dd13 selects wait_for
  on /root/find_issue. It later displays the answer and calls attempt_completion.
- Pass: request 25cc629f, dump 2964be871fd6, span 19d61bc635bf selects
  spawn_agent(type=browser), task_name=github_verify, and executes 26 browser steps.

The failure's final verifier explicitly accepts the explore evidence. The
passing verifier also relies on explore #10881 rather than the browser's #22669.
A browser-presence check passing is not proof the browser supplied the answer.
This is not a demonstrated model-intelligence limitation: no controlled
model-only comparison was run.

Critical path: catalog browser requirement -> generic create-agent request ->
unrestricted root tool choice -> explore web_search/web_fetch -> native semantic
verifier accepts answer -> external browser-trajectory check rejects.

The earliest **candidate owned boundary** is the suite adapter:
`agents/benchmarks/run_benchmark.py:create_agent` calls `_benchmark_goal_for_task`
and passes the raw task into ordinary AgentWorkflow, without selecting a browser
execution surface. The catalog's requires_browser_agent/expected_tools configure
provisioning/evaluation, not the actor's capability binding. Missing forwarding
alone is not proof that every such metadata field should become a runtime mandate.

### Local evidence replay (not a repair)

These commands were actually executed at the inspection base. Artifacts live in
`.context/polar-r1/` on the R1 devbox; originals remain in the launch owner's archive.

- `PYTHONPATH=agents:agents/tests/blackbox agents/venv/bin/python .context/polar-r1/replay_schema.py`
  reconstructed the real schema goal/system/schema/settings and replayed the
  captured Foundry SSE error, captured Qwen output, and reported Cerebras cooldown
  through `_generate_response_schema_with_rose`. PASS: unchanged code falls
  through to Qwen and returns the two real fields. This is an offline provider
  mechanism control, not a benchmark PASS or fresh provider health probe.
- `PYTHONPATH=agents agents/venv/bin/python .context/polar-r1/regrade_saved.py`
  called the canonical evaluate_task and minimum-step checker on the two original
  saved trajectories. Failure remains False with both original no-browser
  reasons and eight explore steps; passing contrast remains True with 26 browser
  steps. No trajectory or task was modified.
- Additional synthetic HTTP400 and SSE200 deployment-disabled controls both pass
  the existing schema fallback. Existing blackbox
  `test_client_foundry_server_error_falls_through_to_openrouter` also passes.

These provider controls are deterministic falsification replays. The separate
adapter admission assertion reproduced red on the base and green on the repaired
source. That red/green establishes routing and lifecycle behavior, **not** the
required unchanged live benchmark before/after outcome.

### Cluster membership

One observed symptom cohort, R1, with nine distinct tasks and 26 copies follows.
Every row's own saved run records COMPLETED, successful schema generation,
explore dispatch and absent browser metadata. Schema request IDs link to each
member's own worker events; W = waterfall success, C = direct Cerebras success.
Membership in one future *fix* cluster remains provisional until outcome proof.

| Job | Task | Agent | Schema request / route / seconds |
| --- | --- | --- | --- |
| r001-j0001 | polar-bu-095 | f37bb05b-de05-4131-8483-5fdc7082b374 | 962b4032 / W / 17.212 |
| r001-j0002 | polar-bu-092 | dc10c8c2-5aa0-47a5-9525-0da4f1a7f9ff | 82dc25c3 / W / 5.096 |
| r001-j0003 | polar-bu-079 | c40767bd-4280-4d5f-b9a1-e5d476a80f96 | e2e813d2 / W / 11.802 |
| r001-j0006 | polar-bu-084 | 7b4711a4-8b46-4b44-b48d-f7c06e575e28 | 73bf1cf1 / W / 11.627 |
| r001-j0007 | polar-bu-086 | 61055d6b-79f7-4b7f-8354-f00adc1c023c | acfbfe01 / W / 15.727 |
| r001-j0008 | polar-bu-072 | 45a66caa-ea3f-4c52-ac5e-7403601f6048 | 783a8bda / W / 3.751 |
| r001-j0009 | polar-bu-060 | 364afb69-6386-4589-ae6f-a1fda4c1125d | 9b624be5 / W / 5.535 |
| r001-j0010 | polar-bu-063 | cf0ce4bd-2aaf-4dd3-ad31-a768d5b18f9c | 0f284993 / W / 4.502 |
| r002-j0011 | polar-bu-095 | 26b8600c-9341-4453-aa81-72f8447d63f1 | 43ec34ed / W / 16.625 |
| r002-j0012 | polar-bu-092 | cb125388-76ea-40a9-956d-3d65adc439db | 5da76776 / W / 15.163 |
| r002-j0013 | polar-bu-079 | 1735c2a4-2120-4e3a-9898-c24d44ab17cd | 9f9c4136 / W / 6.444 |
| r002-j0014 | polar-bu-074 | 8e595254-7b32-4ad7-a99e-e672140aa5b2 | c46718e8 / W / 4.012 |
| r002-j0016 | polar-bu-084 | 5ed8f29a-23c7-47b1-9640-cfba97337c65 | 15fd6d06 / W / 7.58 |
| r002-j0017 | polar-bu-086 | 6bfa0e76-c12d-45fb-ab97-d70469e6f77d | 02a4ecd1 / W / 10.878 |
| r002-j0018 | polar-bu-072 | a458c779-f664-4843-a0ef-2df946854aba | 22526465 / W / 4.027 |
| r002-j0019 | polar-bu-060 | 862003a5-1d7f-45ae-9ddb-f2098c35e12a | eba0f22d / W / 6.644 |
| r002-j0020 | polar-bu-063 | 518cc3e8-4301-42b8-bf71-85326c939207 | dfaf916f / W / 3.738 |
| r003-j0021 | polar-bu-095 | 474fe207-3087-4b76-a32a-5a66552de575 | 604ec4f9 / C / 1.384 |
| r003-j0022 | polar-bu-092 | b1e330d1-dce8-4e9c-bb68-c56cfdf768dd | 1fbed7b8 / W / 3.536 |
| r003-j0023 | polar-bu-079 | 7645ac72-50b3-4909-9b73-6cec310d45c3 | e26d01ac / W / 7.261 |
| r003-j0024 | polar-bu-074 | de3c7162-6bda-4a00-a64a-593e146bbd66 | c5e81fc2 / W / 3.595 |
| r003-j0026 | polar-bu-084 | 90f545db-0ffe-4e21-8bd5-9a0731ec009e | 4bc4ba5b / W / 7.578 |
| r003-j0027 | polar-bu-086 | abbb2dc4-a468-4693-95e2-ab8caa642fb1 | f0fcd3a3 / W / 8.158 |
| r003-j0028 | polar-bu-072 | bfe4859a-8026-4f42-9f7a-a221eeba3d90 | 8bb23e14 / W / 3.844 |
| r003-j0029 | polar-bu-060 | b0305c9d-4aea-42db-b926-a6c868554bc1 | 23c10ff7 / W / 7.62 |
| r003-j0030 | polar-bu-063 | fcee2279-6350-41f4-85b4-44d9cb3b8da9 | a1cc568b / W / 5.164 |

Original artifact hashes:

- A-nobrowser-26-runjson.tar: 1a47a0e7ba51477ec096408ef5e5501a34b0ec6eefd5df450a0f66b96819db7c.
- A-outcomes.tsv: dab63799282fc7a31886f0c2a938c4cb5731e0eb64599c785ac4292f76148104.
- Failure run.json.gz: 7bedca452f8b7bad44d24c4729beaf553df264676a9f1489dc770918cdaa7e0d.
- Pass run.json.gz: 6a07d3888d4096140b7998f863596cc123612cc1e7d0fb63c4d0c6123f8623e9.

Full LLM dumps were recovered from worker log payload_gzip_b64, validating each
payload_sha256. Guest destruction did not make these calls unavailable. The
canonical publisher uploaded the original two run bundles and verified their
FE transcripts in fresh browsers (47 and 179 messages); the pass's browser
recording/terminal checks passed. Private signed URLs and rendered last-call
dumps are in `.context/rca_evidence/<agent-id>/manifest.json`, not Git.

### Archive and independent review

Searched raw `deployment_disabled Insufficient quota available for instant inference`
and behavior `response schema no browser provider fallback`, followed by exact
expected-tool and browser-substrate terms. No matching prior adapter case found.
The July 16 Cerebras-exclusive chat case is a relative, not a recurrence: it
lacked a non-Cerebras fallback; this incident successfully used one.

Reviewer ph79x0wes55k0qxakj3rtvt8yh8h3ets opened the provider code, full exemplar
and contrast dumps and golden sources. Provider causality rejected. The exact adapter/runtime diff was subsequently marked GROUNDED; its
review scope and native receipt boundaries are in the linked packet below.

## Solution

The explicit Polar browser adapter is implemented on the R1 branch. R1 remains
**open for unchanged-task outcome proof**. The initial goal and output schema
enter the existing native browser, whose genuine successful result is required
before the shared root completion/verifier path. No free root actor can replace
browser work with explore. Updated in-flight/paused requests retain their native
browser and require a genuine input-acknowledgment receipt; unacknowledged or
post-terminal changes fail closed instead of replaying potentially completed
writes. Task definitions and native browser policies were not edited.

The exact source patch SHA256
`f17c90011690d85bd951f1f64db9091f7d50fd1d9ed4500d1d4db9a59f073021`
was marked **GROUNDED** by independent reviewer
`ph79x0wes55k0qxakj3rtvt8yh8h3ets`. The original full report SHA256 is
`c40f727f2c0e83e2c57e03eb1ade0ad833d25c0938357e0c56ce1c9f913c80fd`.
The [per-hunk grounding packet](../packets/2026-10-27-polar-browser-surface.md)
maps every orchestration/runtime/receipt change to opened primary sources and
existing Rose lifecycle contracts. It records the unsupported boundaries too.

Permanent offline regression:
`agents/venv/bin/python agents/scripts/run_blackbox_tests.py browser-execution`
(from repository root, with the existing environment). Seventeen focused controls
exercise real workflow entry/continuation, native pause/handoff records,
actual browser activity final-sync behavior and manager receipts, late root
verifier input, genuine failure outcomes, and unchanged raw task admission.
The browser/provider/database edges are simulated; this is not a live benchmark.

The exact original admission assertion failed on the base (`execute` instead of
`browser`) and passes after the patch with raw BU-074 text and task metadata
unchanged. The saved original failure still fails both browser checks, and the
saved pass still passes with 26 browser steps. The patch did not weaken grading.

Validation on the applied reviewed source:

- Canonical agents blackbox domains `browser-execution workflow background-agents run-agent`: **4/4 PASS**, run `20261027-185204-984057-825c8698`, 177.1 seconds. This includes the 17 new controls and the existing workflow/background/root checks.
- Full `spawn-browser-agent-v3` blackbox domain: **PASS**, run `20261027-185209-984860-65f1f967`, 115.3 seconds.
- Backend `browser-execution-mode.test.ts`: **PASS**; `tsc --noEmit --incremental false`: **PASS**.
- Original schema-provider replay and saved-trajectory regrade: **PASS** with original outcomes preserved.
- RCA archive schema/index validation: **PASS**. No catalog/evaluator hash changed.

These tests execute against the checked-out source, not only a draft overlay.
All browser/model edges in the blackbox suites are controlled fixtures; no paid
cloud benchmark or deployment was launched.

Primary grounding opened by the independent reviewer:

- browser-use/benchmark revision dff86d1a32134f4bf3b38ce30ea92264cacbcac7,
  `run_eval.py:63-66,107-115` loads BU_Bench_V1 and sends confirmed_task directly
  to `browser_use.Agent(browser=browser)`.
- Same revision, `frameworks/browser_use/run_task.py:43-64` uses the same browser
  entrypoint; `frameworks/codex_harness/system_prompt.md:1-10` explicitly binds its
  alternative agent to driving browser-harness. The actual revision used by the
  Polar published run is not pinned in the available metadata.
- recursive-hq/polar-evals revision 8d94585489911a3688193cb61462a3bc99654580 has
  results/judgements and identifies a browser agent; no executable runner there.
- Local provider comparisons: OpenClaw 909591a0c810bd3da9a004c407af81075140ca2e,
  Hermes 763a98afdcaa61958bf846bab91637693e6c50cf, Codex
  14ff9c3a43ebf9bf543cf5f7c45cff2bfea2e512 and vendored Claude Code 2.1.88.
  They distinguish failure classification/retry/fallback, but establish no
  missing fallback here. Kimi Code clone unavailable; no memory citation used.

Implemented adapter and remaining prerequisites:

- The existing workflowStartPhase field persists browser launch intent. Native
  runtime state preserves that intent across continuation and deployment resume;
  wake/restart launch paths retain it.
- Existing background dispatch/join and browser manager own task identity,
  native resume hints, cost, kill/pause, recording and cleanup. No pretend model
  call or trajectory is inserted.
- The native browser's successful verifier now returns its actual acknowledged
  user-row IDs and schema-current/confirmed-read receipt. The root compares
  both pending updates and the real root verifier's requirement keys against it.
- Post-terminal updates, signal-only updates without durable identity, and
  ancestor-authored requirements not supported by native user sync fail closed.
  They cannot silently repeat a write or receive an unproven success.
- No task, rubric, expected tool, step count, timeout, prompt policy, provider
  pool or production service was modified. The two R2 judge failures are separate.

Next exact proof: the offline routing/lifecycle controls now pass. Run
`scripts/run-bench --local polar-bu-074` unchanged on both source snapshots and
retain the task/hash, service binding, original artifacts and durable FE links.
One causal replay cannot substitute for that outcome. After the exemplar,
prove every R1 member task (095,092,079,074,084,086,072,060,063) at the parent's
required copy counts; BU-074 has an unfixed pass, so at least three proof copies
are required by descent policy. Final acceptance remains the original full
slice at k3, with R2 separate. No paid cloud launch or deploy was performed.

## Human feedback

The user required exact --ai-- title verification, source 0c96ea5a8, original
Polar task preservation, surviving evidence and local deterministic work first,
no paid cloud benchmarks or deploy, a row-tagged pushed result and parent handoff.
The parent requested evaluation of a genuine browser-substrate adapter beyond
an open provider-only case, and required precise missing capability if no
implementation is grounded. Freedom and all shared resources were preserved.
The launch owner reported all 30 fleets teardown-verified and no A primaries
remaining; R1 did not perform cleanup or independently query provider inventory.

## Reusable lesson

Correlate provider warnings through their successful fallback and bind a browser benchmark to its intended execution surface before attributing an absent browser trajectory to quota.
