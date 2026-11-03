---
id: 2026-10-16-observed-page-result-missing-from-action-receipt
date: 2026-10-16
title: Observed page result reached the planner but not its action receipt
surface: agents
component: browser-action-history / auth-assessment
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: execute_action enriched the delivered result after ActionHistory recorded only the earlier acknowledgement
symptoms:
  - authentication_assessment_incomplete
  - A past recipient lacks its cited input and later observation receipts.
  - An exhausted recipient option lacks its own input and later observation receipts.
  - Genuine wait current_url visible to planner but absent from cited action receipt
tags:
  - browser-auth
  - action-history
  - evidence-transport
  - sms-formatting
sources:
  - commit d03c0eed52c696e03ed34eb09d7461f789a1dfa1
  - commit c0bb24f07faa9b4aee076cbc16d0a17e3cb5734f
  - commit 598de7d9ef5d041b6016b7683cead4143b90138e
  - commit 6af4ba3ce9c89745697299c431e4249e7abf0491
  - agent 3c2cf2a6-5d71-4ae4-b3c1-0b8e8dcb3c78
  - agent 7004eba8-307c-4d72-b988-082badc8ceb0
  - commit f27a20070f7f74f343959760bd54bb1c0119c3ff
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py observed_action_result_retained_in_receipt and sms_receipts_match_presentation_only_phone_changes
status: open
---

## Problem

Historical checkpoint below is preserved. A later combined f27 native outcome is recorded in the superseding follow-through under Solution; it does not isolate this receipt patch as the sole cause.

This OPEN case records a locally demonstrated receipt mechanism and its test
follow-through, not a repaired SMS benchmark. Root's retained d03 native trace
submitted the exact same recipient at step16 and cited native waits12/19
(step19 follows that input; step12 does not).
The planner received a genuine observed current_url after a wait, but the
assessment's ActionHistory receipts retained only the earlier success
acknowledgement. The receipt validator consequently rejected genuine later
observation evidence. This is independent of whether a model's account
applicability or not_applicable explanation is semantically justified.

On frozen598, the unchanged native browser-auth-minted-sms-otp still FAILED615.4s,
root3c2cf2a6-5d71-4ae4-b3c1-0b8e8dcb3c78. The paired signup PASSED222.3s,
root7004eba8-307c-4d72-b988-082badc8ceb0. Those native outcomes are preserved;
there is no SMS outcome pass and no waiver. Neither full offline regression nor
signup success substitutes for the missing SMS outcome proof. Native cleanup and
publication remain root-owned; this metadata task made no service/API/model calls.

## Diagnosis

Critical path: native input/wait -> execute_action -> record_action stores its
initial result -> existing observed-auth-context callback reads the live page
and returns enriched result to planner -> assessment reads ActionHistory.
The two consumers saw different versions of the same action. The first bad
boundary was post-action enrichment not reaching the exact receipt, not a
provider outage or a semantic classifier deciding that an identity is registered.

A second bounded representation mismatch compared SMS recipient input literally:
the same complete digits with or without leadingplus or presentation punctuation
failed receipt correspondence. The correction does not infer country codes,
match suffixes, extract a phone from arbitrary prose, or authorize any identity.

Two actual archive searches were run with the archive CLI:
`authentication_assessment_incomplete current_url action receipt` and
`browser wait observation history phone formatting recipient`. The closest
relatives were 2026-10-14-browser-observation-lost-before-credential-classification
and 2026-09-30-normalized-coordinate-click-lost-in-browser-history; their Solution
and Human feedback were read. The former lost masked observation in backend
credential-classification persistence, while this case loses it in an in-memory
action receipt after planner delivery. The latter loses normalized coordinates
in model-turn reconstruction. Different first-bad boundaries make these relatives,
not a recurrence requiring reopening either prior fixed case. The existing OPEN
SMS account-lookup case and separate factual-identity projection46b remain
separate; neither supplies an eligibility oracle or the cause of this receipt loss.

Deepest proven owned class: a delivered result and its evidence receipt diverge
because enrichment occurs after the receipt write. Preserve one observed result
at the owning producer boundary rather than weakening receipt requirements or
inventing an observation from typing success. The repair unifies the small factual
projection rather than copying full DOM/history or adding a background reconciler.
No prompt edit is selected in this case; broader semantic applicability and any
Step5b policy climb remain outside this proven mechanism, not declared incoherent.

Golden references were read locally, without network/reclone:

- `codex/codex-rs/core/src/tools/context.rs:157` constructs FunctionCallOutput from
  call_id plus response_payload; lines599-602 similarly keep call_id and actual
  output body/success together.
- `claude-code-src/src/utils/sessionStorage.ts:4478` looks up unresolved tool uses,
  and lines4493-4505 associate tool_use.id with tool_result.tool_use_id.
- `openclaw/src/agents/embedded-agent-subscribe.handlers.tools.completion.ts:101`
  receives the actual end event; lines108-115 use that event's toolCallId and
  consume its owned send receipt.
- `hermes-agent/agent/agent_runtime_helpers.py:142` serializes trajectory tool
  responses; line161 includes the actual tool_call_id with content.

Common supported pattern: keep factual output associated with the owning call ID.
These are provenance analogs, not direct implementations of Rose's latest-entry
API, SMS normalization, receipt validator, or an account-membership policy. No
reference establishes that a supplied identity is registered at a site.

## Solution

Root correction c0bb24f07 captures the pre-dispatch latest ID, executes the existing
action and existing observation callback, and synchronously attaches only nonempty
string url/current_url/title to the newly completed latest receipt. ActionHistory
rejects a different/stale ID. The native handler awaits actions sequentially; the
actual callback prepares inventory without appending action receipts. No history
scan, extra page/provider call, full-DOM duplication or new budget is introduced.
At scale this adds a constant number of local fields per newly recorded observed
action; serialized text volume still depends on URL/title lengths.
The SMS matcher accepts only optional leadingplus and ASCII digits/space/parentheses/
dot/hyphen, then requires all digits equal and nonempty. No country/suffix guessing.

The SAME registered owning observation assertion failed on d03 before correction:
`history.get_entries()[-1]["result"].get("current_url") == result["current_url"]`.
The SAME phone assertion failed for the identical complete digits without leadingplus.
Both passed after correction. Existing controls retain foreign input, absent country
code, typing ACK/no observation, failed page observation, stale receipt ID and unknown
no-action behavior. This validates factual correspondence, not code delivery,
authentication success, rejection semantics or account eligibility.

Retained commands, run by root during mechanism proof (NOT rerun in this docs task):

```bash
cd /home/boxes/rose-auth-action-receipts-review
BASELINE=1 agents/venv/bin/python .context/receipt-review/run.py observation
agents/venv/bin/python .context/receipt-review/run.py observation
BASELINE=1 agents/venv/bin/python .context/receipt-review/run.py phone
agents/venv/bin/python .context/receipt-review/run.py phone
```

The baseline import overlay pins original dom_service/service_actions/auth_assessment
and runs the same new owning tests; it does not edit production source. Root reports
zero network attempts for selected controls; retained post-fix logs explicitly report
network_attempts0, observation0.464s and phone0.0025s. Baseline failures and the guard
script are retained; no new paid/native calls were needed for this archive entry.

Full598 canonical regression exposed four fixture API failures: browser-credentials
passed incomplete SimpleNamespace histories to real execute_action, which now uses
last_action_step. The ceremony fixture swallowed that early AttributeError before its
unchanged arming assertion. Separate test-only6af4 replaces six inline stubs with REAL
ActionHistory, preserves lower-level record_action mocks and ALL190 assertion ASTs,
and passes the same canonical browser-credentials domain (before4fails12.8s,
afterPASS12.7s). No hasattr/fallback/runtime relaxation was added. This is fixture
contract alignment, not a second production/authentication repair.

Full canonical6af4 verification subsequently exited0 in441.644s:110/110 blackbox
domains,184 fast-cache tests and134 unit tests passed. Branch-enabled coverage was
82.41155075498733% (display82), above unchanged80 threshold. Runtime/catalog/evaluator/
timeout bytes match598; ONLY browser_credentials.blackbox.py differs. Before/after
HEAD and all tracked hashes were unchanged. This does not rename native598 to6af4.
No deployment/adoption, approval flag, skip, evaluator rewrite or budget change occurred.

### Evidence receipts and preserved clocks

- Root receipt proof directory:
  `/home/boxes/rose-auth-action-receipts-review/.context/receipt-review/`:
  run.py, baseline source snapshots, before-observation-complete.log,
  before-phone.log, after-observation-complete.log and after-phone.log.
- Original d03 native evidence:
  `/home/boxes/rose/.context/auth-deploy/repair-native-uniform-20261016-1827/`,
  including receipt-gap-note.txt and retained-call; native verdict remains preserved.
- Native598 run:
  `/home/boxes/rose-auth-action-receipts-review/.context/benchmarks/auth-repair-receipts-20261016-1849/report-card.json`.
  Retained card SHA2567529b75cd5de3ef4bbfae61ed00af989776f70a8c5581a5f82082faaa1f4786d.
  Native cleanup/publication records are under
  `/home/boxes/rose/.context/auth-deploy/repair-native-receipts-20261016-1849/`.
  This docs task did not revalidate FE links or assert fresh cleanup completion.
- Test migration patch SHA2567c4286b6caeb3c629b2b1fca2ac8d9b1fb5f9f9dc3eddad9407d25f1e36654cd;
  proof/logs are `/home/boxes/rose-auth-receipt-history-tests/.context/history-test-migration/`.
- Full canonical command: `cd agents; env -u CODEX_AUTH_PATH AGENTS_COVERAGE_CONCURRENCY=2 bash scripts/run-coverage.sh`,
  with private venv activated in the actual shell, no custom socket guard/skips.
  Start2026-10-16T18:56:06.004084Z; end19:03:27.648493Z; exit0; PID673229 joined/absent.
  Full log SHA2564437df7fcf04d9bb24adf63d7df1c42c1bea7455ea703fd73478e5d3bec75c4d.
  Receipts, before/after tracked hashes and exact coverage JSON are under
  `/home/boxes/rose/.context/auth-deploy/repair-next-598/agents-6af4-coverage/`.
- Initial nonactivated598 coverage attempt joined143 after exact-owned coordinator
  cleanup; root record `/home/boxes/rose/.context/auth-deploy/repair-next-598/agents-coverage/`.
  Corrected activated598 run retained109/110 domains with four fixture failures,
  stopped before cache/unit/report, and made no coverage-percentage claim.
- Initial6af4 prep failed on an absent root-lockfile assumption; missing fail-fast
  allowed an npm attempt, then only exact owned prep/install PIDs were stopped.
  Logs remain preparation-initial-failed.log/check-initial-failed.log. Corrected
  prep/check passed with already-satisfied requirements, no installed/removed-package
  lines; private donor unchanged. These attempts are not hidden or counted as green.

Independent read-only peers found no introduced blocker in the scoped receipt
mechanism or fixture migration. They explicitly limited their findings to source/
contract review, not native SMS success. Overall status remains OPEN: the local
mechanism is demonstrated, but the exact unchanged SMS outcome still fails; the
separate semantic handoff investigation is not resolved by this case.

### Superseding native outcome follow-through (docs only)

The original598 SMS FAIL615.4s and paired signup PASS222.3s remain immutable. A later exact unchanged-task run onf27a20070f7f74f343959760bd54bb1c0119c3ff, which includes the receipt repair plus independent semantic handoff verification, recorded SMS PASS360.8s and signup PASS125.7s with controller0 and canonical exact-owned cleanup clean. Both launch receipts retain the same catalog SHA2560a25df4d4bfb26e344f2067ba6e4dc74d903f40d9035233c79031605c9259acc. No individual receipt-only native causal attribution follows.

See 2026-10-16-auth-handoff-preconditions-not-independently-verified for the actual same-Sol-Foundry handoff0.5 -> ordinary planner continuation -> supplied phone -> injected USER OTP correspondence -> completion1.0 -> native PASS chain. Raw contacts/codes are excluded. Final retained cleanup/publication artifacts are under /home/boxes/rose/.context/auth-deploy/repair-native-handoff-20261016-1913, including publication/final-verification.json with fresh FE and HTTPS standalone verification for both terminal roots. No external verification was rerun by this documentation task.

This receipt mechanism remains locally proven; the combined native outcome no longer lacks an SMS pass, but full30 regression was not run at that checkpoint and is now root-reported RUNNING/result PENDING; broader causal/class verification remains OPEN, without waiver or deployment approval. Original interrupted/setup/test attempts and prior failure receipts remain retained. This imports the pending docs-onlyfa6e56b0d6a4f2352b43aaa4aff051e1a3d70f3b case without changing its runtime/test source.

## Human feedback

The user required proof before prompt approval and approval only at deploy:
"dont ask me to aprove prompt changes unless they prove it passes, u only need approval at the deploy step".
This is not deployment approval or permission to waive failing native outcomes.
The user required separate private worktrees, immutable original failures/clocks,
actual same-boundary fail/pass, full canonical regression and no forced identity,
provider probe, relaxed validator/evaluator/timeout or automatic source adoption.
This docs-only follow-through must not enter the active candidate automatically.
Preserve Freedom and its protected instructions/configuration; no protected file
was edited and no Freedom resource was touched.

## Reusable lesson

Bind the actual observed result to its exact owning action receipt before a downstream validator consumes it, and keep local mechanism proof separate from native task outcome proof.


## Superseding recurrence: delivered native observations at the independent consumer

The metadata-only receipt correction above did not establish that the full normalized page observation reached every decision consumer. The unchanged original f0 full-auth task `browser-auth-all-options-fail-assistance`, root 184dfdd1-ae0e-40ab-b93f-c8033e3a9ab5, recorded native FAIL1216.2s including orchestration, with the original 1200-second execution deadline and native timeout after1201s. Its evaluator observed no expected assistance request. The original SMS and signup failures have separate later passes; those passes do not erase this recurrence. The subsequent human-sign-in task also failed920.8s with PAUSED rather than expected COMPLETED; that generic terminal check does not establish its attention/USER-resume chronology.

The earliest retained actual native read call call_ch95aO7pweURD3fCsD7u4y5t delivered explicit passkey-rejection text to the planner. Its actual receipt12 already retained only success/url/title/current_url. The first judge's bounded metadata history began at24, so12 later aged out as well. A separate in-window read call call_Gpv2WydpnzG4TJDjnVFi1erX delivered the same kind of rejection observation at actual receipt32;32 remained inside the first judge's24–53 window, yet its receipt and judge metadata still omitted the observed outcome. Thus recording loss is demonstrated independently of the last30-history window. Fifteen unique retained planner TOOL observations contain explicit passkey/password-rejection text. This does not prove every saved option failed, establish membership or provider health, or isolate the complete native timeout cause. The omitted operation-policy contract is a separate observed consumer mismatch.

The same producer narrowing remains on598f2f196d5cc9c144dcdeacd38afffc05d0c7a5. The proposed general correction binds the final public `formatted_state` actually returned by the native read executor to the newly completed exact ActionHistory receipt. Existing non-read attachment eligibility is preserved. Only real native read observations become these evidence units; evaluate/extract outputs with a forged same-named field are not promoted. A failed page-coherence check withdraws its snapshot. The existing DOM policy projects values, while native envelope keys and integer receipt IDs retain their mechanical identity. No inverse secret resolver, semantic outcome label, phrase selector, account oracle or new page/provider call is introduced.

Simply placing all observed text in the single metadata-history TOOL row was measured insufficient: the retained first-judge reconstruction grew that row to about25207characters and the unchanged12000-character per-tool admission removed the explicit rejection observations. The selected representation instead keeps the existing last30 metadata rows compact and exposes each already-delivered native observation as its own step-bound TOOL evidence unit. Final page/files/payment evidence and the final raster retain admission priority. Optional historical units are considered newest first under the unchanged12000-per-tool and160000-aggregate limits; native IDs and timestamps are not relabeled. The same saturation assertion rejects chronological ordering and passes recency ordering: newest unit100 survives, oldest unit1 is excluded when the aggregate fills. Large individual units or older evidence can still be clipped; no cap, history-window setting or declared-evaluator exemption is changed, and one observation is not split to evade a per-tool cap.

The same actual executor-to-receipt-to-builder-to-privacy-to-normal-admission assertion fails on the unchanged598f2 baseline for missing delivered observation and passes locally on the candidate. Controls cover public/private values, protocol-name secret collisions, exact/foreign/stale receipts, incoherent reads, forged evaluate/model outputs, observations older than the compact metadata window, and saturation/final-evidence priority. With an in-memory fake archive and a synthetic encryption key, existing resume continuity through actual encrypted persist/hydrate, ActionHistory restore, privacy and judge admission preserves the exact public observation and integer step for inline and private-offload cases; a foreign owner is rejected. This exercises the existing code path, not real backend/archive availability. The storage implementation is unchanged. Original registered assertion ASTs/multiplicities are retained. Exact final runtime patch44ca05b6df34c8cfe0fe27db048f39176aeadc71ad38782f0ec889d6cd13b7b4 and registered-test patchde7161ada4736fe84e53eafd07c40f7004e2b6904fdc3ab937f0ac1060f006bf pass the full existing browser owning domain in110.7s, with six socket attempts denied and zero transmitted connections. Related auth-handoff14 and rose-browser98 controls pass in9.5s with zero network attempts. Source hashes remain identical through those final suites and exact launcher processes are absent. Receipts are source-bound in `.context/auth-deploy/observed-result-receipt-review/`; no native repair pass follows from these local controls.

With actual already-retained observations reconstructed through the real current builder and normal admission, both earlier receipt12 and in-window32 are admitted among23native observation units. Message text increases11702 to42115characters; an explicit o200k_base text estimate increases3724 to13817tokens. These are offline text estimates, not billed tokens, full HTTP-wire parity or changed real-model verdicts. All units keep the same source observation IDs and content. Extra observation retention duplicates some data already present in the browser turn transcript and increases memory/encrypted-archive storage; the existing resume-store offload handles large snapshots, but its availability and size limits still apply. Prompt budgets do not bound durable storage growth.

C+1 remains coherent as consistency between an actually delivered native tool result, its exact owned receipt and independently admitted decision evidence. The old URL/title-only fix addressed a narrower instance and did not eliminate the full class. The final candidate is private and unadopted at this checkpoint; earlier chronological candidate proofs are preserved and superseded for recency. Unchanged native task after-results are UNPROVEN, all original failures/clocks remain immutable, and this case stays OPEN. No failed Step5b rung, universal completeness, registration eligibility, provider failure or deployment approval is claimed.

## Superseding recurrence: native target receipt omitted by verifier formatting (2026-10-17)

Status remains OPEN. On immutable a96f02ebd680950729df2cbce8cb7da6f4ba45f5,
`browser-auth-code-never-arrives`, group95c60fbe-eef7-4092-8f74-268ae578b1e6,
root8d379100-8386-4d70-8582-6cf57e92611d, FAILED917.4s including orchestration.
The actual task deadline is900s and the native notification says timeout after905s
with no expected auth_assistance request. An earlier generic1200-second card was
inaccurate; no task definition or deadline was changed. This task does not declare
left_on_sign_in_form, so the park/global-ACTIVE measurement correction is unrelated.

The retained ten completed handoff judgments all scored0.5; the eleventh capture
contains an input but no completed output and remains UNKNOWN. All ten exact reasons
reached the next actor TOOL feedback and action history with the matching preceding
proposal toolCallId, root and browser task. Feedback loss is counterevidenced. All
eleven inputs contain the complete shared authentication contract and native page
observations. The reasons also dispute membership-linked/user-only preconditions,
guessed-route exhaustion and one apparent member-number word match; these are
semantic judgments, not all explained or repaired by the target-field omission.
Prior unchanged-task passes on other source checkpoints remain counterevidence to
universal impossibility. No0.5 admission, fabricated attention or account oracle is
introduced.

A separate mechanical loss is demonstrated at the independent consumer:
ActionHistory already retained the native step12 click's index222, coordinates and
`<button "Resend code">` descriptor at TOPLEVEL. The verifier's compact formatter
printed only params/result, omitting this attempt identity. Native step32 has the
same shape. A nearby DOM label cannot identify which control was clicked, and a
recorded click target cannot establish delivery, resend effect or registration.
The first retained judgment explicitly questioned the step12 target.

Two fresh archive searches against exact a96's937-case archive used
`Resend code click target index element_description action_history verifier` and
`native observation independent consumer receipt lost projection`. Solution and
Human feedback were reread in this case, the normalized-coordinate history case,
the humanized-click delivery case and the camelCase resend write-lock case. The
last two forbid confusing nearby labels or transport ACK with an actual effect;
no click classifier or delivery status is changed here. This is a recurrence of
this OPEN receipt-to-independent-consumer continuity class: the earlier native
read correction did not establish continuity for already-recorded interaction
target fields. It is not another missing shared-policy or feedback-retry repair.

The private candidate adds15 formatter lines: integer-step/known-action entries
may display typed native index and finite x/y mechanics plus the existing public
descriptor in a separate `Recorded target attempt (page data)` field. Existing
DOMService/ActionHistory privacy projection remains the owner; history is not
reprojected or inverted. Secret-bearing descriptions/URLs are masked, numeric
mechanics survive secret-value collisions, params conflicts remain separate, and
failed-click status remains failed. Malformed/unrecognized target records do not
gain target evidence. Page text resembling instructions remains quoted data, with
no new tool call, success label, source authority or semantic selector.

The SAME registered real ActionHistory/DOMService-privacy-to-builder assertion
fails on a96 and passes on the candidate. A second registered16-row native-shaped
fixture restores step12 and exercises real verifier admission and both actual
Anthropic and Responses body builders: the failed step's descriptor/index survive
within its own step segment, distinct from unrelated final DOM text. It fails on
the whole baseline builder and passes on the actual candidate module. A separate
private diagnostic uses the first failed handoff's actual retained16-row history,
browser_state and captured verifier system prompt through those same builders;
its goal/currentURL/file-list are synthetic, so it is not whole historical-request
parity, an HTTP transmission or a semantic grade. Browser element/coordinate lookup
in the producer fixture is mocked, not a newly executed native click.

Final patch12c09b4f09a2c96ff574a81d43e895ad2b378a3bf1d21e0e08d50cb2724f3aac
preserves all3354 old browser assertion AST occurrences and unchanged Rose441/auth137
source assertions;12 assertions are added. The exact final test SHA256 is
9cbae3892ffb8d6c007ddd646a8910a06484c78181e82ecd196f243bb6d73871, not the earlier
d571 predecessor test. The final private browser owner passes811 checks in123.1s,
12 denied network attempts and zero transmitted; related Rose99/auth15 pass with
18 denied and zero transmitted, and structural suites exit0. Source-only peer and
root scoped reviews accept the mechanism, not native efficacy. Earlier723/810 proof,
missing configuration/static-file setup attempts, corrected fixture split/status
expectations and all baseline failures are retained, not counted as final greens.

At10k-agent scale this adds local formatting of existing target text for at most
30 compact history entries per verification, no service/provider/page call or new
persistent state. Descriptor length and verification frequency determine text,
CPU and allocation cost; existing privacy registration and storage owners are
unchanged. The latest captured compact row measures39036->39315characters (+279,
two target rows). Native step12 has aged outside that later last30 window. The
unchanged12000-per-tool and160000-aggregate admission may still clip target data;
no larger cap, retention window or universal complete-wire claim is made.

Private receipts, exact commands, source copies, wire controls and final freeze
manifest are under `.context/auth-deploy/repair-native-original30-a96f02e-20261017/code-never-failure-rca/target-continuity/`.
All helper commands joined normally; no service allocation or process signal was
used, and no full OS descendant census is claimed. Actual source/index/refs/deps,
current native execution and Freedom were untouched. Original917.4s failure remains
unwaived. The selected local mechanism is proven; its causal contribution to that
native failure and unchanged-task success on a future integrated source remain
UNPROVEN. No deployment approval or class-elimination claim follows.


### Later semantic counterevidence for target-only continuity (2026-10-17)

The actual native code-never-arrives failure at917.4seconds/900-second task deadline remains unregraded. A later authorized diagnostic pair faithfully reconstructed the first captured handoff through the canonical verifier. Original and target-only12c09 inputs both returned0.5, each one fresh gpt-6-sol-foundry/foundry attempt. Both reasons already acknowledged the requested/resend path; restoring target attempt fields did not improve that judgment in this trial. All ten earlier rejection feedback strings also reached the actor, disproving a feedback-loss hypothesis. Mechanical RED/GREEN and privacy/failed-attempt semantics above remain valid, but neither is a semantic or native cure.

A separately reviewed typed-handoff goal clarification subsequently returned1.0 on the same target-only factual context with ONLY the per-call goal changed. Its coherent synthetic known-passkey negative returned0.5; a multiply-invalid incomplete-OTP negative also returned0.5 but does not isolate timing semantics. These results belong to the shared-contract decision boundary, not proof that target representation caused success. See 2026-10-16-auth-handoff-consumer-omitted-shared-otp-contract for the branch-proof recurrence, exact scope/cost/setup limits and original membership safeguards. The unchanged native after-result is still UNPROVEN; no original grade or failure was changed.

Pair proof SHA256a64b26977ce6595e86704f3879e3b4d4562668b31b4e6e96c1b4353ae8a1611d and three-case proof SHA25633555cd34d38bba6d37c245c26eedb8d614dacf0edc446ecae069d0647e99542 are retained privately under the same failed-root RCA directory. All calls, precursor stops, raw outputs and earlier frozen candidates remain immutable.
