---
id: 2026-10-24-browser-auth-contract-restated-iphone-password-rule-without-saved-credential-step
date: 2026-10-24
title: Browser auth contract restated a partial iPhone password rule, so the model intermittently skipped credentials.fill_saved and asked the user
surface: agents
component: browser-use system prompt (providers/rose/browser_use.py build_browser_authentication_contract)
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/browser_use.py build_browser_authentication_contract — "For targetKind=iphone … request help only for a blocking password" competes with PHONE_GUIDANCE's "credentials.fill_saved once BEFORE requesting password assistance"
symptoms:
  - "native_autofill_real_model_controls: [\"('server_available', {'action': 'request_user_assistance_for_authentication'"
  - "rose-browser-use FAIL (116 passed, 1 failed)"
  - browser agent asks the user for an iPhone password instead of trying credentials.fill_saved
tags:
  - rose-browser-use
  - phone
  - native-autofill
  - prompt-conflict
  - flaky-live-model
sources:
  - fleet run descend-full69-20261023 cluster R12 (R4 5x gate runs 2-3; base 2/4)
repro: agents/tests/blackbox/rose_browser_use.blackbox.py::test_native_autofill_real_model_synthetic_controls
status: fixed
---

## Problem

`native_autofill_real_model_controls` (rose-browser-use blackbox) failed
intermittently: 2/5 on the R4 fix and 2/4 on base code. Every failure was the
same scenario. On the `server_available` screen ("Native AutoFill reports: No
saved passwords found … Password required to continue"), the real model called
`request_user_assistance_for_authentication(iphone, password)` instead of
`credentials.fill_saved`.

## Diagnosis

Every failure carries a complete model decision, so timeouts, the DTO
subprocess and memory pressure are excluded (the watchdog TERMs don't line up
with the failures).

On the identical request (gpt-5.6-luna on Foundry, at the wire's actual
`reasoning.effort: low`), base code chose ask-for-help 14/40, `fill_saved`
21/40 and `screen.text` 5/40. A/B tests, changing one variable each at n=20:

- removing the browser auth contract's iPhone sentence: 1/20 ask;
- `identityVerified: true`: 5/20;
- removing the "Private password refs … not available yet" sentence: 6/20;
- the fix wording (defer to the Cloud iPhone skill): 0/20, then 2/40 through
  the real code;
- also deferring the tool description to the skill: 10/40, worse (its
  explicit iPhone list helps);
- medium effort with the fix: 1/20, so effort is not a factor.

The browser system prompt restated the iPhone rule as "request help only for
a blocking password". That omits the saved-credential waterfall precondition
that PHONE_GUIDANCE requires, and the screen literally shows a blocking
password.

Step 5b: I stopped at the class "two prompt layers state the same
authentication rule with divergent preconditions; the shorter one wins
intermittently". The next-deeper class I tried was "any rule restated across
prompt layers", fixed by structurally forbidding restatement. It is not
coherent: the tool-description restatement measurably helps (removing it went
from 2/40 to 10/40), so restatement itself isn't the defect; divergence is.

## Solution

The browser authentication contract now says "For targetKind=iPhone, follow
the Cloud iPhone skill's authentication rules instead". It no longer restates
a partial rule. The tool description is unchanged. On the identical request,
ask-for-help dropped from 35% to 5%. A residual ~5% of model nondeterminism
remains on this adversarial screen, so the 5× gate is not guaranteed green
(4/5 in the first post-fix run).

At 10k agents: a prompt-text change only, with no runtime cost.

## Human feedback

On 2026-10-29 the user directed the deployment owner to fix the remaining browser failure; it was not waived.

## Reusable lesson

When a live-model control flips between two tools, A/B each competing instruction on the exact request at n≥20 before editing; remove the restatement whose preconditions diverge from the owning skill, but keep restatements that measure as helpful.

## Recurrence observed during PR1634 deployment

On 2026-10-29 at00:29:48 UTC, the unchanged native saved-credential control
again received request_user_assistance_for_authentication(iphone, password)
on the server_available scenario from gpt-5.6-luna-foundry. The full
rose-browser-use domain reported116 passed and1 failed. The captured request
still included the existing mitigation. This is evidence that the documented
residual behavior remains, not a new fix or an infrastructure timeout.

Evidence: /var/tmp/rose-final-agents-coverage-verified.log and
.context/test-runs/agents-coverage-20261029-002931-1793374/rose-browser-use.log.
No assertion, scenario, timeout, browser default, or approval gate was changed;
the failed run is retained and blocks deployment without a valid gate override.


## Conditional second-decision reproduction and repair, 2026-10-29

The recurrence was reconstructed from the exact second request in
`.llm-dumps/unbound/1793233788329-8dc6f9d14bbd-test-native-autofill-server_available.json`.
The first decision had legitimately requested `screen.text`; the failure occurred
when the model then chose password assistance instead of the available backend
saved-credential operation. The earlier aggregate 5% estimate did not measure
this conditioned request.

On merged source `9a6e1b39d`, replay through `RoseClient.collect` with the same
messages, tool schemas, actual `gpt-5.6-luna-foundry`, default low effort,
2048-token limit, temperature 0.3, and local backend cooldown authority produced:

- Baseline: 11 premature password-help choices, eight saved-credential attempts,
  and one further screen read out of 20 calls.
- Correcting only the tool's missing escalation prerequisites: two premature
  help choices, 17 credential attempts, and one read out of 20.
- Correcting only the stale capability statement: five premature help choices,
  12 credential attempts, and three reads out of 20.
- Both corrections: zero premature help choices, 36 credential attempts, and
  four reads out of 40. Reads are not counted as completed credential fills.

The two remaining contradictory surfaces were the native assistance tool's
partial blocking-password rule and the owning phone guide's obsolete statement
that verified app/account binding was unavailable. The backend already performs
current-form/account binding inside `credentials.fill_saved`. The candidate
clarifies that capability and completes the existing tool prerequisite; it adds
no classifier, forced action, fallback, model change, or new runtime state.

The next-deeper class considered was all duplicated tool/skill instructions.
Removing all restatements is not coherent: invocation constraints and task
procedures have distinct scopes, and the earlier measured removal worsened
behavior. The repair instead aligns capability and escalation prerequisites
across those existing scopes.

The delivery-contract regression failed before the production change and passed
afterward. The permanent live control now also includes the captured prior read;
the original five scenarios and credential-fill assertion are retained. An
unchanged five-run command failed before the repair on both original
`server_available` and the captured-read scenario. Afterward it completed five
runs without assertion failures. The full owning browser domain then passed117/117. Independent review
`browser-contract-20261029` returned GROUNDED for candidate SHA256
`a310aa7e04c5b8e2bc092f0f43e6520391f903e7b26e6a3d149f3ce8a15ba51a`
with no blocking findings; whole-release gates remain separate.

Evidence: `.context/pr1634-browser-rca/` contains original/variant wire captures,
individual response metadata, `contract-before.log`, `contract-after.log`,
`control-before-five.log`, `control-after-five.log`, `candidate.patch`, and the
reference findings. The first attempt without a running local cooldown authority
is retained and excluded from the valid experiment counts.

Reference verification: `hermes-agent/tools/browser_vault_tool.py:589-601`
requires saved-credential lookup first; lines621-630 bind and resolve the secret
server-side; lines645-654 ask for protected user entry only after no saved item.
This is a credential-specific analog for both corrected rules, with browser
origin binding rather than Rose's native current-form/account binding.
