---
id: 2026-10-27-cutover-fixture-omitted-schema-persistence
date: 2026-10-27
title: Cutover fixtures completed delegated tools but omitted the root schema persistence contract
surface: agents
component: workflow-blackbox-cutover
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: mock_set_response_schema and mock_fetch_agent_config never persist or return the opted-in root response contract, so native completion polls a permanently null schema
symptoms:
  - "wf_cutover_drained_browser_resumes_same_step_on_new_generation"
  - "wf_cutover_background_browser_resumes_in_background_and_notifies_once"
  - "TimeoutError after successful resumed browser verification"
  - "expected one LLM turn per generation (spawn, then complete)"
tags:
  - workflow
  - cutover
  - schema-persistence
  - test-fixture
sources:
  - commit 807dedd8ff0495d9f89699d1f1ed50be2d8e46a0
  - plan:.context/deploy-fresh-20261027/rca-workflow-cutover/REPORT.md
  - plan:.context/deploy-fresh-20261027/rca-workflow-cutover/REPORT-extension.md
  - plan:.context/deploy-fresh-20261027/workflow-v4-peer-review/REPORT.md
  - commit 4c118e0de38c3a0c3f3b1dd93d3b30d89d099608
  - plan:.context/deploy-fresh-20261027/rca-workflow-terminal-batch12/recurrence-940d/REPORT.md
repro: agents/tests/blackbox/workflow.blackbox.py::_run_parked_tool_cutover_tests
status: open
---

## Problem

Two browser cutover cases failed in full agents coverage. The reporter retained only str(exception), which is blank for both TimeoutError and a bare AssertionError. The foreground case was reproduced natively as a 60-second result timeout. The historical background exception remains untyped and unreproduced; passing a later background control does not prove its cause.

## Diagnosis

The native foreground history records two correctly owned browser calls on old/new generations, preserving the task, session, tool and step7. Its resumed result and100% verification are present. Completion then repeatedly fetches a null response_schema with one-second timers until the unchanged caller deadline expires. The generic fixture generator and persistence mocks never establish a schema. The same native four-case group also reproduced that completion wait for the code-agent case, while approval and background passed.

A schema-only candidate was rejected: unconditional verifier success caused automatic completion after the delegated result and skipped the fixture's explicitly required second-generation model turn. Three original assertions failed. The final correction models both parts of this specific scenario: generated schema is persisted and fetched, and the opted-in verifier rejects synthetic completion until the scripted model reply actually requests completion. This exercises an existing native rejected-autoattempt path; it is not a production requirement that every completed child needs another model turn.

The earlier woken fixture case concerns an invalid completion tool envelope. The October25 schema-unknown startup case concerns a failed configuration read. Both are related surfaces, not this missing fixture persistence boundary. Their Solution and Human feedback sections were reviewed.

## Solution

Only four cutover fixtures opt in. They retain an absent schema before generation, persist the declared delegated output contract, expose it through the existing config mock, and record the actual scripted completion request. The verifier's phase score remains unchanged for all other scenarios. Six new checks verify original goal generation and schema continuity; all1242 original assertions and all eight original result/poll/sleep expressions remain unchanged. All per-agent captures and workflow pointers are removed in finally.

Exact proposed source SHA256745c01167abc4e7c3ea96337332dd86209aca1ca3f699705e0849ce867cbe12b passed4/4 native cutover cases in123.565s. The preceding wider-marker candidate also passed4/4 but was rejected by the explicit nonopted-script scope control; final V4 passes it. Independent exact-byte review conditionally approves fixture scope. The initial red and final green use the same native owner and acceptance; their diagnostic wrapper history serialization differed, so they are not advertised as byte-identical wrappers.

Root applied the reviewed final correction. Full workflow and combined source acceptance remain pending. The original background failure remains OPEN. The native workflow reporter now prints exception type and the retained traceback for failed Temporal cases, preserving the owning line even when str(exception) is blank; failure acceptance is unchanged. More history capture remains available in the private observer if needed. No production workflow, model, prompt, deadline or financial behavior changed.

## Human feedback

None recorded for this failure. Repository and coordinator requirements preserve the original assertions and reject timeout widening or an unexplained retry-green claim.

## Reusable lesson

Model the fixture's persisted output contract and intended completion phase explicitly while retaining every generation, custody and once-only acceptance assertion.


## Batch6 recurrence — unresolved completion wait

On04333dbb the full foreground case again exceeded its unchanged60-second handle.result wait, now with a typed traceback at line2063. Background, approval and code siblings passed. Replayed verifier100 does not prove accepted completion or a terminal workflow event. Neither absent completion INFO logs (also absent for passing siblings) nor cancellation after timeout identifies causal direction. The prior null-schema diagnosis is not established for this recurrence.

Current foreground alone passes47.767s; the original pure/async and13 Temporal-case prefix followed by foreground passes148.874s. These observations reproduce neither the surrounding concurrent failure nor a repair. Source-backed pre-cleanup capture is being reviewed to preserve immutable fixture state and bounded pinned-run activity/terminal metadata before cancellation and map clearing. The cause remains OPEN; no clock, model, acceptance or production workflow change is proposed.


## Reviewed next-occurrence capture

The unbounded initial capture proposal was rejected because its mutable references could overwrite failure state after awaited RPCs, and whole history JSON lacked a byte cap. The replacement writes an immutable failure projection once, then a separately timestamped pinned-run receipt. It limits failure/remote files to65536/32768 UTF8bytes, lists/strings/nodes before encoding, scans at most1024 event metadata records with page size64 and keeps at most256, trims oldest metadata to fit while recording dropped counts, and omits protobuf payloads. Unique directories are0700 and exclusive files0600. It records incomplete tails and gaps explicitly. The five-second asynchronous RPC budget does not claim a whole-helper I/O or cancellation-drain bound.

Ten focused fake-handle controls preserve the original failure and cleanup despite disabled capture, mutation during await, RPC/cancellation/write errors, large inputs and byte caps. A root-owned local Temporal toy-workflow qualification verified real running and completed describe/pinned-handle/CLOSE_EVENT APIs, recording status1 with no close event and status2 with WorkflowExecutionCompleted. Native SDK receipt is `.context/deploy-fresh-20261027/workflow-observer-amended/sdk-qualification.json`. This validates diagnostic compatibility, not the foreground cause or full workflow acceptance. Capture is opt-in and occurs only after the original case fails, before cancellation/map clearing; acceptance remains unchanged.

## October28 batch12 recurrence — active terminal path, cause OPEN

The new capture excludes the old missing-schema cause: both generation turns occurred, persisted schema matches, completion was requested and the script is exhausted. mark_finished completed at02:44:13.924; the next workflow task started then, only613ms before the unchanged60s client deadline. No durable close had occurred. The retained28 completed workflow tasks total26.422s, median943ms; the last10 median1049ms. This does not establish a stalled final task or a generic host-load cause.

One unchanged isolated foreground control passes19.740s with both workers uncached and every assertion intact. Its final78 event metadata records match the failure through event291; subsequent events are explicit COMPLETED tree update293, completion SMS299 and durable WorkflowExecutionCompleted305. It is baseline evidence, not a repair. The original concurrent delivery/create/replay/ack wall versus thread-CPU split remains missing. Preserve max_cached_workflows=0 and60s; no workflow correction was proposed. Full evidence and joined-process receipt: plan:.context/deploy-fresh-20261027/rca-workflow-terminal-batch12/REPORT.md.


## October28 source940d recurrence — replay import cost measured, timeout cause OPEN

The fresh940d workflow domain again failed the foreground cutover at its
unchanged60-second wait. Its other three native cutover siblings passed.
The aggregate launch omitted ROSE_CUTOVER_FAILURE_DIR, so this occurrence has
no retained remote history. Old batch12 history must not be attributed to it;
repeated run_agent logs during uncached replay are not evidence of duplicate
model calls. The cause of this full-run timeout remains OPEN.

A separate measured boundary defect was identified: importing the pure
helpers.wmh_activity_policy outside the existing activity pass-through block
executes eager helpers/__init__.py in every new sandbox, including pricing,
provider and Pydantic activity imports. Move only that immutable policy import
inside the existing block; do not add a pass-through namespace or change sandbox
restrictions. The policy module bytes, every workflow function/class AST and all
1251 prior assertions are unchanged. A new registered workflow blackbox control
uses the actual SDK prepare_workflow method, observes module execution, checks
the exact exported function, real/simulate/shadow/unknown policy outputs, and
fresh returned dictionaries.

Separate original/candidate processes each prepared ten fresh SDK sandboxes,
then executed the same registered regression. Original initialized the activity
package10/10 times and failed the guard; candidate initialized it0/10 times and
passed. Median thread CPU108.203ms became36.638ms; total guard/profile elapsed
1.324s versus0.415s. A first scratch import-path setup error and path-invalid
comparison were retained and excluded; the valid driver asserts the actual
workflow module origin after the test utility changes sys.path.

After root authorized fresh owned local Temporal servers, the unchanged native
foreground case ran once per variant, sequentially, with60s, two workers,
max_cached_workflows=0 and capture enabled. Original passed in10.930479s;
candidate passed in7.530650s. The same original completion, same-step handoff,
chip and once-only generation usage assertions passed. Both exact server PID
births were absent after join. This is a focused compatibility result; the
original passing means it does not reproduce or fix the historical60s expiry.
No repeated isolated green is labeled a timeout repair.

The two-file proposal e6dd788bc14e76205f193e7d420f2a4f4825e257fc6c0aab407ba8b5e4a5aea9
was reviewed and applied in4c118e0d. Native commands, source and log hashes,
invalid-attempt retention and cleanup are in the recurrence-940d REPORT.md and
native-proof.json. The4c118 full native workflow domain subsequently passed in220.664s.
The overall123-domain run remained failed at the separate config fixture.
Keep this case open until actual completion/history timing demonstrates the
60-second cause and the unchanged affected outcome is verified. No new human
feedback was recorded for this recurrence.


### Follow-up fixture dependency guard on4c118

The fresh workflow-determinism domain then failed its config identity assertion.
The actual sandbox map contained no config entry (NoneType), while config
passthrough remained declared and no dotenv module was loaded. The import
optimization removed the guard's incidental dependency; this was not a runtime
config re-import. The test now explicitly imports config inside its existing
importer.applied context before checking the unchanged identity and dotenv
assertions. No production policy changes.

All seven original assertions remain. The complete seven-case owner ran against
both test sources: original6PASS/1FAIL in2.4595s; candidate7PASS in2.3980s. A
negative that removes only config from the returned passthrough set fails the
same identity assertion in2.5136s, with6PASS/1FAIL. The candidate returns the exact
host config module; the negative returns a distinct module. Neither control
loads dotenv, which config loads lazily. All offline commands joined and no
service was started. The initial proof wrapper's summary-dict exit-decoding
mistake is retained and excluded; authoritative runs use one corrected driver.
Exact fixture proposal and native records are in
plan:.context/deploy-fresh-20261027/rca-workflow-determinism-config/FINAL.json.
This fixture correction does not change this case's OPEN timeout status.


The corrected config owner subsequently ran through the actual canonical
blackbox CLI under coverage:7PASS, process exit0, with one coverage7.16.2 branch
chunk containing350 canonical agents paths and no thin-tree aliases. Root's
explicit122-passed-domain plus fresh-owner composition, followed by the normal
214 DEMO-cache and173 unit tests and coverage report, completed0 at85percent.
The failed original aggregate remains failed. The composition is still pending
application of the exact reviewed canonical test bytes c41d3f6c8e34b708c6af63361afc7a7ded58f9fe43bded066d65f95305c1ffcd.
Receipts are in plan:.context/deploy-fresh-20261027/rca-workflow-determinism-config/native-coverage/coverage-proof.json
and plan:.context/deploy-fresh-20261027/recovery-4c118-agents/finalized/receipt.json.
Neither the passing current workflow owner nor this composition proves the
cause of the earlier60-second expiry; the case remains OPEN.

## October 29 renewed investigation — U1 attribution remains unresolved

On frozen source `eda48ae45e92a49d196de4cc6c716db52d79a006`, the renewed
investigation found no original worker delivery, replay CPU or completion
acknowledgement measurements for run `2a306988-98bb-406d-ba5d-a4f80d3e1ac7`.
Only events 122 through 291 survive. The successful `mark_finished` and the
next task start occurred 613 ms before the unchanged 60-second deadline.
Those observations exclude the earlier missing-schema explanation but do not
identify which part of execution consumed the original deadline.

A private capture proposal preserves native protobuf payloads from the same
history fetch and adds scoped worker timing. The same 305-event healthy
qualification loses 134 events in the old summary; the proposal retains all
305 with exact protobuf equality. Its two controls are registered in the
canonical workflow runner. Independent review accepts patch
`d4d09d6b084027856f8ff7bd13358383726d953248ed61a5d2f6311bb5150805`
for capture only. The 1024-event scan limit is retained, but serialization has
no byte limit and occurs outside the existing five-second RPC budget.

The proposal is not applied to canonical source. Neither that capture proof nor
the later healthy native workflow establishes the historical timeout cause or
assigns responsibility to this deploy. U1 remains OPEN. Evidence:
plan:.context/unresolved-six-20261029/workflow-chat/u1/REPORT.md.
