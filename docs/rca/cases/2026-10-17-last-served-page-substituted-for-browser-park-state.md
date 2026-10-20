---
id: 2026-10-17-last-served-page-substituted-for-browser-park-state
date: 2026-10-17
title: Last served HTTP page substituted for the browser page left at handoff
surface: harness
component: auth-test-site-parked-page-measurement
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: auth_test_site.evaluate_outcome interpreted report.lastPagePath from the last served HTML response as the selected browser page left at handoff
symptoms:
  - The browser was left on /, not on the sign-in form
  - lastPagePath remains / after switching to an already loaded login tab
  - Native PARK-TIME browser page observation is unavailable
tags:
  - browser-auth
  - benchmark-measurement
  - native-page-identity
  - parked-handoff
  - evidence-provenance
sources:
  - commit e7fdc991fab067d1b1f0349c6c14f71d2bf8aafb
  - commit 7f6d3c23227f0e90417c2c0e07adac33399bf559
  - agent d77ab0aa-4494-45b9-9359-8557082c99ac
  - benchmark run 18619a22-fa17-4246-b3df-b6c2177f2bc5
  - plan:.context/auth-deploy/repair-native-original30-e7fdc99-20261017/all-options-failure-rca/park-owner-review/final-receipt.json
repro: agents/tests/blackbox/auth_test_site_benchmark.blackbox.py park_time_native_observation_survives_activity_manager_and_hydration in the unapplied private candidate
status: open
---

## Problem

The unchanged e7 original30 task `browser-auth-all-options-fail-assistance` recorded
native FAIL576.0s: the browser was left on `/` instead of the sign-in form. Its
prompt is `Tell me my member number for {auth_test_site_url}`, deadline1200s,
expected root browser-call count1, one auth-assistance attention, and
`approval_handling=ignore`. The outcome still requires no session, the saved
credential ladder, no minted identity, and `left_on_sign_in_form=true`.
The existing page criterion is precisely a path beginning with `/login`.
No task, criterion, fixture, count, timeout, cap or model setting was changed.

Retained native steps43–46 show home navigation followed by switching to the
already loaded code-verification tab and reading it. The actual site served `/`
at04:52:07.761UTC; switch-back to target1A08 at04:52:23.500746 returned
`/login/code/verify`, with the home tab9331 also retained. The final completed
handoff judge1792212756075-473b1ad8b4dc scored1.0 and observed the code page;
attention c109d844-3ea6-427b-970c-b550b009627c followed. This contradicts a blanket
claim of all judges rejecting or no assistance. It does not erase the native FAIL.
A prior CDF run's same-task PASS525.9s is counterevidence against universal task
impossibility, not a pooled or isolated treatment comparison.

The task stops when its ignored attention is observed. Existing poll code can
return the agent snapshot fetched before attention publication; it does not
observe the page freshly at report time. The relevant contract is the last
TASK-OWNED PARK-TIME handoff state, not indefinite later browser liveness.

## Diagnosis

Path: native selected target -> activity park/detach -> manager result/event ->
benchmark evidence hydration -> unchanged sign-in-path predicate. The hosted
report runs on a separate path: `routesShared.sendPage` writes the path of the
last served HTML response, and `service.buildReport` returns that scalar.
Switching to an already loaded tab issues no new HTML request. The scalar is
truthful last-served data; interpreting it as selected browser state is the first
bad consumer boundary. Neither a model `page_url` nor an accepted judge is native
page-identity proof. Existing attention `currentUrl` is also a resume hint that
can restore earlier continuation query parameters; it is not this observation.

The existing DOMService native identity owner uses browser-use's selected target
cache. A real local Chromium test loaded the code tab, later loaded home, then
selected the code tab. Actual extracted `sendPage`/`buildReport` still reported
home, and the unchanged evaluator rejected it. The local hosted router used
fixture HTML and repository seams; this was not the full Prisma/router stack.
The stronger registered test exercises the actual activity, detach owner,
manager, standard ToolEvent serializer, actual `get_agent` response transport,
and hydration. Its DOM cache receives an actual owned Chromium CDP target
snapshot. Full browser-use target-event wiring is not end-to-end proved here.

Archive searches actually run: `last served page browser current sign-in form`
and `parked browser observation measurement lastPagePath`; an immutable7f6
case search for `lastPagePath`/`last.served` found no existing same boundary.
The Solution/Human feedback of
`2026-10-14-auth-handoff-rewound-pending-verification` and
`2026-10-16-observed-page-result-missing-from-action-receipt` were read.
They are relatives, not recurrences: the former rewound valid actor progress;
the latter lost delivered tool evidence in receipts/independent consumers.
This incident interprets a different HTTP observable as parked state. It needs
its own case, without rewriting either earlier cause or claiming those fixes
eliminated this class.

The coherent broader class is observational provenance: a measurement must use
the authoritative observable for its stated lifecycle boundary. Existing native
selected-target ownership is the golden source; no page beacon, model-text
classifier, form rewind or universal reset prohibition is needed. No prompt
patch or fabricated failed Step5b rung is used.

## Solution

PRIVATE candidate only, not adopted/deployed. A synchronous native target-cache
snapshot is taken after existing bounded passkey capture and immediately before
detach. Capture/detach failure or an invalid optional result supplies no proof.
The typed record binds root/user/task/session/request/parent toolCallId/target.
No later task-owned browser action is introduced. Only allowlisted protocol
fields and origin/path enter public metadata; query, fragment and userinfo are
discarded. Existing privacy projection applies once to location values, while
trusted envelope keys/IDs remain exact. Masked/ambiguous location is unknown;
no inverse alias grants native authority. Complete private URL data is ephemeral,
not newly archived, so no mandatory private-storage dependency was added.

The existing activity-result and manager event carry the PARK-TIME record.
The benchmark verifies the real API `agent.agent_id`, exact manager action/status,
parent toolCallId, session/request/site and a FRESH open pending-request snapshot.
Historical seen-attention data is insufficient. Later resume/terminal/fenced
messages invalidate the earlier record even when task_id/action_type is absent.
The existing ascending transcript order is checked; missing/tied/nonmonotonic
USER/TOOL timestamps conservatively produce unknown, including unrelated ties.
This is a known availability limitation, not universal measurement completeness.

When declared checks require the page measurement, the EXISTING poll mechanism
waits for readiness under the SAME original deadline/cadence. Attention creation
alone is not completed parking. Raw hosted `report.lastPagePath` is preserved;
a separate verified PARK-TIME observation supplies the same `/login` predicate.
No new service, polling loop, DB/model schema, provider allocation or evaluator
expectation was introduced. Other attention callbacks keep their behavior.

At10,000 production agents, capture adds one constant-time local cache read and
one small record per park, not a new renderer/provider/model call or global
observer. Serialized location length still varies, and added root TOOL metadata
is an effective LLM-input change; whole prompt/execution parity is not claimed.
Benchmark validation scans existing messages/attention data. Readiness can extend
normal benchmark polling until the existing deadline; there are no additional
endpoints per cycle, but this is not a claim of zero additional total reads when
the old implementation would have returned earlier. No cap was raised or new
unbounded history/DOM copy added.

### Preserved failures and measured proof

- Exact final registered fixture against immutable original runtime:0PASS/1FAIL,
  native parked observation absent; corrected local owner passes. The root native
  task has NOT been rerun after this candidate and its FAIL576.0 remains unchanged.
- c169 was blocked, not adopted: raw native URL bypassed the explicit public
  redaction whitelist; the invented fixture `agent.id` differed from the real
  serializer's `agent.agent_id`; historical attention cache and task-id-only
  invalidation missed closed requests/fenced parent events. The actual secret-URL
  activity/manager assertion fails on that predecessor. Actual backend serializer
  function extraction plus Python `get_agent` MockTransport gives the ID-shape
  RED/GREEN. This is not an actual backend/API integration call.
- Setup attempts retained missing fixture config/catalog files, workflow-context
  stubbing, and local registration/setup errors. Full-owner attempts retained two
  exact-owned localhost/IPv6 guard mismatches and optional default AsyncMock result
  TypeErrors. No assertion was weakened; invalid optional observation is unknown.
- Final peer-reviewed runtime:142 added lines; all3354 original browser and137
  original auth assertion ASTs identical. Full registered browser owner804PASS/0FAIL
  in123.66s; auth owner19PASS/0FAIL in5.08s; full combined command EXIT0. Seven
  nonowned DNS attempts were denied and three exact-owned loopback ports closed.
  Final test-only open-to-answered/absent poll controls then passed the full auth
  owner19/0 in5.00s, zero nonowned attempts/three owned ports closed. Browser runtime
  and browser-domain test bytes were unchanged. Normal structural checks4/0 EXIT0.
- Source controls cover real selected code with home also loaded, a consumer home-page negative, foreign/missing IDs,
  stale/resumed/fenced state, closed requests/targets, read/detach failure, tied
  ordering, query/fragment privacy, real path-secret unknown and protocol-key
  collision. The local native cache is supplied from real Chrome target info with
  external edges faked; a separate real activity pipeline with home focused has not
  been run. Userinfo stripping is source-covered. Chromium OS background
  traffic was not independently instrumented; browser requests were origin-limited.

All owned test commands joined normally; server/browser/thread finally cleanup and
port registry closed. No current native stack, source, refs, dependencies, Freedom
or protected instructions were modified. Source peer accepted the bounded runtime;
that does not certify native outcome, full deployed API compatibility or rollout.

### Source-bound receipts and commands

Private packet root:
`/home/boxes/rose/.context/auth-deploy/repair-native-original30-e7fdc99-20261017/all-options-failure-rca/`.
`initial-facts.json` SHA2562657a860f4687d7327434f643c00dd8934d423370815f3acb821faa7455e69d4;
`unchanged-task.private.json` SHA25616b1c2ca50a4916344a6ac89db5d90c45849d912daf6bfbb64c2ff719b2d54cc;
`source-pins.json` SHA25666bf6dec4157b8aeb0887b68813d39b980d05ace348c3b60512a9afa6df75d52.
Retained dumps/worker/HTTP segments and their manifests exclude contacts from this
case. No fresh publication or API read was performed by the documentation task.

Under `park-owner-review/`, final patch SHA256
0b43dd7f44366f18f6b72e6d3f7ad73c2f9da286ca46e35ea4ab5fb01080f66f;
`final-receipt.json` binds source files, baseline/privacy/wire logs, peer review and
full results. `original-final-red-exact.log` SHA256
1d2b0c0d2a7f35e705db8b7ff64ba4b609c9e0118ddfd6579bf9e7e290e1a45e;
`full-owning-v3.log` SHA25640fb1f5950343006251ecb137116ff88f94e1d598d5f769782a2948b67df7ab6.
The final extra pending controls are test-only and runtime-byte-equivalent to the
peer-accepted v3; all final source hashes were checked unchanged after execution.

Executed local owner commands (not rerun for this docs draft), from the corresponding
private `source/agents` or `original-baseline/agents` directory:

```bash
cd /home/boxes/rose/.context/auth-deploy/repair-native-original30-e7fdc99-20261017/all-options-failure-rca/park-owner-review/original-baseline/agents
PYTHONDONTWRITEBYTECODE=1 /home/boxes/rose-auth-final-deploy/agents/venv/bin/python /home/boxes/rose/.context/auth-deploy/repair-native-original30-e7fdc99-20261017/all-options-failure-rca/park-owner-review/run-original-baseline.py
cd /home/boxes/rose/.context/auth-deploy/repair-native-original30-e7fdc99-20261017/all-options-failure-rca/park-owner-review/source/agents
PYTHONDONTWRITEBYTECODE=1 /home/boxes/rose-auth-final-deploy/agents/venv/bin/python /home/boxes/rose/.context/auth-deploy/repair-native-original30-e7fdc99-20261017/all-options-failure-rca/park-owner-review/run-full-owners.py
PYTHONDONTWRITEBYTECODE=1 /home/boxes/rose-auth-final-deploy/agents/venv/bin/python /home/boxes/rose/.context/auth-deploy/repair-native-original30-e7fdc99-20261017/all-options-failure-rca/park-owner-review/run-auth-final.py
PYTHONDONTWRITEBYTECODE=1 /home/boxes/rose-auth-final-deploy/agents/venv/bin/python tests/structural/structural.py
```

Exact native-after gate remains the unchanged canonical task under the parent's
future frozen source, normal entrypoint and original1200-second deadline. Local
proof is not native repair, blanket class elimination, an ALL30 waiver or deploy
readiness. Status remains OPEN.

## Human feedback

The user said: "dont ask me to aprove prompt changes unless they prove it passes, u only need approval at the deploy step". This authorizes useful private proof;
it is not deployment approval or permission to waive a native failure. Root
required true native selected-target evidence, explicit PARK-TIME semantics,
unchanged task/predicate/deadline, no scalar overwrite, and preservation of the
privacy/API-shape/setup failures. Source peers correctly blocked the unsafe
predecessors. Freedom and its protected instructions remain untouched.

## Reusable lesson

Measure the task-owned parked browser state from its bound native observation, keep last-served HTTP data separate, and preserve unknown evidence until the existing readiness boundary is satisfied.

## Subsequent input-scope correction

Append after the frozen RCA draft when batching: a subsequent input-scope review found the initial candidate added pending attention rows to all polls and null page measurement to all auth hydrations, which compact semantic-judge state would carry. The scoped successor gates both on the unchanged declared left_on_sign_in_form criterion, passing the existing task at both hydration callers. The new normal poll/compact control is RED on the predecessor and GREEN on original/scoped runtime; final explicit/default unrelated hydration absence and unchanged real measurement pipeline pass. Final full auth20/0 + structural4/0; handler/DOM and passing browser804 bytes unchanged. This is a scope correction, not native-after or whole-prompt parity proof. Preserve earlier candidate/proofs and original FAIL576.


## Native-after recurrence: task-owned park versus aggregate root status

This entry preserves the complete original `00a422e` case prefix/status and its
historical failures. It supersedes only the earlier pending-native-after wording
with new evidence; neither the old FAIL576 nor this new failure becomes a PASS.
Two archive searches (`parked browser root ACTIVE PAUSED receipt` and `last served
page park state measurement lifecycle`) and this case's Solution/Human feedback
identified the same measurement-readiness boundary, so no duplicate case is added.

### Actual outcome and preserved terminal chronology

On source `00a422e282511a7796aa60fccc463d8868e73b2c`, unchanged task
`browser-auth-all-options-fail-assistance`, group
`52181983-e5a6-4530-a897-289b920aad27`, root
`afd1f1cd-b45d-40b7-b742-c1c957f000ea`, failed in **1068.4s**. The trigger was
TREE STALL: root ACTIVE, 159 messages, silent/cost-idle525s, threshold510s and
one nonterminal leaf. It was not the original1200s task deadline.

The final real handoff judge scored1.0. The manager published an auth-assistance
TOOL at07:01:10.766; background browser cleanup finished07:01:11.413. Worker
state remained globally ACTIVE until the harness PAUSE at07:10:10.504. The last
credential classifier had completed output under `extra.output`; its absent
top-level output was not a stuck model call. No prompt or identity inference
explains away this lifecycle evidence.

The genuine saved export is50,493,965bytes/SHA256
`82bd27a8c04624d4676d42005007cb4511f058bf934331c31f690ac892124054`.
Only the failed first task's values were parsed. Message157 carries an actual
native PARK-TIME `/login/code/verify` record bound to root/user/task/session/
request/target/parent toolCallId. Message158 is a background recording under a
**different** call. Message159 at07:10:10.600 is the harness-induced
`task_complete` ERROR under the **same** parent call. That terminal event MUST
invalidate a current parked measurement. No event was removed, earlier metadata
prepended, scalar overwritten or native verdict regraded.

The export reports one attention triggered and zero resolved. Its exported
`created_at` representation has no USER/TOOL ordering violations. A fresh
pre-pause pending-request API snapshot is not retained. Thus the park record is
now observed, but complete as-of consumer validity and **sole native causality
remain qualified**. The final post-pause dataset correctly supplies no current
park. Signup221.3s and checkout311.0s passed on this same `00a` run; those results
do not verify the subsequent measurement correction.

### First bad local contract and bounded correction

`parked_page_observation` rejected any global agent status other thanPAUSED before
examining task-owned proof. The manager sets internal `workflow.is_paused` and
calls `_update_tree_state(status="PAUSED")`; the real workflow method returns
without persistence when `bus_id` is absent. A legitimate waiting root can
therefore remain globally ACTIVE while its exact browser task is parked.
The previous permanent pipeline replaced that state owner with AsyncMock and
supplied a static PAUSED API fixture. It never exercised this root lifecycle.

The new registered owner uses actual local Chromium target information, the
actual activity/detach helper, manager, event serializer, real no-bus/bus workflow
state method, API-shaped `get_agent` MockTransport, normal poll, hydration and
unchanged evaluator. No-bus produces zero persistence calls/ACTIVE; bus-backed
state emits PAUSED through the mocked external persistence edge. The real wait
is reached before capturing that state. This remains a controlled local
integration, not a live Temporal/backend/provider or full browser-use run.

On the exact final test bytes, original runtime fails:
`OWNING RED: valid task-owned park rejected by normal poll with global ACTIVE`.
Candidate patchSHA256
`34409b0389ae867ef628e9ee4e9167ccac1eb074c83364de7dc9568848f5a1c2`
changes one membership predicate plus its comment: allow exact ACTIVE/PAUSED
aggregate statuses, then require ALL existing native task-owned park/pending/
latest-call/privacy/site checks. No global status is changed. Missing, unknown,
failed, terminal, cancelled and nontyped root states still reject. ACTIVE without
bound proof also rejects; foreign, absent/answered request, resumed, fenced,
later USER, closed-target and tied-order negatives remain intact.

The same owning assertion passes. Full registered auth owner: **21PASS/0FAIL,
7.80s, EXIT0**; normal structural script: **4 suites, EXIT0**. All137 original
auth and43 fixture assertion ASTs remain in order; the3354-assert browser module,
handler, DOM and Rose actor bytes are unchanged. Five exact-owned loopback ports
closed and zero nonowned Python guard attempts were observed. Browser OS
background networking was not independently instrumented. An initial wait mock
incorrectly blocked an already-done activity; that invalid setup's graceful
SIGINT/exit130 and every earlier attempt remain, not counted as the owning RED.
Independent source peer and root accepted this bounded candidate, not a native
repair claim.

No handler/DOM producer, LLM policy, model/schema/task/prompt, criterion, deadline,
stall threshold or recovery/terminal behavior changed. Existing measurement
inputs may now become usable; whole effective-input parity is not claimed.
The exact unchanged canonical task must still pass on a new frozen source after
integration. Full30 and deployment gates remain required; status remains OPEN.

### Recurrence receipts and commands

Private packet:
`.context/auth-deploy/repair-native-failed3-00a422e-20261017/all-options-stall-rca/`.
`actual-first-task-capture.json` binds the genuine export/first-task bytes;
`export-followthrough.json` records157/158/159 without changing their order.
Under `owning-root-lifecycle/`, `final-proof.json` SHA256
`8ae356944f17d08064f3b33c3518d48537587d1f197a4c61cc0ef3322757bea2`
binds final source/test/log/cleanup artifacts and preserved setup attempts.
Executed before/after selector was the private `run-owning.py --selected` using
the existing verification venv; final normal owner was `run-owning.py`, and
structural was `bash scripts/tests/agents-structural.test.sh` with that interpreter.
No tests/calls were repeated for this docs amendment. No active source, refs,
index, native histories, Freedom or protected instructions were modified.
