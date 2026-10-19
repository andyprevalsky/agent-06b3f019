---
id: 2026-10-14-auth-handoff-rewound-pending-verification
date: 2026-10-14
title: Auth handoff required a starting form instead of preserving pending verification
surface: agents
component: browser-auth-handoff-contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser_use.py auth handoff instructions required username/password or code entry even after password acceptance and a pending external-app approval
symptoms:
  - Expected exactly 1 approval request(s), observed 2
  - The instructions say to leave the site's sign-in form with the username/password or code open and visible
  - stuck on the app approval page
  - navback before request_user_assistance_for_authentication
tags:
  - browser-auth
  - app-approval
  - partial-progress
  - handoff-contract
sources:
  - agent 9cd0efae-9695-4470-927e-4e75e3813c33
  - benchmark run f3e92174-e0a9-4243-8c8c-b33276fc1b6b
repro: agents/tests/blackbox/rose_browser_use.blackbox.py; scripts/run-bench --local browser-auth-password-app-approval
status: open
---

## Problem

The user authorized a new auth benchmark covering a saved password followed by
acknowledgment in a separate app. The original task prompt is simply Tell me my
member number for {auth_test_site_url}; no login strategy is supplied. Its site
accepts one saved password, displays a pending app challenge with a matching
number, and only allows the original browser cookie to consume the app's approval.
The harness operates a separate browser as the user's app and completes the real
auth-assistance request. The evaluator requires one request and exact ordered
password/pending -> second_factor/pending -> app_approval/approved ->
second_factor/signed_in events plus the member-number deliverable.

The canonical local run completed in 322 seconds and failed:
Expected exactly 1 approval request(s), observed 2. Native tool state showed
password acceptance and the pending app approval page. At 19:10:02.797 UTC the
model explicitly cited the form-only handoff instruction; navback at
19:10:05.979 returned to /login before the first request. The app approved at
19:10:17.112, but the login browser no longer visited the pending challenge.
After resume the model entered the password again at 19:11:01.159, requested
assistance again, and finally signed in after a second app approval. The root
completed its member-number task, but the unchanged benchmark correctly failed
the repeated password and assistance behavior.

Original run JSON, model dumps, event report and recordings were retained.
The CLI published the durable root viewer, exited 1, and recorded clean stack
and benchmark cleanup receipts. The applied device-form replay-binding guard
is independent of this symptom; this single-challenge regression must not be
reported as proving that fixture hardening caused the auth behavior change.

## Diagnosis

Critical path: saved-password acceptance -> real pending app page -> auth tool
and system instructions -> model navback -> real human assistance -> browser
resume -> repeated password/challenge -> evaluator.

The runtime preserves the same browser across assistance; the regression is
before handoff. Three copies of the LLM-visible auth contract require a
username/password or code-entry form. Those copies live in the default tool
description, recovery-disabled tool override, and system prompt. This is a
contradiction when a valid accepted-password flow is waiting at an app approval
step. No password failure, unavailable credential or broken app approval was
observed. A timeout increase or synthetic trajectory nudge would not fix this.

Step 5 hypothesis: What = valid authentication progress was rewound before
requesting user-only verification; Where = browser auth handoff contract;
Why = a fixed starting-form precondition superseded authoritative current state;
Proof = captured explicit reasoning, navback action, duplicate ledger and exact
local benchmark failure; Problem = handoff instructions discard valid progress.

Step 5b: stopped class = human-handoff contracts replace valid current workflow
progress with a fixed starting-state precondition. The next broader attempted
rule, prohibiting every workflow reset, is incoherent because explicit restarts
and recovery from invalid or expired state legitimately require resets. The
repair is scoped to the auth contract that violates the broader invariant, and
unifies its three consumers instead of adding an app/provider special case.

Archive searches: username/password or code entry approval app sign-in form;
partial authentication pending second factor challenge handoff resets password.
The provider-independent live-view completion case from August 3 was read;
this is a relative, not a recurrence, because completion works here and the
first incorrect action is pre-handoff navigation.

Golden references inspected: Hermes tools/browser_tool_session.py:199 and
tools/browser_tool_lifecycle.py:162 preserve a human login/2FA session; OpenClaw
docs/tools/browser-login.md:11 and :31 use the same host/user profile; Claude
Code src/tools/AskUserQuestionTool/prompt.ts:32 supports during-execution
questions; Codex codex-rs/core/src/tools/handlers/request_user_input.rs:87 awaits
input in the same turn. None has Rose's exact form-only rule; the intended repair
converges on retaining valid in-progress state across the human handoff.

## Solution

Verified local patch: one shared auth-handoff instruction directs the browser to
keep the current sign-in/verification step open, request assistance promptly
when only the user can complete that step, and avoid restarting a successful
earlier step. Default tool, recovery-disabled tool and system prompt consume
the same text. Ordinary initial sign-in still leaves the password/code form
open; pending multi-stage sign-in retains its current challenge. No account,
provider, CAPTCHA recovery, runtime signal, schema or synthetic user-message
change is selected. At 10,000 agents the change adds only constant prompt text,
with no extra channels, polling, shared state or credential lookup.

Before writing the production prompt patch, the existing owning auth-handoff
blackbox was updated to assert the generalized contract. The identical command
from agents, source venv/bin/activate && python scripts/run_blackbox_tests.py
rose-browser-use, failed with 97 passes and the auth-handoff assertion failure,
then passed all 98 cases after the prompt patch. The hosted auth harness suite
and full backend auth-test-site domain also passed, including wrong capability,
wrong number, expiry, independent browser and stale-device-form isolation.
Backend TypeScript, ESLint and Python Ruff checks passed.

The exact unchanged scripts/run-bench --local browser-auth-password-app-approval
then passed in 97.6 seconds, run 5916cb3d-d740-46fa-8879-cf2baf4a36e2,
agent 54357a4d-02ac-4836-bc7b-4bb2a20df38c. The captured ledger has precisely
the four required events, one assistance request, one app approval and one
password_app_approval session. Password acceptance was at 19:20:25.018 UTC,
app approval at 19:20:36.555 and browser session creation at 19:20:36.703.
The benchmark definition's canonical SHA256 was checked unchanged between
runs; no benchmark task prompt, evaluator, expected count or timeout was relaxed. Both owning
cleanup receipts are clean, and both run bundles are on the durable Hub.

Evidence publisher verified the failed viewer with 114 messages and the passing
viewer with 56 in fresh browsers, with terminal browser recordings attached:
https://www.roselabs.ai/?agent-id=9cd0efae-9695-4470-927e-4e75e3813c33#benchmark-share=f3e92174-e0a9-4243-8c8c-b33276fc1b6b.1794597810.613917fa8dec8fad468008bfa1a2338d395e4c546c8f27cd220c527594734ad5
and https://www.roselabs.ai/?agent-id=54357a4d-02ac-4836-bc7b-4bb2a20df38c#benchmark-share=5916cb3d-d740-46fa-8879-cf2baf4a36e2.1794597806.b1176d650d4a1807d6f24d1ef54bbda2790091c0cc5bc76c6bcb5652dcb1d16d.
The publisher's default /opt/cursor destination is not writable on this boxes
host; its documented RCA_EVIDENCE_ARTIFACTS_ROOT override retained local HTML
under the private workspace evidence directory, and the rendered dumps were
uploaded to R2 with seven-day HTTPS links. No recording gate was skipped.

The local correction is verified. This case stays open until the global prompt
diff is approved and deployed; no production rollout has been claimed. The
benchmark does not certify actual Google sign-in or specificity of the generic
human-facing request: the stand-in user receives its matching number privately.

## Human feedback

The user requested the new app-acknowledgment benchmark and a succinct explanation
of aliases/password injection. No approval for deploying prompt changes has
been recorded.

## Reusable lesson

Preserve valid current workflow progress when handing a missing action to the user instead of forcing every handoff back to a fixed starting form.
