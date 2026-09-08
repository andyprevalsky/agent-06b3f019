---
id: 2026-09-02-browser-biometrics-visible-result-wait-loop
date: 2026-09-02
title: Browser agent waits out the 420s cap after already stating the FCaptcha score
surface: agents
component: spawn-browser-agent-v3 / visible_result_completion
classification: our-bug
problem_class: model-intelligence-limitation
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/visible_result_completion.py should_force_visible_result_completion — ignored post-submit evaluate/tool-result text that already contained the visible score + form verdict"
symptoms:
  - Timeout after 420s (dynamic cap=420s) | Agent status: PAUSED (expected COMPLETED)
  - last assistant: "The challenge is fetched with difficulty 4 and minAgeMs 1500"
  - evaluate "0.15" / "Risk Score" / "Bot detected - form blocked" / pow_not_satisfied
  - wait 5–10s after visible FCaptcha score instead of attempt_completion
  - last assistant: "Let me try submitting the form one more time."
tags:
  - browser
  - smoke
  - biometrics
  - wait-loop
  - fcaptcha
sources:
  - agent c3762be3-59be-4aa4-af6c-83d8eed9aeb9
  - PR #1209
  - agent 15a85ea0-46e4-429b-ae37-d75514b0cd97
  - agent 9dc6b7e4-eee9-4ed9-8502-ed43531471cf
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_visible_result_completion_rewrites_wait_when_evaluate_already_has_score
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

## Recurrence 2026-09-08 (agent 15a85ea0)

Same smoke task, serial exclusive fixture (not the 2026-09-07 contention
case). No take-control / USER_REQUESTED. LLM path was claudeAuth
`claude-fable-5-claude`, not waterfall/credits.

Evaluate at 16:56:05 already returned visible `0.15` / `Risk Score` /
`Bot detected - form blocked` / `pow_not_satisfied`. Reasoning then said
"wait longer for PoW" (verdict words, no "risk score") and burned the rest
of the 420s cap on wait/resubmit/`read_network_requests`. The 2026-09-02
guardrail missed it because it only scanned LLM reasoning, not post-submit
action-entry tool results, and did not treat network/log inspection as idle.

Owning-boundary repro:
`test_visible_result_completion_rewrites_wait_when_evaluate_already_has_score`
failed on `wait` before the tool-result scan and passed after.

## Recurrence 2026-09-08 (agent 9dc6b7e4)

Same smoke task on HEAD `50dd6f349` after CodeRabbit tightened score matching
to require the words `risk score` / `fcaptcha` / JSON `"score"`. After Submit
the model said `a score "0.07" appeared` and then scrolled. Observation dumps
correctly stayed strict; the reasoning path no longer rewrote scroll because
it omitted the word `risk`. The earlier guardrail failed to hold because the
review-cycle tightening over-constrained the LLM-visible phrasing.

Owning-boundary repro:
`test_visible_result_completion_rewrites_post_submit_score_without_verdict`
now uses that exact `a score "0.07" appeared` sentence. Observation still
rejects the same phrasing without a labeled/JSON score. The relaxed
reasoning path also accepts bound scores `0` / `1` / `1.0` next to `score`
and still rejects `score v1.0`.

## Recurrence 2026-09-08 (CodeRabbit 3961783563)

`_normalize_history_blob` turns `\\n` into real newlines, but
`_FCAPTCHA_SCORE_RE` used `.*` without `re.DOTALL`. An evaluate dump
`Bot detected\\nFCaptcha\\nScore: 0.15` therefore failed the labeled
observation check. Reasoning still matched via the relaxed `score` +
unit-interval path; observation did not. Enable `re.DOTALL` so the
existing FCaptcha/Score label pair works across adjacent lines. Cemented
in `test_visible_result_completion_ignores_post_submit_version_decimal_without_score`.

## Recurrence 2026-09-08 (CodeRabbit 3962052511)

Independent label + `0.xx` matching treated static `Risk Score` chrome plus
`threshold 0.15` as a visible result. Observation now requires the
unit-interval next to `Risk Score` or `FCaptcha`+`Score`, or a JSON
`score` field. Reasoning stays relaxed.

## Reusable lesson

Once the visible score and form verdict are already on the page — in
reasoning or a post-submit tool result — an idle wait or network inspect
is budget burn, not progress. Force completion at that boundary instead
of hoping the model stops retrying a third-party proof-of-work.
