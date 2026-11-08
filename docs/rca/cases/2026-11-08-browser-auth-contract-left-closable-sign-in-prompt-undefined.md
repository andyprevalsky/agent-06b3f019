---
id: 2026-11-08-browser-auth-contract-left-closable-sign-in-prompt-undefined
date: 2026-11-08
title: Browser agent read DoorDash's closable guest "Sign in or Sign up" modal as the auth wall and requested auth assistance before shopping, because the actor Authentication contract never said whether a closable prompt blocks the task
surface: agents
component: browser-authentication-contract
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: agents/utils/browser_auth_contract.py build_authentication_contract — the actor Authentication ladder says to exhaust guest completion (step 6) before request_user_assistance_for_authentication (step 8), but it never says whether a sign-in/sign-up prompt that has its own Close control blocks the task, or whether closing it is a login attempt. Under a delegated goal that says "STOP ... Do NOT click a login/reauth control" (or the task's own "When DoorDash requires login ... stop"), gpt-6.1-sol stops at the closable modal.
symptoms:
  - "Browser agent requested user authentication assistance"
  - "Browser agent ... recorded 3/4 trajectory step(s); expected at least 5 per browser agent"
  - "[1610]<button aria-label=Close Sign in or Sign up /> ... Sign in to access your credits and discounts"
  - "Not searched: visible Sign in or Sign up wall; user prohibits dismissal or further progress"
  - "\"guest_actions_since_wall\":\"None: login wall left open; no dismissal, login input, credentials, checkout, or order action performed.\""
tags:
  - browser-auth
  - guest-checkout
  - auth-wall
  - doordash
  - sign-in-modal
  - browser-prompt
  - descend
sources:
  - agent da6804c7-9bbc-46e3-a5fa-48e33631d9da (descend-failed-neverrun-20261106 epoch 24 r1, source d49ef3c511, fleet run 20261108-054416-3146294)
  - agent ac41b31f-d666-4dff-bcd2-924c0328f55d (same epoch r3, fleet run 20261108-054415-3146317)
  - agent c8a7d08c-86f5-483d-abcc-2b0000d522cb (epoch 22 copy, source 72889c4389, fleet run 20261108-020322-2085090; same modal, closed it at action 3)
  - fleet run 20261108-054416-3146294 (descend-launch-e24 r1)
  - fleet run 20261108-054415-3146317 (descend-launch-e24 r3)
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_dismissible_sign_in_prompt_is_not_an_authentication_blocker (contract); real-LLM exact replay of r1 dump e5f1ebae913d (browser_use_step_3) through scripts/replicate_llm_dump.py --repeat 8 --expect click:6 for causal proof
status: open
---

## Problem

`browser-doordash-food-plan-grocery-cart-reauth` asks Rose to fill a full
weekly Safeway manifest cart on DoorDash as a guest, then stop at the
checkout auth/reauth wall. In descend epoch 24 (source d49ef3c511), copies
r1 and r3 failed about 10 minutes in, before a store was chosen or any item
was added. In both, the single browser agent called
`request_user_assistance_for_authentication` (base_site doordash.com) at
browser step 3-6. The evaluator recorded "3/4 trajectory step(s); expected
at least 5 per browser agent".

The evidence is the worker log of each copy (remote-logs/runtime-evidence/logs/worker.log).
It carries every LLM input as gzip+base64 `llm.context.dumped` payloads:

- r1 (Tilion): step 1 read the guest home page, step 2 initialized a checklist
  in JS, and step 3 typed the address into input [40]. That failed with
  "Element with index 40 not found" because, between the reads, DoorDash
  opened its guest home modal (`[1602]<div role=dialog>` "Sign in or Sign
  up", iframe "Login/Signup", `[1610]<button aria-label=Close Sign in or Sign
  up>`). The next read_browser_state showed the modal with its Close button.
  The model then called attempt_completion. The browser verifier
  (verifier_browser, progress 0.5) accepted "the authentication boundary" and
  asked for a verifiable assistance report. The model then called
  request_user_assistance_for_authentication.
- r3 (moved to steel_fixed by challenge recovery after a same-origin 403):
  its first read after recovery showed the same modal with Close [1110]. Its
  evaluate recorded "login wall left open; no dismissal", it wrote a
  manifest audit with "NOT ADDED — blocked by authentication wall", and it
  called request_user_assistance_for_authentication.

The modal is not an auth wall. In epoch 22 (source 72889c4389, copy
2085090) the same modal appeared. That agent clicked "Close Sign in or Sign
up" at action 3 and shopped as a guest for about 200 actions. The other two
epoch-22 copies did not get the modal in their first 12 steps.

## Diagnosis

Critical path: task prompt → root execute_loop composes the spawn_agent
browser goal → browser actor (gpt-6.1-sol-foundry, xhigh) gets the system
prompt (Authentication contract), the goal and the page state →
request_user_assistance_for_authentication → handler raises auth_assistance
→ the benchmark fails on an empty cart.

The data is correct up to the actor. The page state shows a closable modal
with a Close button, and the task contract says "When DoorDash requires
login or reauthentication, stop". The actor's decision is the first bad
point. Held constant between e22 and e24: the system prompt (byte-identical,
8985 chars), the served model and effort (gpt-6.1-sol-foundry xhigh in every
copy), and the tools (only H-39's recover_from_challenge wording differs).
What varied was the goal the root LLM wrote. e22's goal said "A nonblocking
account invitation on a shopping page is not necessarily an auth wall". e24
r1 said "STOP ALL browser interaction immediately ... Do NOT click a
login/reauth control". e24 r3 said "Do not dismiss/bypass it to keep
shopping".

Replay proof uses the exact captured r1 call
`browser_use_step_3` (dump e5f1ebae913d), with the model, tools, xhigh effort
and messages as recorded. It ran through scripts/replicate_llm_dump.py under
`flock /var/tmp/descend-llm-replay.lock`:

1. Baseline on d49ef3c511: 0/8 click. 5 request_user_assistance_for_authentication
   and 3 attempt_completion (`EXPECTATION FAILED click: 0 < 6`, exit 2).
2. Goal reworded to the task's own sentence ("When DoorDash requires login or
   reauthentication, stop and request auth assistance. do NOT try to login. do
   NOT continue past the auth/reauth wall."): still 0/8 click (6
   request_user_assistance_for_authentication, 2 evaluate). The root's
   stricter paraphrase is therefore not the cause, and neither is H-68 (r1's
   goal was inline, with no pointer).
3. The only change is the fixed Authentication contract line, and the replayed
   system message is byte-identical to `build_browser_use_system_prompt` on the
   fixed source. Result: 8/8 `click {"index":1610}`, the modal's Close button
   (`EXPECTATION PASSED click:6`, exit 0).

r3 replays do not discriminate either way. Its first post-modal call
(28144a714978) mostly chose `screenshot` (6/8 baseline, 5/6 fixed; the other
replays failed to parse evaluate arguments). Its step-6 call (cce12fbe7f54)
already holds five turns of its own "auth wall, user prohibits dismissal"
claims. It stayed non-click with the rule (base: 5 attempt_completion, 1
auth, 2 screenshot; fixed: 3 auth, 2 attempt_completion, 3 observation). The
rule acts at the first decision; it does not undo a trajectory that has
already committed. The r3 outcome needs the exact benchmark rerun.

Step 5a ladder:
- Why 1: the actor called step 8 at a closable modal. Evidence: r1/r3 dumps
  and the replay baseline.
- Why 2: the actor's contract never says whether a closable sign-in prompt
  blocks the task, or whether closing it is a login attempt. Evidence: the
  Authentication section only says "Do not open Sign in / Log in and call
  step 8 while a guest/anonymous path remains viable". The one-line rule
  flips the identical call from 0/8 to 8/8.
- Why 3 would be "goal-composing LLMs write differently worded auth
  boundaries". Owned instruction text cannot remove that variance; the
  delegated goal comes from the root model. The fix belongs to the actor's
  shared contract, which every delegated goal inherits.

Step 5b climb (prompt edit):
- Class stopped at: the browser Authentication contract defines when to hand
  off (step 8) but not whether a closable/skippable sign-in or sign-up prompt
  blocks the task.
- Next-deeper class tried: "the agent treats any visible UI that resembles a
  goal's stop condition (auth wall, consent dialog, promo, location prompt,
  purchase confirmation) as that stop condition without testing whether it
  blocks". The fix would be a global rule: close any closable overlay and
  continue.
- Why it fails coherence: overlays are not uniformly safe to dismiss. Legal
  agreements (the prompt says NEVER sign them), purchase/write-lock and OTP
  entry dialogs, and CAPTCHA/challenge interstitials each have their own
  explicit rule. A blanket "close and continue" would contradict them.
  Whether a surface may be dismissed is a property of that surface, so the
  rule belongs on the auth ladder that owns step 8. No non-auth overlay
  misread was observed in this cluster.
- Non-prompt alternatives rejected: auto-closing sign-in modals in the
  runtime, or rejecting step 8 while a Close control is visible, are
  string-matching classifiers and trajectory interventions (CLAUDE.md
  25a/25b).

Attribution: Gate: NOT_INTRODUCED for the epoch-24 fixes (H-68 faac02ef5c,
H-70 073e33bdc6, H-71, H-72, H-39, I-36, I-37). The system prompt that
governs this decision is byte-identical to e22's, and the baseline failure
still occurs with the task's own wording. The modal appearing in both e24
copies, but in only one of three e22 copies, is site/session variance outside
our code. The modal was already present in e22.

## Solution

On branch rca/h-74-20261108, the shared actor Authentication contract
(`agents/utils/browser_auth_contract.py`, new `DISMISSIBLE_AUTH_PROMPT_RULE`
placed after the guest-first rule) adds:

"A sign-in or sign-up prompt you can close or skip does not block the task.
Closing it is not a login attempt: close it and continue as a guest.
Authentication blocks the task only when the step you need still requires
signing in after that."

This is LLM-visible prompt text, so it needs golden review or approval
before deploy. It also covers sibling cases: any site that shows a closable
sign-in, sign-up or "save with an account" modal to guests (DoorDash home,
OpenTable/retail account invitations) under a delegated goal that forbids
login. A forced login (no close, or a step that still demands sign-in) still
reaches step 8 unchanged. 10k-agent behavior: constant prompt text, no added
calls, state or fan-in.

Regression: `test_dismissible_sign_in_prompt_is_not_an_authentication_blocker`
in agents/tests/blackbox/rose_browser_use.blackbox.py, registered in its
run_all_tests (rose-browser-use domain). It fails on d49ef3c511 ("actor
Authentication contract missing dismissible-prompt rule") and passes on the
fix (5/5). `test_phone_off_matches_prephone_bytes` was re-pinned. Only the
system/messages hashes changed, in both recovery modes; the tools hashes are
unchanged. The rose-browser-use (125 passed) and prompt-invariants suites
pass.

Golden reference: none found. Searched hermes-agent/tools/browser_tool.py
(:578 screenshot description, :686 CAPTCHA keywords only), openclaw/skills
(no browser auth-wall guidance) and claude-code-src (no browser actor). No
reference harness defines optional versus blocking sign-in prompts.

Outcome proof is pending: the exact unchanged benchmark still has to be
rerun on the fix, so the status stays open.

## Human feedback

None recorded.

## Reusable lesson

When a browser agent hands off authentication at a sign-in prompt that has its own close control, check whether the actor's auth contract defines when a prompt blocks the task before blaming the site or the model; delegated goals vary, so the contract must carry that definition.
