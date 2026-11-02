---
id: 2026-10-31-rejected-control-narrated-saved-credential-attempt-in-ocr-instead-of-production-tool-turns
date: 2026-10-31
title: Native AutoFill `rejected` control narrated a native AutoFill rejection in OCR with no tool turns, so the skill's own "backend catalog is separate" rule left `credentials.fill_saved` a valid choice
surface: agents
component: rose-browser-use-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/tests/blackbox/rose_browser_use.blackbox.py test_native_autofill_real_model_synthetic_controls — the `rejected` arm built `history, turns = ActionHistory(), []` and conveyed the attempt only as OCR text ("The matching saved password was already selected once using native AutoFill. Apple Account rejected it"), a transcript production cannot produce: production records every executed `phone` action as an assistant tool call plus backend receipt via `_append_browser_turn_messages`, and the backend has no "rejected" receipt for `credentials.fill_saved`
symptoms:
  - "native_autofill_real_model_controls: AssertionError: ['(\\'rejected\\', {\\'actual_model\\': \\'qwen/qwen3.8-27b\\', \\'mode\\': \\'waterfall\\', \\'request_id\\': \\'78274a1e4240\\'}, {\\'action\\': \\'phone\\', ... \\'operation\\': \\'credentials.fill_saved\\'"
  - "Native AutoFill actual choice: rejected 0 ... credentials.fill_saved"
  - "rejected arm re-read screen.text three times until the round cap"
  - "rose-browser-use FAIL (117 passed, 1 failed)"
tags:
  - rose-browser-use
  - native-autofill
  - phone
  - real-model-control
  - turn-messages
  - fill-saved
  - deploy-gate-flake
  - recurrence
sources:
  - commit 696b62276
  - commit 0e8c0307f
  - commit ed414f2f8
  - memory:native-autofill-real-model-control-flake
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_native_autofill_control_scenarios_record_saved_credential_attempts_as_turns (case `native_autofill_control_attempt_turns`)
status: fixed
---

## Problem

Deploy round 2 on `c7e34f56d` (which already carries `ed414f2f8`, the fix from
`2026-10-30-control-fixture-used-lossy-legacy-action-history-instead-of-production-turn-messages`)
failed the agents blackbox domain `rose-browser-use` at 2026-10-31 00:28Z in
`native_autofill_real_model_controls`, `rejected` arm. Evidence (read-only,
speed-followup-2 worktree): `.context/test-runs/agents-coverage-20261031-001559-345043/rose-browser-use.log`
lines 825–888 and the model-visible dump
`.llm-dumps/unbound/1793406538465-db30e8d4e067-test-native-autofill-rejected.json`.
Served leg: `qwen/qwen3.8-27b`, mode `waterfall`, request `78274a1e4240`
(Foundry fell through in 0.031 s with `RoseServerError`; Cerebras unconfigured
in coverage — the same leg as every recorded pass). The model chose
`phone(mode=operation, operation=credentials.fill_saved, args={})`; the control
asserts `request_user_assistance_for_authentication(targetKind=iphone,
criticalReason=password)`. The `missing` arm, fixed by `ed414f2f8`, passed.

The dump's model-visible transcript was exactly four messages: browser system
prompt, `PHONE_GUIDANCE`, the task, and `<observed_phone_state>` whose
`lastOperation` was a `screen.text` reading "Apple Account
synthetic@example.invalid. The matching saved password was already selected
once using native AutoFill. Apple Account rejected it: Incorrect password.
Password is still required to continue." No assistant tool call, no tool
receipt. The model's reasoning quoted both skill rules — "If a credential was
rejected ... request the protected step rather than retrying the rejected
credential" and "Native AutoFill and the backend saved-password catalog are
separate ... use credentials.fill_saved once with empty args ... BEFORE
requesting password assistance" — and concluded that a native rejection does
not show the backend catalog was tried, so it tried it.

Across the 12 recorded `rejected` decisions in that worktree (2026-10-30
13:45Z → 2026-10-31 00:28Z, all `qwen/qwen3.8-27b`, all `message_count=4`):
8 asked for help with `password`, 1 chose `credentials.fill_saved` (this
failure), 3 were the 13:45Z run's three `screen.text` re-reads until the round
cap. The arm's verdict was not determined by its input.

## Diagnosis

Step 0.5 searches: `rca_archive.py search "rejected saved credential fill_saved
retry native autofill"` and `"native_autofill_real_model_controls rejected arm
screen.text re-read"`. Hits: the 2026-10-30 case above (same control, sibling
arm, same problem class) and
`2026-10-24-browser-auth-contract-restated-iphone-password-rule-without-saved-credential-step`
(same control flipping between the same two tools, a prompt-conflict boundary).
This incident is a recurrence of the 2026-10-30 problem class at the arm the
earlier fix did not reach: that case noted the 13:45Z `rejected` loop as "the
same defect from the read side" and treated the remaining `rejected` flips as
sampling noise, but the arm still had no tool turns at all.

Critical path: control builds `(state, history=ActionHistory(), turns=[])` →
`_native_autofill_control_request` → `RoseClient.complete_browser_use` →
`build_browser_use_messages` (turn_messages branch, empty) → OpenRouter qwen →
`UnifiedAction` → assert.

Where production puts the information the control narrated:

1. `agents/domains/spawn_browser_agent_v3/handler.py` records every executed
   action (`phone` included) as an assistant tool call with its arguments plus
   a `tool` receipt through `_append_browser_turn_messages`; the generic
   post-execution site is handler.py ~7600 and `execute_browser_action` routes
   `phone` to `execute_phone` (service_actions.py 1751). The next model turn
   therefore sees `phone({"mode":"operation","operation":"credentials.fill_saved","args":{}})`
   and the backend receipt.
2. The backend has no "rejected" receipt. `back-end/src/domains/iphone/service.savedCredential.ts`
   `runSavedCredential` finishes SUCCEEDED with the private result
   `{success: true, private: true, credentialStatus: 'filled'}` (cemented by
   `iphone-control.saved-credential.cases.ts`) or FAILED with
   `phone_credential_unavailable | phone_credential_verifier_unavailable |
   phone_credential_binding_required` (`redactResult` projects
   `credentialStatus: 'unavailable'`). It types the password and cannot observe
   Apple's verdict; the skill says so ("A filled receipt is only a private
   acknowledgment, not sign-in proof; observe and verify"). A rejection is
   visible only in the next `screen.text`, and *which* credential was rejected
   is visible only through the prior tool turn.
3. Production does not gate `credentials.fill_saved` after a rejection.
   `phone_actions` (phone.py) gates only the `phone` action on capability;
   operations are decided by the live host ("The live host decides which
   operations are supported"). There is no real tool result that signals a
   rejection to key a state-driven gate on, so a harness gate could only be
   driven by OCR text (a string-matching classifier) or by "fill_saved at most
   once per lease", which breaks the skill's documented second legitimate use
   (the App Store password prompt during Gmail installation, and
   observe-again-then-retry after `phone_credential_binding_required`). The
   behaviour the control protects — never blindly retry the credential that was
   just rejected — is already what the prompt states; the fixture simply never
   put that credential in front of the model.

First-bad boundary: the `rejected` arm's input. It narrated a *native* AutoFill
rejection in OCR with no backend attempt in the transcript. Under the skill's
own rules that input does not determine the asserted verdict (a backend
`fill_saved` attempt is a defensible next step after a native-only rejection),
so the arm measured sampling, not the protected behaviour. Deterministic
replay: with the committed unfixed fixture, the control's wire request equals
the failing lane's dumped model input modulo lease timestamps
(`/tmp/rca-autofill/replay_compare.py` → `control request == dumped model input
(modulo lease timestamps): True`), and replaying the dump's recorded decision
through the control fails its assertion.

Step 5:

- **What** — the `rejected` control intermittently ends in
  `phone(credentials.fill_saved)` or repeated `screen.text` instead of
  `request_user_assistance_for_authentication(password)`.
- **Where** — `rose_browser_use.blackbox.py`
  `test_native_autofill_real_model_synthetic_controls`, `rejected` scenario:
  empty `turns`, attempt history written into the OCR string.
- **Why** — production conveys "which saved credential was tried" through the
  model's own recorded `phone` tool call and backend receipt; the fixture
  conveyed it as a screen sentence naming native AutoFill, leaving the skill's
  "backend catalog is separate; fill_saved once before password help" rule
  applicable; the live model (temperature 0.3) then resolves the ambiguity
  either way.
- **Proof** — dump `1793406538465-db30e8d4e067`: `message_count=4`, no tool
  turns, reasoning explicitly derives "credentials.fill_saved (NOT yet tried)";
  regression `native_autofill_control_attempt_turns` fails on `696b62276`
  with `('rejected', 'control narrates a saved-credential attempt instead of
  recording the production tool turn', [])` and passes on `0e8c0307f`
  unchanged.
- **Problem** — fixture/environment/data mismatch: a real-model control whose
  verdict presupposes a prior action must carry that action in the production
  stores (`turn_messages` via the production recorder), never as observation
  text.

Step 5a ladder: Why 1 — the arm had no turns (fixture). Why 2 — the control's
scenario setup was inlined per arm with no invariant tying "verdict presupposes
attempt X" to "transcript contains attempt X"; `ed414f2f8` added the plumbing
but only the `missing` arm used it. _Evidence: the new regression enumerates
the presupposed attempt per arm and fails only on `rejected`._ Why 3 would be
"the control is a live stochastic sample" — a deliberate design (it exists to
catch prompt regressions like 2026-10-24); stop. Fix at Why 2: a shared
scenario builder plus the invariant, which also covers the other four arms.
Not a prompt edit (Step 5b not applicable); not a harness change.

Determinism (question 2 from the delegating thread): a live model at
temperature 0.3 is never strictly deterministic, and the assertion is a
product-behaviour check that a replay would stop testing. The input previously
sat on a genuine rule conflict (2 of 10 runs deviated); with the production
transcript the conflict is gone. Post-fix: the domain run's live arm asked for
help at round 0 ("The saved credential was rejected ... I should not retry the
rejected credential"), and six further live samples through the same builder
and client were 6/6 `request_user_assistance_for_authentication(password)`
with no re-reads (`qwen/qwen3.8-27b`, waterfall). That is a measured flip rate
of 0/7, not a proof of determinism; the deterministic guard is the mocked
regression on the input shape.

## Solution

`696b62276` factors the five arms into `_NATIVE_AUTOFILL_CONTROL_SCREENS` +
`_native_autofill_control_scenario(name, setup_projection)`, used by the live
control, and adds `native_autofill_control_attempt_turns`: for each arm it
captures the control's wire request through a mock provider and asserts that
the transcript was produced by `_append_browser_turn_messages`, that arms whose
verdict presupposes no saved-credential attempt carry no `credentials.fill_saved`
turn, that `missing` carries one FAILED `phone_credential_unavailable` receipt,
and that `rejected` carries one SUCCEEDED receipt whose `result` is exactly the
backend's `{success: true, private: true, credentialStatus: 'filled'}`, preceded
by a `screen.text` at a lower cursor (fill_saved requires a current read) and
followed by the `screen.text` that is the observed `lastOperation` at a higher
cursor. Observed failing on that commit.

`0e8c0307f` rebuilds the `rejected` arm as production reaches a rejection:
observe the form (cursor 1, the `server_available` screen) → backend
`credentials.fill_saved` → `filled` (cursor 2) → observe again (cursor 3) and
read "Alert: Incorrect password. The masked password field is empty again. No
matching native AutoFill suggestion is available. Password is still required to
continue." All three recorded through the production recorder; the screen
carries only what a screen shows. The control's assertion, PHONE_GUIDANCE, the
harness, benchmark definitions and timeouts are unchanged. Regression passes;
`cd agents && source venv/bin/activate && python scripts/run_blackbox_tests.py rose-browser-use`
→ `rose-browser-use` 118 passed, 0 failed (run `20261031-005227-1074467-efc537d8`).
10k-agent behaviour: test-only; no runtime change.

Residual fidelity nit, not changed here: the `missing` arm's unavailable
receipt carries a top-level `error` and `result: None`, whereas the backend's
public receipt has no top-level `error` and `result: {success: false, private:
true, credentialStatus: 'unavailable'}`; the error code reaches the model either
way and the earlier regression asserts the current shape.

## Human feedback

The delegating thread bounded the fix: do not weaken the assertion to accept
phone autofill after rejection, no runtime nudges, no string-matching
classifiers, no fallbacks, skips or retries-until-pass; prefer the smallest
change that keeps the gate protecting "never blindly retry a rejected saved
credential". A reviewer's hypothesis — classify the fixture's receipt against
the exact credential source/identity before touching prompts or the oracle —
matched the evidence: production's receipt cannot carry a rejection, so the
source must come from the recorded tool turn, which the fixture omitted.

## Reusable lesson

A real-model control's verdict may depend only on evidence the production loop
would actually have put in front of the model: prior actions belong in
`turn_messages` through the production recorder, observations belong in the
observed state, and OCR text must never narrate history. Before attributing a
live-control flip to sampling, enumerate which prior action each arm's verdict
presupposes and check it is present as a tool turn.
