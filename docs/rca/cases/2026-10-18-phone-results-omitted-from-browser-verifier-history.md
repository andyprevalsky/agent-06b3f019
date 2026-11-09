---
id: 2026-10-18-phone-results-omitted-from-browser-verifier-history
date: 2026-10-18
title: Successful cloud phone receipts never reached browser completion verification
surface: agents
component: spawn-browser-agent-v3 / phone completion history
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "Phone early dispatch returned its real result without recording it in ActionHistory, which completion verification consumes"
symptoms:
  - Successful Settings launch, OCR and release followed by a verifier score of zero
  - Six recorded actor actions ended with a misleading Max iterations (250) reached error
tags:
  - phone
  - browser
  - verifier
  - action-history
sources:
  - benchmark run phone-connectivity-20261018t2006 at checkpoint 33bf65449502dd377dec57f576f8590bdb091d71
  - agent d593a517-5faf-4b5f-9805-23629fe48d1d
  - memory: .context/phone-harness/rca-phone-failing-verifier-request.json
  - memory: .context/phone-harness/rca-phone-persisted-messages.jsonl
  - benchmark run 75a7f70a-71c5-4929-87d9-6e772ae450d7
  - agent b53db629-4b68-4d7a-b763-1777d3b15f45
  - commit 379cd490cf75ec87fa4cfbbc179f0222c429ee8d
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_phone_live_completion_records_real_results_for_existing_verifier
status: fixed
---

## Problem

Browser task `17e3b8b8-9f14-5b79-9e08-872dca8aaca5` successfully launched
Settings at 20:09:54 UTC, read the actual heading `Paired Computers` at
20:10:00 and released its phone at 20:10:06. Its actor transcript contained
the successful durable operation receipts. Completion verification nevertheless
rejected the attempt, and the activity eventually reported an iteration-limit
error despite only six recorded actions.

## Diagnosis

The first verifier request at 20:10:11 (`b99a2501`, saved dump
`1792354211028-5a8f0dcb5e37-verifier_browser.json`) contained marketing-page
DOM/screenshot and an action history with **zero actions**. Its actual response
scored zero and explicitly reported missing phone launch, OCR and release
evidence. This was a correct rejection of its incomplete input, not evidence
that the provider actions failed or that 250 actions ran.

`service_actions.execute_action` dispatches phone before DOM/session checks.
Unlike normal DOM implementations, that branch did not record its result in
`ActionHistory`. The actor transcript and verifier input therefore disagreed.
The captured actor sequence was launch/read/release/attempt/status/attempt;
the fifth action was status, not a second release. Later prose-only responses
failed JSON normalization five times; the existing loop exit then emitted its
generic max-iterations label. That downstream recovery/terminal policy is not
changed by this fix.

Archive searches covered normalization/max-iterations, missing verifier action
history and phone history. The July 24 tool-argument/transport-handler case
explains a related misleading terminal label but has a different first boundary.
The September 29 payment approved-request omission is the closest relative:
another early-return path preserved actor evidence while losing verifier history.
The September 30 coordinate-history case also concerns lossy reconstruction.
This case records the distinct phone dispatch path and its exact live request.

## Reproduction

The new owning test invokes the actual activity-local execution wrapper and
existing `build_browser_verifier_context`, replaying the six captured decisions
with their real receipt shapes. The unchanged test failed before the fix with
`AssertionError: successful phone launch lost before completion verifier`.
Evidence: `.context/phone-harness/rca-phone-history-before.log`; its green rerun
is `rca-phone-history-after.log` in the same directory.

A second registered test replays the complete captured request and frozen
rejecting response through the existing RoseClient Foundry transport, offline.
It preserves pool rose-1-ultra, model gpt-6-sol, response schema, temperature
0.3, 16000 tokens, 180s deadline, 60s TTFT, 90s idle and xhigh effort.
The frozen response still scores zero; no synthetic passing judgment is supplied.
The full local artifact includes the original unrelated screenshot and was
replayed separately. The permanent test always uses a fixed reduced fixture
with the zero-history rejection; its behavior never depends on private files.

## Solution

The activity-local wrapper now records each actual phone result in the existing
ActionHistory after normal result redaction, masking private parameters and
thinking with the same reference maps. Completion verification and encrypted
resume history receive canonical tool evidence. Browser-only execution is
unchanged. No prompt, verifier threshold, task definition, output criterion,
timeout, model configuration or recovery/terminal policy changes were made.

Reference implementations inspected: Claude Code `src/query.ts` preserves
tool-use/result pairing; Codex `core/src/tools/parallel.rs` records completed
tool output; Hermes `run_agent.py` preserves paired canonical history; OpenClaw
`embedded-agent-tool-result-preparation.ts` prepares redacted native results.
The applicable invariant is to preserve real tool results under redaction before
downstream consumers, rather than fabricate evidence or relax verification.

## Verification

From `agents`, with `source venv/bin/activate` and `PYTHONPATH=.:tests/blackbox`,
the same runpy invocation of the new boundary test failed before and passed after.
The exact-client offline replay also passed. Logs are under
`.context/phone-harness/rca-phone-*.log`.

Normal command: `python scripts/run_blackbox_tests.py spawn-browser-agent-v3 rose-browser-use browser-credentials httpx-capture`.
All four suites passed, zero failed: 755 spawn-browser, 101 Rose browser,
45 credentials and 8 transport privacy checks (909 total). The final rerun after
the private-value assertion and exact replay configuration passed in 86.5s;
log: `.context/phone-harness/rca-phone-normal-validation-final.log`.
The earlier full run also passed in 87.2s and remains saved as
`rca-phone-normal-validation.log`. Python compilation, diff whitespace and
RCA archive validation passed. No live stack or provider was called, restarted
or mutated.

At 10k agents this adds one existing bounded history entry per phone action,
not a polling task, database query, global map or per-user fan-in.
The unchanged canonical benchmark rerun and live completion judgment remain
parent-owned gates; this case stays open until that evidence exists.

## Unchanged canonical outcome verification — 2026-10-18

The prior OPEN handoff statements above describe the evidence available then;
the unchanged native outcome gate is now closed. Parent ran the normal command
`bash scripts/run-bench --local browser-cloud-iphone-settings --run-id phone-connectivity-20261018t2042-r2 --no-dashboard`
at checkpoint `379cd490cf75ec87fa4cfbbc179f0222c429ee8d`. Its native controller
exited 0. Native run
`agents/benchmarks/runs/20261018_204540_75a7f70a-71c5-4929-87d9-6e772ae450d7_browser-cloud-iphone-settings.json`
records **PASSED**, COMPLETED, score 1, 177.3 seconds, 51 messages, and no failure.
The FINISHED canonical completion card reports typed `visible_heading` =
`Paired Computers`; the strict persisted launch/OCR/heading and no-attention
checks passed. This is actual Rose/cloud-phone evidence, not a replay verdict.

Original trigger: `2026-10-18T20:06:57.416731+00:00`; third-attempt trigger:
`2026-10-18T20:41:34.224899+00:00`. Hub:
`75a7f70a-71c5-4929-87d9-6e772ae450d7`; root:
`b53db629-4b68-4d7a-b763-1777d3b15f45`. The original ERROR and second FAIL
remain failures; the third PASS does not rewrite either. The original
controller's finalizer lost its native completed run/ledger row. A source-tagged
ERROR row was appended to `history/task_attempts.jsonl`, preserving every prior
byte. Its 457-second duration is explicitly the rounded original report display,
not an invented exact tenth; timestamp comes from the original local Hub run.
No token counts were inferred. Backfill provenance:
`.context/phone-harness/goal4-close-history-backfill.json`.

`tasks.py` does not exist in this benchmark package; the authoritative
`agents/benchmarks/tasks.json` is byte-identical from `33bf65449502dd377dec57f576f8590bdb091d71`
through `379cd490cf75ec87fa4cfbbc179f0222c429ee8d`, SHA256
`711a7f0f0e05db71042792751fbb7e1ad3c347285a943d0789a7cf93059363b8`.
All six recorded runtime hashes in
`.context/phone-harness/live-connectivity-retry2-slice.json` match both the pass
checkpoint and closure-time checkout. Verification receipt:
`.context/phone-harness/goal4-close-frozen-proof.json`. These are bug fixes under
unchanged task criteria, not a claim that all runtime files match the buggy revision.

Parent's retry log records cleanup `started=2 completed=2 state=clean`.
Both task and local-stack receipts are clean, and local-benchmark-owner state is
`cleanup_verified`. No resource stop acknowledgment substitutes for this proof.
The real canonical publisher completed; fresh-browser FE verification saw all
51 messages and retained browser termination/recording checks. The rendered dump
was published to HTTPS and its recorded readback returned 200. Exact verified
share/HTTPS links and canonical HTML are retained in
`/opt/cursor/artifacts/rca_evidence/b53db629-4b68-4d7a-b763-1777d3b15f45/manifest.json`;
publication log: `.context/phone-harness/live-pass-publication.log`.
Independent closure readback also returned HTTP 200 for the 39,048-byte HTML;
`.context/phone-harness/goal4-close-outcome-proof.json` records its hash, native
PASS/FAIL hashes and three preserved attempt rows without copying signed URLs.
The second attempt's separately published FAIL remains unchanged.

This closure ran no additional paid benchmark, live phone operation, deploy,
commit or process intervention. Goal 5 frontend work is independent of this
Goal 4 proof; it is not included in this result.

The recorded owning-boundary red/green, exact captured Foundry replay and
909-check normal regression run remain intact. The real native completion now
supplies the previously missing unchanged-task outcome; no frozen rejection
was relabeled as a passing model judgment.

## Human feedback

The parent required a captured-request replay and prohibited prompt nudges,
verifier suppression, criterion changes and live-stack intervention. All remain
preserved. The original live run is not claimed as passing.

## Reusable lesson

Early tool dispatch must preserve the same redacted result contract as normal
execution. A successful actor transcript does not prove that a separate verifier
received that evidence; inspect the exact first rejecting request.
