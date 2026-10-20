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

Prod agent `847adea5` (2026-07-24, "nopa fish… order now", rose-1-flash, MAC_APP) ran a
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


## 2026-10-17 recurrence: completed browser decisions bypassed model-validation feedback

**Scope/status:** the original July repair and live proof above are preserved. This
recurrence is OPEN at the unchanged native-task outcome gate. The private candidate
has owning-boundary proof, not a native repair or class-elimination claim. It is
selected only for a later source batch; no active-source adoption is asserted here.

### Evidence and first bad boundary

On source `0a74e8d555c9f793360c5ca2c78f5950939ecc0a`, original30 case
`browser-auth-assistance-user-signs-in`, root
`6560323e-2fe4-47b5-a237-e0e92689bf99`, genuinely FAILED in 570.2 seconds.
Its declared evaluator observed parent spawn tool
`call_cYoWhNIoknO2M0vupy01SrSD` with ERROR. The accepted handoff, actual USER
sign-in, and final fresh-DOM/full-credit verifiers are counterevidence to an
all-judges-rejected account; they do not erase the tool failure. Terminal promotion
is outside this repair. The original verdict/deadlines/evaluator remain unchanged.

The retained worker sequence after resume contains four completed non-JSON/no-action
responses followed by one genuine empty stream. Completed normalization failures
fell through the generic API handler with no feedback to the next model call,
consumed the API-failure counter, and reached the misleading max-iterations exit.
`RoseClient.complete_browser_use` normalized before its normal dump, so the four
full rejected responses are absent from historical dumps. A retained 200-character
normalizer prefix supports the local fixture; historical full input/wire parity is
not claimed.

This extends the same July producer/consumer classification boundary: completed
model-output validation is not transport failure. The earlier typed-arguments catch
covered named schema-invalid calls, but not completed missing-action/unknown-native
normalization failures. General C+1 is model-decision validation continuity and
classification, not an authentication-specific instruction or semantic classifier.
That coherent class does not prove all other consumers or native failures repaired.

### Private repair and protocol discoveries

Private patch `candidate-protocol-v3.patch`, SHA256
`b793d55abc6eee08db46a9853294f35237a70ca4089ddf546ea7a750109f9135`,
is based on exact 0a source. A normalization-only completed-response carrier keeps
actual response/model/request/usage and writes the private dump before raising.
Existing typed-argument exceptions and real collection/transport errors retain
their separate identities. Public exception text is constant; detailed original
normalization diagnostics remain private dump data.

The activity accounts actual completed usage once, feeds rejected prose and real
provider call records back as privacy-projected, untrusted ASSISTANT data, resets
the API counter like existing argument validation, and continues. No tool call,
execution status, TOOL result, action receipt, attention, or completion is invented.
The notification fork uses a local transcript copy; original prompt/schema/attempts,
cache lineage and skip-cache-write remain. Historical aggregate fork accounting is
not claimed fixed or charged to the last successful model.

A predecessor's fixed SYSTEM feedback passed the collect-level seam but failed both
actual provider transformations: Anthropic and gpt_auth Responses lift SYSTEM and
strip trailing ASSISTANT prefill, deleting the rejected output. The same lower-body
assertion fails on that representation and passes on the final one. Per the explicit
parent protocol decision, the SINGLE fixed feedback constant now uses API user role:

> [Browser runtime output validation] The preceding completed model response did not contain a valid browser action. This is runtime validation feedback, not a user request. Return a valid action using the existing tools or supported action JSON. No action was executed.

API role is not durable human provenance. This adds no durable USER message,
user_instruction_messages/revision, requirement-source ID, goal, schema revision,
or authority grant. Rejected raw data never enters privileged SYSTEM text; generic
provider prefill stripping is unchanged. Opaque reasoning is excluded.

The July Human feedback controls counter semantics: completed invalid responses reset
API failures; only genuine transport/infra failures count toward the unchanged five
consecutive API abort and genuine two-second backoff. Every invalid decision already
consumes an iteration, so the unchanged MAX250 remains the bound. An earlier private
mixed-five draft was explicitly superseded: four invalid completions plus one empty
stream count as API1 and can reach a sixth valid action. No separate model-five
escape hatch, cap change, retry budget, forced tool_choice, evaluator exemption,
identity directive, fresh DOM injection or terminal promotion was introduced.

### Owning proof, attempts and limits

All evidence below is private under
`/home/boxes/rose/.context/auth-deploy/repair-native-original30-0a74e8d-20261017/human-signin-error-rca/output-validation-review/`.
`final-log-hashes.json`, `candidate-protocol-v3-hashes.json`, and
`protocol-v3-proof-hashes.json` bind exact source/log bytes. Existing native captures,
worker excerpts and capture-manifest remain at the parent `human-signin-error-rca`.

- Actual client -> real activity -> next decision: missing-feedback assertion RED
  before production edits, then GREEN. Unknown-native/content-empty actual pipeline
  independently fails predecessor feedback and passes serialized rejected-data repair.
  `native-only-before.log`, `native-only-after-v2.log` retain this intermediate proof;
  final selected proof is `protocol-v3-selected.log`.
- Actual notification-fork caller: `fork-before.log` FAIL -> `fork-after.log` PASS.
  `both-transform-proof.log` records actual Anthropic and Responses predecessor
  false/candidate true, with zero network attempts.
- Final full spawn owner: 801 PASS/0 FAIL in `full-owner-protocol-v3.log`.
  Full Rose owner in its own process: 99 PASS/0 FAIL, exit0,
  `client-isolated-protocol-v3.log`. Related handoff: 15 PASS/0 FAIL, exit0,
  `handoff-protocol-v3.log`. Original 3316 spawn and 434 Rose assertions remain;
  final counts are 3354 and 441 (`final-assertion-proof.json`). Peer source review
  scoped-accepted the exact final representation, not native effectiveness.
- Commands use the read-only donor physical venv Python and private overlay cwd:
  `/home/boxes/rose-auth-final-deploy/agents/venv/bin/python /home/boxes/rose/.context/auth-deploy/repair-native-original30-0a74e8d-20261017/human-signin-error-rca/output-validation-review/run-full.py`,
  `/home/boxes/rose-auth-final-deploy/agents/venv/bin/python /home/boxes/rose/.context/auth-deploy/repair-native-original30-0a74e8d-20261017/human-signin-error-rca/output-validation-review/run-client-isolated.py`, and
  `/home/boxes/rose-auth-final-deploy/agents/venv/bin/python /home/boxes/rose/.context/auth-deploy/repair-native-original30-0a74e8d-20261017/human-signin-error-rca/output-validation-review/run-handoff.py`.
  Exact scripts are preserved alongside logs; none dispatch models or native tasks.
- Selected controls and handoff observed zero socket attempts. The combined full
  launcher observed 15 denied attempts (including Rose); isolated Rose observed9
  denied attempts. All were blocked; zero transmitted is not zero attempted.
- Earlier setup failures remain: missing standard fake seam, root cwd versus relative
  fixture source paths, symlink-resolved dump paths, shared-process tracer context,
  and a wrapper dict-truthiness exit bug. Original combined FAIL logs are retained;
  separate-process Rose resolves the unbound-dump expectation without assertion edits.
  Initial pair rerun reused two log names; this is disclosed in the private checkpoint,
  not described as complete preservation of every overwritten intermediate log byte.

The new test function reflects counter reset, but a registration display label still
contains `mixed_invalid_outputs_and_transport_keep_five_failure_bound`. This is a
metadata naming note for a later batch, not a claim that the obsolete mixed-five
semantics or draft patch is selected. Frozen b793 bytes and proofs are unchanged.

### Archive search and outcome qualification

Re-read the original Solution/Human feedback and `docs/rca/process-feedback.md`.
Actual archive searches used `Browser tool response was not valid JSON` and
`model validation transport failure feedback consecutive API`; additional source
searches used completed-response/normalization and trailing-assistant/prefill terms.
July24 is the same classification/feedback recurrence; the synthetic extraction
AUTO case of April29 is a distinct owner and does not justify forcing browser tools.
No duplicate case is proposed. Keep original frontmatter/status/history untouched;
this append explicitly keeps current native task repair OPEN pending unchanged-task
verification. No new Step5b failed-coherence claim or all-class elimination is made.
