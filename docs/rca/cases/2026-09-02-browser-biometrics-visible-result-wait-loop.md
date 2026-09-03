---
id: 2026-09-02-browser-biometrics-visible-result-wait-loop
date: 2026-09-02
title: Browser agent waits out the 420s cap after already stating the FCaptcha score
surface: agents
component: spawn-browser-agent-v3 / visible_result_completion
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py live action loop — executes post-submit wait after reasoning already stated risk score + verdict"
symptoms:
  - browser-biometrics-webdecoy smoke timeout / PAUSED at 426s / cap 420s
  - last assistant: "Let me try submitting the form one more time."
  - wait 5–10s repeated after "risk score of 0.07" + "Bot detected - form blocked"
  - drag TypeError and unknown-action-drag fixes held
tags:
  - browser
  - smoke
  - biometrics
  - wait-loop
  - fcaptcha
sources:
  - agent c3762be3-59be-4aa4-af6c-83d8eed9aeb9
  - PR #1209
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_visible_result_completion_rewrites_post_submit_wait
status: fixed
---

## Problem

Pre-deploy smoke `browser-biometrics-webdecoy` timed out at 425.9s / cap 420s
with agent `c3762be3` PAUSED. The drag `record_action` tuple fix held — clicks
and submits succeeded. The browser agent already saw checkbox Verified, typed
the form, submitted, and stated `risk score of "0.07"` plus
`Bot detected - form blocked` / `pow_not_satisfied`. It then issued
wait 6s / 8s / 6s / 10s / 6s and two more submits instead of `attempt_completion`.
The harness paused the still-open `spawn_browser_agent` activity.

## Diagnosis

Archive search: `browser-biometrics-webdecoy timeout pow_not_satisfied risk score wait`
and `Bot detected form blocked FCaptcha`. Prior 2026-09-02 cases are
unknown-action-drag and record_action-tuple. Those `first_bad_boundary`s are
not this one — no TypeError, no missing drag dispatch.

Critical path: goal asks to return the visible score and verdict → LLM states
both after the first submit → next tool is `wait` → handler executes the wait
→ more waits/submits → 420s PAUSE. Verifier never ran because
`attempt_completion` was never called.

Owning-boundary repro: `should_force_visible_result_completion(wait, stated
score+verdict, prior Submit click)` is True on the new helper; without the
rewrite the live loop keeps sleeping.

## Solution

Rewrite a post-submit `wait` into `attempt_completion` when prior reasoning
already states the visible FCaptcha score and verdict. Do not raise the 420s
smoke cap. Cement
`test_visible_result_completion_rewrites_post_submit_wait` and the negative
cases (no submit yet, non-wait action, no score).

## Human feedback

None recorded.

## Reusable lesson

Once the agent has already written the user-requested visible result, an idle
`wait` is budget burn, not progress. Force completion at that boundary instead
of hoping the model stops retrying a third-party proof-of-work.
