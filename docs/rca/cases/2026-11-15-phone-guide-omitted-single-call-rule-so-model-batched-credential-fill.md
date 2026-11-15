---
id: 2026-11-15-phone-guide-omitted-single-call-rule-so-model-batched-credential-fill
date: 2026-11-15
title: Phone guide invited same-response verification but never stated that credential fills run alone, so the live model batched credentials.fill_saved + screen.text and the whole turn was rejected
surface: agents
component: rose-browser-use-phone-guidance
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/phone.py PHONE_GUIDANCE told the model to verify actions with screen.text in the same response but named only the batchable actions, while RoseClient.complete_browser_use (agents/providers/rose/client.py) refuses any multi-call turn containing a phone call that browser_tools/schemas.py phone_call_batchable rejects (credentials.*, messages.*, setup, release); the qwen-3.8-27b answer [credentials.fill_saved, screen.text] was therefore refused with "This browser action requires a separate turn"
symptoms:
  - "AssertionError: ['Completed browser model response did not contain a valid action']"
  - This browser action requires a separate turn
  - native_autofill_real_model_controls
  - Completed browser response failed output validation
tags:
  - phone
  - native-autofill
  - batch-actions
  - prompt-runtime-contract
  - flaky-live-model
sources:
  - task bdc52b970d77433dab652f0fbe5f5c1b (FLAKY occurrence)
  - fleet run https://github.com/Rose-Ai-Labs/rose/actions/runs/43744819009
  - commit c3933ed27d (quarantine marker, PR #2225)
  - PR #2186 (phone batch continuation, commits c7c9652cee, e34e7ee85f)
  - plan:docs/plans/completed/phone-batch-continuation.md
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_native_autofill_real_model_synthetic_controls (live) and agents/benchmarks/browser_action_batch_test.py::assert_guidance_names_single_call_phone_families via the phone_batch_contract blackbox case (deterministic)
status: fixed
---

## Problem

The `agents-coverage-blackbox` deploy gate for PR #2225 failed only
`native_autofill_real_model_controls` (127 passed, 1 failed) with
`AssertionError: ['Completed browser model response did not contain a valid action']`;
the rerun on the same source passed. The CI log shows the `server_available` arm
(request `4901b30acabc`) answered by direct Cerebras `qwen-3.8-27b` with
`chunk_counts={... 'tool_call': 2 ...}` and `buffered_tool_argument_fragments=2`,
then no `Native AutoFill actual choice: server_available` line: the arm raised.
No LLM dump was archived (`llm.archive.unbound_refused`, agent_id empty).

Local replay of the arm's exact request (built through the test's own
`_native_autofill_control_scenario` / `_native_autofill_control_request`, live
Cerebras route) returned `BrowserModelOutputValidationError` with private detail
`This browser action requires a separate turn` in 9/30 calls; every rejected
response was the two native calls
`phone{operation: credentials.fill_saved, args: {}}` then
`phone{operation: screen.text, args: {min_confidence: 0.3}}`. The identical
original command `python scripts/run_blackbox_tests.py rose-browser-use` (from
`agents/`) reproduced the exact assertion in 2/5 runs on unchanged main
(`TEST_QUARANTINE status=QUARANTINED_FAIL`).

## Diagnosis

Critical path: synthetic phone state + `PHONE_GUIDANCE` → `complete_browser_use`
→ provider tool calls → `normalize_browser_use_tool_calls` → batch admission in
`client.py` (`phone_call_batchable`) → action. The data is first wrong at the
model output, which is a reasonable reading of the guide: "Observe with
screen.text, act, then verify. After a tap, launch, press, drag, scroll, key,
Home or input.text action, put screen.text as the next call in the same
response". The guide never said which calls may *not* share a response, while
the runtime refuses every non-batchable phone call in a batch (PR #2186 kept
`credentials.*`, `messages.*`, `setup`, `release` as separate turns and pins it
in `phone_batch_contract`: "credential fill shared a model turn").

Why possible (ladder): (1) the model batched an act-then-verify pair the runtime
refuses; (2) the refusal is a runtime-only contract absent from the guide — the
model cannot know it; production feeds back only a generic "did not contain a
valid browser action" message, costing a turn; (3) PR #2186's wording made the
pattern ~3× more frequent: the pre-#2186 guide ("act once, then verify") gave
3/30 rejections on the same replay, the current one 9/30. So this is not
PR #2225's change (Gate: NOT_INTRODUCED for #2225); it is a guide/runtime
contract gap that existed before #2186 and was amplified by it.

Why intermittent: the route depends on test order — the module pops
`CEREBRAS_API_KEY` at import, but a later `config.load_config()` re-reads
`agents/.env`, so the arm is served by direct Cerebras (batches ~30%) or the
OpenRouter waterfall (0/24 locally).

Step 5b climb: the fix stops at the class "every phone call family the runtime
refuses to batch must be stated in the guide", not the instance
(`credentials.fill_saved`). The next-deeper class tried was the runtime one:
admit credential fills as a batch leader followed only by reads. It was not
coherent here: PR #2186 deliberately and explicitly asserts that a credential
fill must never share a model turn, so reversing it is a credential-safety policy
change, not a fix of an inconsistency.

## Solution

`PHONE_GUIDANCE` now states the runtime rule beside the batching invitation:
"A credentials.*, messages.*, setup or release call must be the only tool call in
its response; observe its result on the next turn." The phone tool description in
`agents/providers/rose/browser_use.py` (`BROWSER_USE_TOOLS['phone']`), which
also says "put screen.text after an action in the same response" and which the
model quoted in a captured rejection, now carries the same single-call rule
(same-class site found by the independent verification review). The pinned guide SHA in
`test_phone_setup_settings_actual_handler_observation` was updated. The new
`assert_guidance_names_single_call_phone_families` (run in the deploy path by the
`phone_batch_contract` blackbox case) binds each refused family to that
sentence and keeps the navigation batching invitation as a negative control; it
fails on the old guide and passes on the new. The quarantine marker on
`test_native_autofill_real_model_synthetic_controls` is removed.

Proof: same replay, Cerebras route — before 9/30 rejected (independent
reviewer: 4/12 on origin/main, 0/24 on the fixed tree), after 0/80 for the guide
alone and 0/40 for the final guide + tool description
(`server_available` 40+40), all other arms correct 10/10 each, and
`available` still batches `input.tap` + `screen.text` (7/8 Cerebras answers), so
the #2186 latency win is kept. Identical original command after the fix: 10/10
PASS on the guide-only tree and 5/5 PASS (128 passed) on the final tree, every
arm served by Cerebras.

Siblings prevented: the same rejection for `credentials.fill_device_passcode`,
`messages.*`, `setup` and `release` batched with a verification read.
10k agents: prompt bytes only; no new I/O, state or fan-in, and fewer wasted
model turns.

## Human feedback

None recorded.

## Reusable lesson

When a runtime refuses a model output shape, state that refusal in the guide the model reads, next to any instruction that invites the shape, and bind both with one contract test.
