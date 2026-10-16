---
id: 2026-10-16-auth-handoff-preconditions-not-independently-verified
date: 2026-10-16
title: Structurally valid auth assessment could commit an unsupported human handoff
surface: agents
component: spawn-browser-agent-v3-auth-handoff
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: handler committed structurally valid authentication assistance without independently verifying its semantic preconditions
symptoms:
  - user_only_verification
  - accepted challenge
  - Minted identity is not Andy's membership
  - authentication_handoff_unverified
  - authentication_handoff_page_changed
tags:
  - browser-auth
  - handoff-preconditions
  - semantic-verification
  - retained-native-proof
sources:
  - commit 598de7d9ef5d041b6016b7683cead4143b90138e
  - commit f9f2394b71b0ff4273955372f5fbf1da41a690fb
  - commit df413f358b038f58475f6cceb37ff8ff18255563
  - commit f27a20070f7f74f343959760bd54bb1c0119c3ff
  - agent 3c2cf2a6-5d71-4ae4-b3c1-0b8e8dcb3c78
  - agent 8946aed5-52f0-4bc9-ab43-fdbad862e671
  - agent c328777e-fa1d-4fd7-b633-5afed577f965
  - fleet run ecaaeab4-a3e4-49a9-ac00-434372b75f5f
repro: agents/tests/blackbox/auth_handoff_verification.blackbox.py; scripts/run-bench --local browser-auth-minted-sms-otp browser-auth-minted-signup
status: open
---

## Problem

Structural accounting can establish that an assessment mentions the current supplied recipients and cites existing observations; it cannot establish that the assessment's identity or accepted-challenge claims are true. Earlier retained outputs classified supplied agent contacts not_applicable on the rationale that a personal phone's generic code page was an accepted account challenge. The actual task permits browser-session or minted agent identity authentication. A conditional anti-enumeration page is not positive registration evidence. There is no hidden membership predicate available to the browser controller, and no identity is entitled to selection solely because it is supplied.

This case records a locally proven missing control boundary and a bounded native outcome correction. It remains OPEN for the pending full30 regression and broader semantic/class verification; it is not deployment approval, a model-intelligence limitation, or a universal handoff policy proof. Original failures remain retained and unwaived.

## Diagnosis

Critical path: fresh browser observation and supplied auth inventory -> planner's proposed assistance assessment -> per-recipient structural validation -> independent handoff-precondition judge -> rejection feedback/ordinary planner continuation or verified user handoff. On598 the independent judge stage was absent. The actor's own semantically unsupported rationale could therefore commit a consequential control transfer despite valid structural fields.

What: premature user assistance could stop automation on an unsupported accepted-account claim. Where: handler.py assistance commit after auth_assistance_assessment_result returned None. Why: receipt validity and per-recipient accounting were being used without an independent check of the transfer's preconditions. Proof: the registered actual-activity control failed before the new judge and passed unchanged when rejection returned the ordinary next turn; the final native trace exercises this rejection/continuation mechanism with a real judge. Problem: consequential transfer claims were not independently verified against observed state and the original goal.

Archive searches executed: authentication handoff preconditions conditional verification; supplied recipient receipt registration user_only_verification. The original SMS account-lookup and signup delegated-contact cases are retained OPEN and updated with bounded new outcomes. The October14 rewound-pending-verification case is a relative: it forced a valid pending app flow backwards, whereas this case concerns unsupported reasons for stopping automation. Receipt observation loss and supplied-identity provenance are separate owning boundaries; neither alone explains the semantic handoff.

Step5a: structural schema validity does not imply semantic precondition truth; the controller owns whether a proposed transfer commits. The deeper coherent class is independent verification of consequential control-transfer preconditions, including unsupported identity exclusions and unsupported claims that user-only action is necessary. This auth implementation is a bounded instance, not completion of every terminal/pause path.

Step5b remains OPEN at that broader coherent class. No failed next-deeper rung is fabricated and no all-class prompt-completion claim is made. There is no evidence for a model capability limitation: planner and real judges use Sol Foundry, with no original-versus-upgraded-model controlled comparison.

## Solution

The runtime candidate reuses canonical check_progress, its model/timeout/cache/recording-lineage/usage path, and a separate handoff-precondition verification goal. The original browser goal remains evidence; no completion output schema is imposed on a handoff decision. Current DOM/screenshot, bounded actual action history and real auth inventory accompany the actor's explicitly untrusted assessment. Rejecting the transfer returns factual verifier feedback through normal tool history; it does not automatically choose an identity, submit a form, reset the page, fabricate account registration, or inspect hidden fixture membership. The ordinary250 iteration budget remains.

Review found two prototype admission defects. f9 accepted synthetic Fast Mode score1 without a real verdict; the final gate rejects fast-mode-soft-complete provenance and boolean scores while preserving genuine cached verdicts. f9 also paired fresh observation with stale URL/inventory; final code rejects a changed URL before invoking the judge and returns ordinary reassessment. These are controls, not DOM phrase classifiers. At10k agents a proposed eligible auth handoff incurs one ordinary verifier activity path with its existing retries and usage accounting; no new shared poller or account database is added. There is a real additional model-cost/latency surface, not a free check.

### Local owning proof retained, not rerun by this documentation task

Worker command, cwd agents:
`PYTHONDONTWRITEBYTECODE=1 /home/boxes/rose-auth-action-receipts-review/agents/venv/bin/python scripts/run_blackbox_tests.py auth-handoff-verification`

Original boundary:0passed/3failed -> prototype3passed/0failed. With both admission controls added unchanged, f9:3passed/2failed -> final:5passed/0failed. Actual browser activity executes; scripted judge results demonstrate target/context/history/budget routing only, not semantic model competence. Named-account/app/locked/unreadable scripted positives do not prove those native tasks passed.

Retained logs: /home/boxes/rose-auth-semantic-handoff-598/.context/semantic-handoff/before-admission-controls.log and after-admission-controls.log. The full owning browser domain passed95.4s on05b3d4cdaf5ef9144770033accfc29ba5ff4bac7, whose runtime is byte-identical to f27; test-only fixture migrations preserve all2924 original assertion ASTs/multiplicities. It recorded five denied connection attempts and zero completed connections, not zero attempts. The retained final-owning/README.md and final-result.json distinguish interrupted/failed earlier attempts. None of these offline checks substitutes for native task outcomes.

### Exact unchanged native before/after

Both canonical launches selected browser-auth-minted-sms-otp and browser-auth-minted-signup at max-concurrency5.598 used base56030/run auth-repair-receipts-20261016-1849; f27 used base56050/run auth-repair-handoff-20261016-1913. These are isolated resources, not task/evaluator changes. Both launch receipts record catalog SHA2560a25df4d4bfb26e344f2067ba6e4dc74d903f40d9035233c79031605c9259acc. Direct Git diff598..f27 changes only the handoff runtime and owning tests, with no task, evaluator, fixture, timeout or benchmark pass-criteria changes.

- 598 SMS root3c2cf2a6-5d71-4ae4-b3c1-0b8e8dcb3c78: native FAIL615.4s. Paired signup7004eba8-307c-4d72-b988-082badc8ceb0: PASS222.3s; controller exit1.
- f27 SMS root8946aed5-52f0-4bc9-ab43-fdbad862e671: native PASS360.8s. Signupc328777e-fa1d-4fd7-b633-5afed577f965: native PASS125.7s; controller exit0. Native task clocks sum486.5s; controller wall603.584s. These clocks are not interchangeable and include fixture/orchestration semantics.

The f27 SMS trace initially still enters a phone different from the rendered supplied phone; this is provenance, not an identity-correctness grade. The independent handoff dump1792178274831-ebc6a79cce73-verifier_browser_auth_handoff.json returns score0.5 with output.actual_model gpt-6-sol-foundry, rejecting unsupported conditional-page handoff. Ordinary planner continuation then enters the supplied minted phone at step19. At step22 its six-digit input matches an actual injected SMS USER message (retained-otp-input-correspondence.json boolean comparison); no literal contact or OTP is archived here. Completion verifier1792178362014-8f98bf73201a-verifier_browser.json returns1.0 on the same Sol Foundry model, followed by genuine native PASS. This supports the intended runtime mechanism in this run, not deterministic attribution of every improvement to one prompt token or universal registration truth.

Retained artifacts: /home/boxes/rose/.context/auth-deploy/repair-native-receipts-20261016-1849 and /home/boxes/rose/.context/auth-deploy/repair-native-handoff-20261016-1913. Keep launch/controller receipts, original logs, pending snapshots, input-provenance/sequence/OTP-correspondence records, first-live-handoff-review.json and final owned-cleanup-export-proof.json. Earlier pending fields are historical capture-time states; they are not edited to replace final results. Preserve earlier negative diagnostic factors under repair-call-comparison and preceding native attempts rather than relabeling them successful. The four-call immediate-parent factor was dropped; prior extra-SMS-wording factors are not proved repairs.

### Native cleanup and durable publication

The final canonical receipts record benchmark cleanup clean, stack cleanup clean, controller exit0, exact owned process IDs absent and ports56050/56051/56052 absent. Provider-root cleanup proof is the canonical CLI's root verification lines, not a new independent provider GET audit. The genuine CLI bundle export is retained with SHA256 in owned-cleanup-export-proof.json. No cleanup token or credential is copied into this case.

Canonical publication exit0 for both roots; fresh FE verification and HTTPS standalone HTTP200/content-hash equality were retained in publication/final-verification.json, with no benchmark rerun/model calls by publication. Standalone hashes: SMS9d5f4f4479c154de09e291f469503985193bb8d9a44b2aaebd07f8a4bcb5439c; signup7a0f1aa3324657734e10e755ae4b70e087d2635d1eaeb4edc205adc71e8c8602. Signed/private dump URLs remain in private manifests, not source docs. Verified durable viewers:
https://www.roselabs.ai/?agent-id=8946aed5-52f0-4bc9-ab43-fdbad862e671
https://www.roselabs.ai/?agent-id=c328777e-fa1d-4fd7-b633-5afed577f965

### Remaining boundaries

Full30 auth regression was NOT RUN at the paired f27 checkpoint. Root subsequently reports it RUNNING on exactf0fe35fbb9ccbbb426fdbc49d46b36d0454c26f2, with final result PENDING; no implied waiver or regression pass. Root retains runtime-equivalence proof9047equal entries and seven test/history-only differences in repair-final-freeze-20261016/tree-equivalence.json. Trigger19:26:46.626859UTC, group0d05e7c4-df68-4ef3-bb48-f4c8d9b07be7; retained artifacts repair-native-full30-20261016-1927. This documentation task did not poll or execute that run. No deployment is approved or performed. One before/after native pair does not establish repeated-run reliability or every named-account/app/lockout/unreadable flow. Semantic verdicts remain model judgments; observed URL/title is not site acceptance. Valid account restrictions must remain respected and no alternative identity is automatically forced. Generic planner OTP capability text is absent from the handoff packet, but this actual judge correctly rejected the premature handoff; packet difference alone does not justify another capability patch or prove causality.

Golden references previously opened for the runtime investigation: Codex request_user_input.rs87 awaits user input; Claude Code AskUserQuestionTool/prompt.ts32 supports execution-time questions; OpenClaw docs/tools/browser-login.md11 preserves manual login/session control; Hermes tools/browser_tool_lifecycle.py162 retains the session lifecycle. No inspected reference implements this exact semantic handoff judge; this candidate reuses Rose's existing verifier rather than claiming reference consensus on an oracle. Independent read-only reviews found/corrected the two admission defects and then scoped-accepted df413 production; broader outcome/class review remains bounded as stated.

## Human feedback

The user required fixing the failures without a gate waiver, preserving Freedom, retaining every original failure, and doing prompt/context engineering and verification without another approval pause. Approval is required only at deployment after passing proof. They rejected hidden fixture membership oracles, forced alternate identity, hardcoded DOM phrase classifiers, fabricated task grants, model-upgrade claims without comparison, and calling scripted judge plumbing native repair. Root owns live run outcomes, cleanup and publication; this follow-through edits docs/index only and makes no model/API/DB/inbox/site/provider call or new test run beyond archive validation.

## Reusable lesson

Verify consequential handoff preconditions independently of the actor's assessment, while preserving observed progress, legitimate account restrictions and exact native outcome evidence.
