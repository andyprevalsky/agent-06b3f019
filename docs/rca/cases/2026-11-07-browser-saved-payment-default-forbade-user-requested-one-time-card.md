---
id: 2026-11-07-browser-saved-payment-default-forbade-user-requested-one-time-card
date: 2026-11-07
title: Browser skipped request_payment_card at checkout because the saved-payment default forbade a one-time card the user had asked for
surface: agents
component: browser-payment-card-entry-rule
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_crypto.py PAYMENT_CARD_ENTRY_RULE and agents/providers/rose/browser_use.py BROWSER_USE_TOOLS["request_payment_card"].description stated "If a valid saved payment method is already selected and no card entry is required, do not call request_payment_card; continue with that saved method." with no user exception, contradicting a goal that asked for request_payment_card and forbade the saved method
symptoms:
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "The payment tool instructions prohibit requesting a new card when a valid saved method is already selected. The user forbids using that saved method, so no payment or order can proceed."
  - "No request_payment_card invocation occurred. Checkout has Visa ending 9616, expiring 07/2031, selected (aria-checked=true), and does not require new card entry."
  - browser attempt_completion at checkout with a saved card preselected; verifier 50% x3 for missing payment-request evidence; Timeout after 1802s
  - anti-bot-doordash-store FAILED approvals_triggered=0 agent_status=PAUSED
tags:
  - request-payment-card
  - saved-payment-method
  - payment-approval
  - checkout
  - browser-prompt
  - doordash
sources:
  - agent b6557506-113e-48cb-aa81-36fcfdc7d7dd (descend batch3-epoch16 r1, source 005f823662)
  - agent d52f03de-2904-495b-a516-6502a684f220 (same epoch r2; first completed without a request, called it only after verifier feedback)
  - commit 85712e6550 (introduced the unconditional saved-method rule, 2026-07-21)
  - fleet run 20261107-070314-1595094 (descend-launch-e16 anti-bot-doordash-store r1)
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_saved_payment_method_default_yields_to_user_one_time_card_request (contract); real-LLM exact replay of trace-archive dump llm/3235e82a4a2e (browser_use_step_27) for causal proof
status: open
---

## Problem

`anti-bot-doordash-store` (descend batch3-epoch16 r1, agent b6557506, source
005f823662) reached a real DoorDash checkout by 07:39Z: 7-Eleven, one
"24/7 LIFE Type-C to Type-C Cable (6 ft)", saved San Francisco address,
$36.85 total. DoorDash had the saved "Visa....9616 Exp. 07/2031" selected
by default. The task prompt says to call request_payment_card for this order
and not to use a saved payment method. The browser opened and closed "Add New
Card", never called request_payment_card, and called attempt_completion three
times. The verifier gave 50% each time because the payment request was
missing. At step 48 the browser wrote its own explanation into an evaluate
payload: "The payment tool instructions prohibit requesting a new card when a
valid saved method is already selected. The user forbids using that saved
method, so no payment or order can proceed." The harness paused the browser
at the 1800 s timeout and no payment_approval was raised.

Safety: no order was placed and no money was committed. All 15 clicks have
"Write lock click check" rows and none of them is Place Order. All 5 evaluate
scripts only read the page. The network capture has no order-creation call
and no /orders/ page, approvals_triggered=0, and payment cleanup shows no
purchases. The purchase write lock was never reached.

## Diagnosis

Critical path: task goal → browser system context "## Payment Authorization"
(handler.py builds it from PAYMENT_CARD_ENTRY_RULE) plus the request_payment_card
tool description → browser LLM decision at checkout → request_payment_card →
payment_approval attention.

The first bad data is LLM-visible harness text. The captured decisive call
(trace archive llm/3235e82a4a2e, browser_use_step_27, gpt-6.1-sol xhigh via
gptAuth, 96 messages, 27 tools) contains two harness copies of the rule:
"Use request_payment_card only if checkout requires you to enter new card
details. If a valid saved payment method is already selected and no card entry
is required, do not call request_payment_card; continue with that saved
method." The user goal in the same call says "invoke request_payment_card ...
Do not enter card details, use any saved payment method ...". With a saved card
preselected, the harness forbids the one thing the user requires and requires
the one thing the user forbids. The model obeyed both prohibitions and did
nothing.

Copy r2 in the same epoch (agent d52f03de) hit the same state. It also first
called attempt_completion without a request and only called
request_payment_card after verifier feedback. r2 then failed on a separate
Steel checkpoint error.

Step 5a ladder:
1. The browser skipped the card request. Cause: two harness surfaces forbid
   it whenever a saved method is selected.
2. Why could they forbid it against the user? Commit 85712e6550 wrote the
   saved-method default as an unconditional rule with no user exception.
   That default is intended product behavior (process-feedback 28: live
   purchases use the on-file method and get approval at run time).
3. Stop. The next "why" is the general instruction-precedence design. That
   rung fails coherence (see Step 5b).

Step 5b climb:
- Class stopped at: an overridable harness default (use the saved payment
  method) is stated as an unconditional prohibition, so it overrides an
  explicit user payment-method choice.
- Next-deeper class tried: no harness tool-usage default in the browser prompt
  states its precedence relative to explicit user instructions. The proposed
  fix was one global "user instructions override defaults" clause.
- Why it fails coherence: the same prompt mixes defaults with safety
  invariants that the task text must not override, such as write-lock
  approvals, never typing stored card details, and never asking the user to
  type a card. A blanket precedence clause would let goal text override those
  invariants. Whether a rule can be overridden is a property of each rule, so
  the carve-out belongs on the default itself.

Proof (exact replay of the captured call through the same local client path,
using scripts/replicate_llm_dump.py exact mode via
.context/rca-H-49/replay_trials.py, with a gptAuth lease from the
production backend). Pre-fix: request_payment_card in 0 of 5 trials. Four
trials chose attempt_completion, which matches the original, and one
fell through to the Foundry transport and chose read_browser_state. Post-fix
result: recorded below.

H-38 (request_payment_card product_url/line_items contract) is not involved:
the tool was never invoked in r1, so no receipt was validated or rejected.
H-30 (purchase write lock) is not involved: no purchase control was clicked.

## Solution

The fix is on branch rca/h-49-20261107. It still needs approval because it
changes LLM-visible prompt and tool-description text. Both surfaces now
state the user exception before the saved-method default:

- PAYMENT_CARD_ENTRY_RULE: "Use request_payment_card when checkout requires
  you to enter new card details, or when the user asked for a one-time card or
  told you not to use a saved payment method. Otherwise, if a valid saved
  payment method is already selected and no card entry is required, do not call
  request_payment_card; continue with that saved method."
- request_payment_card tool description: the same exception, followed by the
  unchanged receipt requirements.

The default behavior is unchanged: a saved method is still used when the user
expressed no preference, and the purchase write lock still gates Place Order.
The rule is not a classifier and does no runtime injection. It also covers
sibling cases, such as any merchant that preselects a saved card or wallet
for a user who asked for a one-time card. 10k-agent behavior: constant text,
no added calls, state or fan-in.

Regression: test_saved_payment_method_default_yields_to_user_one_time_card_request
in agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py. It fails on
005f823662/7555a20d05 (AssertionError: "only if checkout requires" still in
the rule) and passes on the fix. The stale text assertions in
test_build_autopay_prompt_section and
test_build_browser_use_tools_preserves_catalog_descriptions now pin the new
wording. Outcome proof (the exact unchanged anti-bot-doordash-store run
passing) is still pending, so the status remains open.

Golden reference: claude-code-src/src/tools/BashTool/prompt.ts:94 ("NEVER
commit changes unless the user explicitly asks you to") and
codex/codex-rs/skills/src/assets/samples/imagegen/references/cli.md:62 ("ask
first unless the user explicitly requested gpt-image-1.5") both state a tool
default with an explicit carve-out for the user's request.
codex/codex-rs/core/gpt_5_2_prompt.md:26 gives direct user instructions
precedence over lower-priority guidance. The fix follows that pattern.

## Human feedback

None recorded.

## Reusable lesson

When a harness tool default can conflict with what the user explicitly asked for, write the user exception into that default; an unconditional "do not call" leaves the model unable to satisfy either instruction.
