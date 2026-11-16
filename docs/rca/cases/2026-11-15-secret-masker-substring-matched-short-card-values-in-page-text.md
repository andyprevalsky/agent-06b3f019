---
id: 2026-11-15-secret-masker-substring-matched-short-card-values-in-page-text
date: 2026-11-15
title: Browser secret masker substring-matched the cardholder name and CVV in page text and step numbers
surface: agents
component: browser-secret-redaction
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/secret_refs.py mask_secret_values (every registered card field substring-matched, via DOMService.model_visible_value and every downstream re-projection); agents/browser_tools/result_projection.py preserve_output_protocol (harness-stamped action_step not exempt when the transcript is re-projected)
symptoms:
  - "{{secret:card_name}} Test Payment"
  - "\"merchant\":\"{{secret:card_name}} Test Payment\""
  - "\"action_step\":\"{{secret:card_cvv}}\""
  - "{\"step\":\"{{secret:card_cvv}}\",\"action\":\"screenshot\""
  - "title={{secret:card_name}}"
tags:
  - secret-redaction
  - payment-card
  - agentcard
  - browser-observation
  - over-masking
sources:
  - agent b4466499-8297-4782-891a-3f0798c845a0
repro: agents/tests/blackbox/browser_credentials.blackbox.py::test_short_card_secrets_mask_filled_values_not_page_text_or_step_numbers
status: fixed
---

## Problem

During the live AgentCard purchase on 2026-11-15 (agent b4466499, browser LLM
dumps 22:06-22:18Z), the browser model's context had secret placeholders in
ordinary page content. The decrypted dumps held 6,659 `{{secret:card_name}}`
occurrences. The card name was the merchant's own name ("Rose Labs"), so the
model read `Merchant:\n{{secret:card_name}} Test Payment`, the page title
became the placeholder, and the model copied
`"merchant":"{{secret:card_name}} Test Payment"` into its own
`request_payment_card` arguments. Separately, a tool result's
`"action_step"` and an action-history `"step"` became `"{{secret:card_cvv}}"`:
the CVV had a leading zero, and `Decimal` equality matched it to the bare
step number. The tool schema's `steps` default in the dump was masked the
same way.

## Diagnosis

Critical path: browser-use DOM serialization → `DOMService.get_browser_state`
→ `DOMService.model_visible_value` → `mask_secret_values` →
`model_visible_action_result` → `_append_browser_turn_messages` →
`_model_visible_browser_turn_messages` (re-projected on every LLM call) →
`helpers/observability.py` dump redaction.

1. `mask_secret_values` built one alternation of every registered plaintext
   form and substituted it anywhere in any string (`_is_masked_secret_ref`:
   "every registered credential binding is private, including short card
   fields"). The card name and CVV are short or ordinary words, so every
   merchant heading, title and number that matched them was rewritten. Every
   later projection layer re-applied the same policy, so a fix at one layer
   alone would have been undone downstream.
2. The handler stamps `result["action_step"]` after page masking. But
   `_model_visible_browser_message.visible_json` re-parses each prior tool
   result and masks its integers on every model call, and
   `preserve_output_protocol` restored only retained-output fields, not the
   harness-owned step.
3. Why possible: one policy served two different trust boundaries. Logs and
   raw page-script readbacks need strict masking. Model-visible observations
   need the secret masked only where the page holds it as a value.

Repro (`BLACKBOX_CASE_FUNCTIONS=test_short_card_secrets_mask_filled_values_not_page_text_or_step_numbers python scripts/run_blackbox_tests.py browser-credentials`)
failed on main at the first page-text assertion, with the rendered state
`{{secret:card_name}} Checkout\nMerchant:\n{{secret:card_name}} Test Payment`
and `Order {{secret:card_cvv}} of {{secret:card_expiry}}/2026`. It passes after
the fix.

Archive searches: "secret masker card_name placeholder page text over-mask"
and "mask_secret_values cvv numeric action_step". Relative:
`2026-09-09-planner-memory-sanitizer-context-free-regexes`. Its lesson ("parse
structured spans before redaction") applies directly: short values are now
matched only in structural value positions. Also related:
`2026-11-15-capture-timestamp-digits-trip-private-value-scan` (short numeric
CVV fixtures colliding with unrelated numbers). This incident is novel, not a
recurrence.

## Solution

- `mask_secret_values` stays strict by default. That covers logs, every raw
  readback (evaluate values and exceptions, logs, network bodies, select
  messages, action errors), streaming, LLM dumps, `_redact_activity_value`,
  retained-output readback and anything unclassified.
- `value_scoped=True` applies only to the rendered page and to the model's
  own content:
  - the `url`, `title`, `dom_tree` and `tabs` of
    `DOMService.get_browser_state`;
  - `DOMService.model_visible_observation`, used only for the
    `VALUE_SCOPED_RESULT_FIELDS` of `read_browser_state` (`url`, `title`,
    `dom_tree`, `tabs`, `formatted_state`) and `request_payment_card`
    (`payment_request`), through `result_projection.project_result`, and for
    the transcript's assistant text and tool-call arguments
    (`authored_redact`). That covers the action result, history
    `formatted_state`, the model preview and its bounded `_safe_text` path,
    and retained-output re-projection. The harness-attached raw fields of
    those results (`current_url`, `auth_context`, `error`,
    `downloaded_files`) stay strict.
- Under that policy `card_name`, `card_expiry` and `card_cvv` are masked only
  as a complete value: a whole string, a form field
  `value=`/`valuetext=`/`aria-valuetext=`, a URL query or fragment value, or a
  quoted literal. They are never masked as numbers. Context prefixes are
  masked strictly. Passwords and the card number stay masked everywhere.
- Harness steps are restored after masking: top-level `action_step` and
  `screenshot_context.step` (`preserve_output_protocol`,
  `capture_screenshot_evidence`, `project_entry`), and history entry `step`
  in `_redact_activity_value`. Nested page data and tool arguments are not
  exempt.
- Accepted, and asserted in the test:
  - A CVV or expiry inside page prose is not masked in observations. It
    cannot be told from an order number or a date without a string
    classifier; merchants do not display a CVV, and a page that echoes one
    already holds it.
  - A page title whose entire text equals the card name is still masked.
  - LLM dumps stay strict, so they can show placeholders the model did not
    see.
  - Still strictly over-masked, but not shown to the transcript-mode browser
    model: action-history `params`, which the JEV judge and the fallback
    history prompt read, and `read_tool_output` paging of a retained page
    state.
- 10k agents: the regex is still built per call from the activity's own
  bindings and stays linear on page-controlled prefixes. No shared state, no
  added fan-in.

## Human feedback

The coordinator asked that PAN masking stay universal, that the
CVV-in-prose behavior be explicitly accepted with a test and reasoning, and
that the action_step exemption cover only the harness field. All three are
asserted in the regression test.

## Reusable lesson

Scope redaction by trust boundary and structural position. Strict masking is
the default, for logs, raw readbacks and anything unclassified. Only the
rendered page and the model's own content mask short, low-entropy secrets
just where they appear as values, and every re-projection layer must keep the
channel's policy. A generic projection shared by readbacks must never be
loosened.
