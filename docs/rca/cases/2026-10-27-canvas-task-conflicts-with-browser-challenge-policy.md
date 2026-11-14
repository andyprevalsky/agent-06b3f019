---
id: 2026-10-27-canvas-task-conflicts-with-browser-challenge-policy
date: 2026-10-27
title: Canvas CAPTCHA task conflicts with the browser actor's no-solving policy
surface: agents
component: browser-authentication-contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/browser_auth_contract.py build_authentication_contract applies access-control recovery rules to explicitly requested nongating static-text practice content
symptoms:
  - polar-bu-002 r1
  - polar perfect-score failed (1/3 rubrics)
  - I cannot complete CAPTCHA verification on your behalf
  - task_completed=false
tags:
  - polar
  - browser-prompt
  - captcha
sources:
  - agent a1c2ef72-a3c0-4648-9729-cb373877e3e1
  - fleet run campaign-20261027-060019-631588
  - commit 35ae7f4a7e15dda8a41d093f3d778a5722c0e5c1
  - commit 0c96ea5a86edf9f3267e6a4edacf4870cf834bd0
repro: agents/tests/blackbox/rose_browser_use.blackbox.py test_practice_content_and_access_control_share_a_scoped_policy
status: open
---

## Problem

The exact task asks: Go to the URL and read the text from the canvas CAPTCHA
and enter it to complete the task.
https://browser-use.github.io/stress-tests/challenges/canvas-captcha.html

Campaign A r1 received 1/3: C1 and C2 fail, C3 passes. Its final structured
response reports CAPTCHA123 and task_completed=false. The captured browser
trajectory has no input_text or submission action. The judge's noncompletion
verdict is supported by that trajectory, despite the root's COMPLETED lifecycle.
Original compressed run SHA256:
2a82f83aea1d15a68f701487ffa737a79e438a7be773e7a63c6de2b6081abea6.

## Diagnosis

Path: task -> child browser goal -> authentication/system/tool contract ->
actor decision -> no submission -> truthful false completion output -> C1/C2 fail.
The captured first browser call (`browser_use_step_1`, dump 75c70982fbca)
contains an indexed text input, the user request to enter the CAPTCHA, and a
system instruction forbidding the actor to solve challenge widgets itself.
The actor selects recover_from_challenge with the reason that the task explicitly
requires CAPTCHA transcription and no alternate path can complete it.
A later captured call (`browser_use_step_4`, dump a71696c5c2a8) returns:
"I couldn’t submit the form or verify a result. The page remains on the CAPTCHA
challenge with the input empty. I can’t complete CAPTCHA verification on your behalf."

The source of that policy is agents/utils/browser_auth_contract.py and matching
screenshot/recovery tool descriptions in agents/providers/rose/browser_use.py.
Existing blackbox tests explicitly assert the no-solving directive. Thus this
is a concrete instruction conflict, not evidence of an underspecified task.
A parent-authorized local paired decision replay now reproduces the decision
boundary. Before the change, the original request selected
recover_from_challenge (6.974s, 8,067 input and 247 output tokens). With only the
reviewed system/tool description clarification changed, the same client,
same leased GPT credential, same GPT-6 Sol model, same non-system messages,
tool schemas, pool and generation settings selected screenshot (5.120s,
8,355 input and 34 output tokens). The original messages and tools rebuild
byte-for-byte on the old code. Request SHA256s for the paired run:
1b997f42fa572ce7a1b23a5472332149d02b4ab293f68c83a44c3f2adb9afe3c (before),
28e6e05ab3cffee3db118716461dab452227dac3bfcb74cb0d56eb3fbc009479 (after).
Both calls served gpt-6-sol-gpt through the direct GPT route; the lineage lease
was released. No browser action executed during this diagnostic. This is one
trial per condition, not a statistical or whole-task success claim, and not a
model-intelligence classification. Provider billed cost was not reported.
Original captured auth was a pooled GPT token; both replay conditions used the
same newly leased user GPT token, so credential identity is not a paired
variable but the historical credential itself was not replayed.

Siblings do not establish mere stochasticity: r2 succeeded only via a later
code-agent Playwright fallback, while r3's original browser also did not submit
and its later code-agent success suffered a separate evaluator truncation bug.
See 2026-10-27-polar-judge-truncates-code-tool-evidence. A pass on an alternate
path does not prove a task-definition flaw or repair the browser path.

Archive searches: `polar-bu-002 canvas captcha` and
`polar judge trajectory screenshots failure`. No exact-task case was found;
the CAPTCHA recovery and evaluator-evidence cases are relatives, not proven
recurrences. All three exact catalog objects match original source and current
0c96ea5a8 (canonical JSON SHA256
c4209f7fac08901aaec68bc4965b7576fa8592f20d9308dfe93f50e720ae1618).

## Solution

Add one shared exception to the existing CAPTCHA recovery policy, applied to
the browser system prompt and screenshot, recovery, and auth-assistance tool
descriptions (including recovery-disabled mode): only explicitly requested
public static-text/plain-arithmetic practice content that guards no page or
service is ordinary task content. Explicitly exclude behavioral, token, and
slider challenges. Preserve all existing recovery/prohibition wording,
provider recovery mechanics, model settings and budgets.

The deeper class is a recovery rule mistaking nongating text practice for
an incidental access-control blocker. A broader exception for all public
practice exercises was tried at design/review time and failed the reference
bound: behavioral/token/slider cases remain explicitly prohibited. It was
NOT_GROUNDED and never applied or replayed. The narrower static-text/arithmetic
class is the deepest supported class here; globally allowing user goals to
override access-control policy would contradict the deliberate policy and
has no supporting evidence. No runtime task-name, URL or keyword classifier
is introduced, and no task or rubric changed.

Opened references:
- recursive-hq/polar-evals@8d94585489911a3688193cb61462a3bc99654580,
  bu-bench-v1/judgements/36f4e2db-4387-4163-99c3-c221d63a9733.json:
  same task succeeds via read_page/form_input; impossible_task and
  reached_captcha are both false.
- browser-use/stress-tests@b3600b683ec97236866d77e31200fa24ec8c8f3f,
  challenges/canvas-captcha.html: local input handler at lines 247-251 only
  toggles practice completion; it guards no other service/page.
- NousResearch/hermes-agent@681346296cbf26f3e6a3f2cc81c756f41451cf70,
  optional-skills/security/unbroker/SKILL.md lines 176-180: static text and
  arithmetic are distinguished from prohibited behavioral/token/slider
  challenges. Our additional nongating/public-practice/explicit-request
  conditions narrow that type bound.
- browser-use/benchmark@77b4df339fe8fc293fb48896cfa1c73dd743af42,
  frameworks/browser_use/run_task.py: preserves task and vision into the
  browser agent. Its Codex harness prompts preserve native browser execution.

Independent reviewer ph7dr4b0p5nc2qjtnfhtgsqpmx8h2zq6 rejected broad snapshot
744e1aaa3dbb5673f34608f09b016547b96730b533d87e17c76509df4eedda41,
then returned GROUNDED for narrow snapshot
c957b155cbed4213ae62a484e22ca789e40b1b093f703dcdc044845e2862ef3d.
Runtime was applied only after that verdict; exact file hashes were checked.

Permanent protocol regression is registered in the existing rose-browser-use
blackbox domain. Identical command before/after:
`PYTHONPATH=agents:agents/tests/blackbox agents/venv/bin/python -m pytest --import-mode=importlib -q agents/tests/blackbox/rose_browser_use.blackbox.py -k practice_content_and_access_control_share_a_scoped_policy`.
Before: 1 failed, 117 deselected (0.49s), scope absent from constructed prompt.
After: 1 passed, 117 deselected (0.44s). Five repeat calls also pass. Both
recovery modes preserve the original task and native actions while exposing
the same scoped exception; access-control prohibitions remain.

Full domain run initially passed 117 tests and failed the phone-off golden
byte pin, which intentionally pinned the pre-change prompt. Its five live
synthetic native-AutoFill controls unexpectedly ran and passed (34,730 input,
2,033 output tokens, API cost unreported); no phone/device action was executed.
The process had already finished when an exact-owned stop was attempted.
The expected-byte test is explicitly re-pinned only for the reviewed shared
policy reaching both phone modes. Independent reviewer ph7dr4b0p5nc2qjtnfhtgsqpmx8h2zq6 returned GROUNDED
for extended snapshot ef83763bc3dd512958419323980d34dd8bdebfddef9ce0708006eaf8ae8b9291,
recomputing all six old and new golden values; runtime bytes are unchanged. With that re-pin, the
117 offline tests pass in 3.03s and the shared identity/auth invariant passes.
The already-passed live controls were not repeated. This is an honest composite
verification record, not a second full-domain run claim.

The added text is constant per request (288 additional input tokens observed
in this captured decision). At 10,000 agents it adds no shared state, locks,
pollers or network calls; only per-browser-step prompt input increases. No
production incidence estimate is available. Existing actual-interstitial
behavior, schema and provider settings remain unchanged.

Status remains open for parent-owned exact unchanged-task outcome proof.
Screenshot selection is necessary progress, not proof of text entry or task
completion. Campaign's unfixed r2 pass means at least three passing unchanged
outcome copies are required under /descend. No cloud benchmark or deployment
was launched in this lane.

## Human feedback

The user prohibited task edits and required independent cross-review proving
any claimed definition flaw, not pass-rate variation. The parent expanded the
scope to r3 and required the no-browser cluster to remain separate. Later the
parent explicitly continued r1 as R2c and authorized one local before/after
LLM diagnostic, only after independent strong review. The first overly broad
exception was rejected; the static-text/arithmetic type bound was mandatory.

## Reusable lesson

Compare the captured actor policy with the exact task before attributing a truthful noncompletion verdict to model randomness or a faulty task definition.
