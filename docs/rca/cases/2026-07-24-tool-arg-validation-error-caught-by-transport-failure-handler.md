---
id: 2026-07-24-tool-arg-validation-error-caught-by-transport-failure-handler
date: 2026-07-24
title: A tool-arg `ValidationError` fell into the browser loop's transport-failure handler, hiding the error from the model and mislabeling the abort as "Max Steps Reached"
surface: agents
component: browser-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: handler.py:5816 catch-all `except Exception` — meant for Rose transport/infra failures, also swallowed parse-time tool-arg ValidationErrors
symptoms:
  - '"Aborting: 5 consecutive Rose API failures"'
  - '"Max iterations reached: 50" logged when the real iteration count was ~16'
  - '"Task Incomplete - Max Steps Reached" posted after ~1m40s of zero visible progress'
  - request_payment_card never appears in the trajectory
tags:
  - browser-agent
  - error-handling
  - validation-error
  - observability
  - trajectory
sources:
  - agent 847adea5
  - memory:project_request_payment_card_unsatisfiable_food_ordering
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

Prod agent `847adea5` (2026-07-24, "nopa fish… order now", rose-1-lite, MAC_APP) ran a
browser sub-agent ordering fish & chips on `order.toasttab.com`. It hung for about
1m40s with no visible progress, then reported "Task Incomplete - Max Steps Reached" and
logged "Max iterations reached: 50" — while the real iteration count was about 16, and
`request_payment_card` never appeared in the trajectory at all.

## Diagnosis

The tool-arg `ValidationError` is raised at **parse** time, inside
`_call_browser_use_with_rotation` → `browser_use.py:856 validate_browser_tool_args` →
`RequestPaymentCardBrowserTool.model_validate`, i.e. _before_ any browser action is
built. It propagated to the browser loop's catch-all `except Exception` at
`handler.py:5816` — the handler written for Rose **transport/infra** failures
(timeouts, 5xx).

That handler does four wrong things for a model-authored-args error: it emits **no
trajectory action** (so the failure is invisible), it does **not** append the error to
`browser_turn_messages` (so the model never learns why and re-emits the identical call),
it increments `consecutive_api_failures`, and it sleeps 2s and `continue`s. Five
identical failures later it `break`s at 5827, and the unconditional post-loop handler
(7132) logs the **hardcoded** "Max iterations reached: 50" and posts
"Task Incomplete - Max Steps Reached" (7233).

That fully explains both mysteries: why `request_payment_card` never showed in the
trajectory, and why the run reported max steps at nowhere near 50 steps.

## Solution

Route the error through the normal model-feedback path rather than the infra path.
Added a typed `BrowserToolArgsValidationError` in `browser_tools/schemas.py`, raised by
`validate_browser_tool_args` wrapping the Pydantic `ValidationError`;
`browser_use.py` attaches `thinking`; `handler.py` catches it in the loop **before** the
generic `except Exception` and calls a new
`_feed_browser_tool_validation_error_back()` which does `record_action`,
`_append_browser_turn_messages`, `save_browser_action_message` (a visible trajectory
row), resets `consecutive_api_failures = 0`, and continues. No new escape hatch — it
mirrors the existing auth-blocked branch and the main loop's `is_error` path
(`run_agent.py:1616/1683` `post_tool_error_message`).

Cemented by
`tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_payment_card_tool_args_raise_typed_validation_error`
and `::test_browser_tool_validation_error_feeds_back_through_normal_path`.

Verified live on the local toast bench (`browser-toast-nopa-write-lock`, agent
`3718bee3`, 2026-07-25): the trajectory now shows "Invalid request_payment_card
arguments — retrying" rows (steps 10, 13, …) and the model **self-corrects**, opening a
new tab toward a product-detail URL, instead of hanging silently and reporting a false
"Max Steps Reached".

## Human feedback

The user set the fix shape explicitly and rejected the alternative: a `ValidationError`
on the model's **own** tool args is a normal, model-fixable tool outcome, **not** a Rose
API failure — so no separate escape hatch; catch it at the parse boundary and return it
to the model as a tool-result observation with an ERROR-status trajectory action, exactly
as the main loop does. Only genuine transport/infra failures may touch
`consecutive_api_failures` or abort.

## Reusable lesson

Never let a model-authored-args validation error reach the transport-failure handler —
feed it back as a visible tool-result observation, or the model loops blind and the run
aborts under a false "max steps" label.
