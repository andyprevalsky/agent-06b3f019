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
