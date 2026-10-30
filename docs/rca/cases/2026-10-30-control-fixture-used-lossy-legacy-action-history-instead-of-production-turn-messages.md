---
id: 2026-10-30-control-fixture-used-lossy-legacy-action-history-instead-of-production-turn-messages
date: 2026-10-30
title: Native AutoFill real-model control fed the model the legacy `Previous Actions` summary, which drops the phone operation name production shows via `turn_messages`
surface: agents
component: rose-browser-use-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/tests/blackbox/rose_browser_use.blackbox.py test_native_autofill_real_model_synthetic_controls — `complete_browser_use(action_history=...)` without `turn_messages`, so `build_browser_use_messages` took the legacy `_format_action_history` branch (`Step 1: phone ✗ Error: phone_credential_unavailable`) that production (`_call_browser_use_with_rotation`, always `turn_messages`) never sends
symptoms:
  - "native_autofill_real_model_controls: AssertionError"
  - "missing-case emitted phone credentials.fill_saved"
  - "Step 1: phone ✗ Error: phone_credential_unavailable"
  - "FAIL rose-browser-use"
  - "Agents blackbox: 123 passed, 1 failed, 124 total"
tags:
  - rose-browser-use
  - native-autofill
  - phone
  - real-model-control
  - turn-messages
  - action-history
  - deploy-gate-flake
  - qwen
  - foundry-fall-through
sources:
  - commit 0d2c5f6ba
  - commit ed414f2f8
  - memory:native-autofill-real-model-control-flake
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_native_autofill_control_transcript_matches_production_shape (case `native_autofill_control_production_transcript`)
status: fixed
---

## Problem

Evidence (read-only, speed-followup-2 worktree): deploy-run `20261030-222003-2175379` lane log `agents-coverage-blackbox-20261030-222949-2434367.log` → `.context/test-runs/agents-coverage-20261030-222950-2435065/rose-browser-use.log` (22:42Z); deploy #1640 attempt 1 (`deploy-runs/20261030-180517-1149737`); `.context/test-runs/agents-coverage-20261030-134502-1001949/rose-browser-use.log` (13:45Z `rejected` re-read loop); model-visible dump `.llm-dumps/unbound/1793400178339-7c6563c87c59-test-native-autofill-missing.json`.

The agents blackbox domain `rose-browser-use` intermittently failed its
deploy-lane case `native_autofill_real_model_controls` (deploy #1640 attempt 1,
the PR-5 control run at 2026-10-30 22:42Z, plus 2026-10-27 03:16Z/05:34Z and
2026-10-29 05:48Z per the project memory). The `missing` control — saved
credential already tried, `credentials.fill_saved` already failed with
`phone_credential_unavailable` — must end in
`request_user_assistance_for_authentication(criticalReason=password)`. The real
model (`qwen/qwen3.8-27b`, OpenRouter waterfall step 1) instead chose
`phone(operation=credentials.fill_saved)` again. Its own reasoning in the dump
said "I should use credentials.fill_saved once with empty args" — it believed
fill_saved had not yet been tried. The 13:45Z run failed the sibling `rejected`
control a different way: three identical `screen.text` re-reads ("let me get a
fresh screen observation first") until the control's 3-round cap asserted on a
read action.

Across all 9 recorded runs in this worktree (8 lane runs + 1 baseline) every
control was served by `qwen/qwen3.8-27b`: Cerebras is unconfigured in coverage
and Foundry fell through in ~0.04 s (`rose.foundry.shared_cooldown_read_failed
ConnectError` → `RoseServerError("Foundry shared cooldown authority
unavailable")`, no backend in the coverage env). The served model is therefore
constant between passing and failing runs; the outage changed the leg, not the
outcome. `actual_model=''` in the lane log belongs to a different case
(`complete_browser_use_capture_failure_original_error`, which constructs a
synthetic `RoseResponse(request_id='actual-failed-capture')` and injects
`OSError('offline capture failure')`); the control's served model is recorded in
`llm.cache actual_model=qwen/qwen3.8-27b` and `llm.context.dumped
model=qwen/qwen3.8-27b`, but the control only printed it after its asserts, so a
failure never named the leg.

## Diagnosis

Critical path: control builds `ActionHistory` → `RoseClient.complete_browser_use`
→ `build_browser_use_messages` → OpenRouter qwen → `UnifiedAction` → assert.

1. The failing dump's model-visible user turn was exactly
   `"...only when needed.\n\nPrevious Actions:\nStep 1: phone ✗ Error:
   phone_credential_unavailable\n"`. `_format_action_history` renders
   `entry["action"]` plus `result["error"]` and drops `params`, so the phone
   `operation` (`credentials.fill_saved`) never reached the model. The `missing`
   and `server_available` screens are byte-identical; the only difference the
   model could see was that opaque error code.
2. In all seven passing `missing` dumps the model wrote "the previous
   `credentials.fill_saved` call returned `phone_credential_unavailable`" — an
   inference from the error code, not something it was shown. In the failing
   sample it did not make that inference.
3. `build_browser_use_messages` takes the legacy `action_history` branch only
   when `turn_messages is None`. Production `_call_browser_use_with_rotation`
   always passes `turn_messages` (a list, possibly empty), and
   `_append_browser_turn_messages` records each executed phone action as an
   assistant tool call with `{"mode":"operation","operation":"credentials.fill_saved","args":{}}`
   plus a `tool` result carrying the full receipt. Production models therefore
   see the operation; the control's model did not. First-bad boundary: the
   control's request omitted `turn_messages`.
4. The 13:45Z `rejected` loop is the same defect from the read side: the legacy
   line for the model's own `screen.text` read is `phone ✓`, so each round the
   model could not see it had already re-observed.

Step 5a ladder: the deepest owned cause is a fixture/environment mismatch — the
control reproduced the model's inputs with a lossy legacy serializer that the
production path does not use. Not climbed into a prompt edit: PHONE_GUIDANCE is
unchanged, and the related case
`2026-10-24-browser-auth-contract-restated-iphone-password-rule-without-saved-credential-step`
(same control flipping on the same two tools) had a different boundary (a
competing prompt restatement); this incident is a relative, not a recurrence.

Not attributable here: the 2026-10-27 and 2026-10-29 lane dumps live on other
devboxes and were not inspected; they are consistent with but not proven to be
this boundary.

## Solution

Commit `0d2c5f6ba` factors the control's request and action recording into
`_native_autofill_control_request` / `_native_autofill_control_record`, which
record through the production recorder `_append_browser_turn_messages` and bind
every verdict to `{"actual_model","mode","request_id"}`; it adds
`native_autofill_control_production_transcript`, a mocked regression that
captures the control's wire request and asserts the non-system transcript is
`[user task, assistant phone(credentials.fill_saved), tool receipt
phone_credential_unavailable, observed_phone_state]` with no legacy suffix, and
that a model `screen.text` read lands as its own tool call/result with the
advanced cursor. It fails on that commit (`('legacy lossy history suffix', ...)`).
Commit `ed414f2f8` forwards `turn_messages` from the shared helper exactly as
production does; the regression passes and the exact domain run passed (118
cases; `missing` → `request_user_assistance_for_authentication(password)`,
`rejected` re-read once then requested assistance). No prompt, harness,
assertion, benchmark or timeout change. 10k-agent behavior: test-only, no
runtime change.

Residual: the control still samples a live stochastic model once per scenario
at temperature 0.3; this fix removes the information gap, not the sampling. If
it flips again, the verdict now names the served leg, and the dump under
`.llm-dumps/unbound/*-test-native-autofill-<scenario>.json` shows the full
transcript.

## Human feedback

The delegating thread set the bounds: do not weaken the assertion to accept
phone autofill, no runtime nudges, no string-matching classifiers, no benchmark
definition or timeout changes, no fallbacks that hide the primary path. None of
these were needed; no prompt-approval hunk is involved.

## Reusable lesson

A real-model control must send the model the same transcript shape production
sends (`turn_messages` via the production recorder), never a legacy summary;
when a live control flips, diff the failing dump's model-visible turns against
a production request before touching the prompt.
