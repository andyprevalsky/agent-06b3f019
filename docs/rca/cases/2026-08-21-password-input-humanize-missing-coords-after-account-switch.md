---
id: 2026-08-21-password-input-humanize-missing-coords-after-account-switch
date: 2026-08-21
title: Password secret-ref typing failed humanize when indexed password had no coordinates after account switch
surface: agents
component: spawn_browser_agent_v3-input_text
classification: our-bug
problem_class: other
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py::_execute_indexed_input_text — payment-only semantic coord fallback; password secret-refs had no equivalent after DOM refresh miss
symptoms:
  - 'Cannot humanize input_text for element index 770: no coordinates available'
  - 'Declared evaluator amazon-return-runtime-contract failed: Observed tool failure: spawn_browser_agent call_Lt8QibPpeGLNNaOmRgxUlnQZ status=ERROR'
  - 'Typed ''[encrypted_data]'' into <input name="password">'
tags:
  - browser-agent
  - humanize
  - password
  - amazon-return
  - no-tool-failures
sources:
  - agent fbc36706-4093-4bb4-a457-d4a8f486e62b
  - plan:agents/benchmarks/runs/20260821_225850_browser-amazon-return.json
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py — test_execute_input_text_password_secret_ref_resolves_visible_password_coords
status: fixed
---

## Problem

Local `browser-amazon-return` k=5 agent `fbc36706-4093-4bb4-a457-d4a8f486e62b`
reached an unresolved return write-lock (`approvals_triggered=1`) and still
failed:

`Declared evaluator amazon-return-runtime-contract failed: Observed tool
failure: spawn_browser_agent call_Lt8QibPpeGLNNaOmRgxUlnQZ status=ERROR`

Runtime evidence:

- After Switch accounts → Andy Prevalsky, `input_text` on
  `<input name="password">` with encrypted password secret-ref posted
  `toolStatus=ERROR` / `Cannot humanize input_text for element index 770: no
  coordinates available`
- Agent recovered (goto order history → return flow → write lock)
- `no_tool_failures` correctly counted the real action ERROR (not
  `browser_challenge_recovery`)

Sibling agent `4789b9f3` typed the same password field successfully on a
different sign-in path, so the field can expose coords — this miss is
post-account-picker transition / stale index.

## Diagnosis

`_execute_indexed_input_text` refreshes DOM coords, then falls back to
`_resolve_payment_ref_coordinates` only for payment card secret-refs. Password
secret-refs (`credential_ref.kind=password`) had no semantic locate path. With
humanizer present and no coords, the function intentionally refuses
`TypeTextEvent` and returns failure — correct fail-closed humanize policy,
missing password locate.

Owning boundary: Broken Tool — password humanize coordinate resolution.

Not Faulty Evaluator: Andy's write-lock-only completion bar still keeps
catalog `no_tool_failures`; Eventim's challenge-recovery carve-out does not
apply to real `input_text` action errors.

## Solution

Add `_resolve_password_field_coordinates` (visible
`input[type=password]` / `name=password` / autocomplete current|new-password)
and invoke it from `_execute_indexed_input_text` when the secret-ref
credential kind is `password` and indexed/refreshed coords are still missing.
Keep TypeTextEvent refuse when no real coords exist.

Cemented by:

- `test_execute_input_text_password_secret_ref_resolves_visible_password_coords`
- `test_resolve_password_field_coordinates_uses_visible_password_input`

## Human feedback

None recorded.

## Reusable lesson

When humanize refuses TypeTextEvent on missing indexed coords, every secret-ref
class that must type (payment, password) needs a semantic visible-field
coordinate locator — not an evaluator carve-out for recovered action ERRORs.
