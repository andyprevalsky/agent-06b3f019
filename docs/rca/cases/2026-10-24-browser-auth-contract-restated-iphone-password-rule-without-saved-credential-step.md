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
status: mitigated
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

None recorded.

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
