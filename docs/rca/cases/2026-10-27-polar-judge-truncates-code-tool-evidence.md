---
id: 2026-10-27-polar-judge-truncates-code-tool-evidence
date: 2026-10-27
title: Polar judge drops successful code-agent browser evidence after 4000 characters
surface: harness
component: polar-evaluator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/polar_evaluator.py build_polar_trajectory truncates each tool message at 4000 characters
symptoms:
  - polar-bu-002 r3
  - polar perfect-score failed (0/3 rubrics)
  - The fallback Playwright command failed with exit code 127
  - no successful entry, submission, or page confirmation
tags:
  - polar
  - evaluator
  - evidence-truncation
  - code-agent
sources:
  - agent 220e777f-2846-438c-a9c7-4f7afd83c7d3
  - fleet run campaign-20261027-060019-631588
  - commit 35ae7f4a7e15dda8a41d093f3d778a5722c0e5c1
  - commit 0c96ea5a86edf9f3267e6a4edacf4870cf834bd0
repro: agents/tests/blackbox/benchmark.blackbox.py test_polar_judge_preserves_full_tool_evidence
status: open
---

## Problem

Campaign A's polar-bu-002 r3 was graded 0/3. C1 says the fallback
Playwright command failed with exit code 127 and no successful entry or page
confirmation appeared. The original code-agent SDK event (seq 62,
exec-016cfcff-e7d7-4c90-87e0-33135fb780d6, 2026-10-27T07:05:26.860Z) instead
contains the command's stdout: `taskClass: task completed`,
`successClass: success-message show`, `enteredValue: CAPTCHA123`, and the page's
success message. The final exit code 127 belongs to the later shell command
`file /tmp/canvas-captcha-success.png`, which was not installed. The completed
Playwright program precedes that command. The recorded browser success is not
inferred from the assistant's completion claim.

The original full run compressed SHA256 is
8be8eb799e70ba9afcd38026f393dc665976a85393edf7f538aaee4a691e66b4.
The regression fixture preserves the original SDK tool text, which is 43,887
characters. The exact task object equals both the original execution source
35ae7f4a7 and investigation source 0c96ea5a8; canonical JSON SHA256 is
c4209f7fac08901aaec68bc4965b7576fa8592f20d9308dfe93f50e720ae1618.
Task, rubrics, threshold, and fixtures are unchanged.

## Diagnosis

Path: successful Playwright stdout -> persisted code_agent_sdk_events message
-> build_polar_trajectory -> one judge request per rubric -> 0/3 verdict.
The first bad boundary is the per-tool 4,000-character truncation in the
Polar evidence builder. The success-bearing SDK event begins beyond character
32,000. The projected single-message history is only 4,054 characters.
The code-agent shell failure summary survives elsewhere as a short message,
while the successful stdout does not. This explains the judge's stated
missing-evidence premise; it does not prove a corrected semantic verdict.

An offline local reproduction ran against unmodified production code:
`PYTHONPATH=agents:agents/tests/blackbox agents/venv/bin/python -m pytest --import-mode=importlib --asyncio-mode=auto -q agents/tests/blackbox/benchmark.blackbox.py -k polar_judge_preserves_full_tool_evidence`.
It invokes the checked-in blackbox regression and the actual evaluator builder
through `run_polar_evaluator`, capturing all three judge inputs. It failed with
`AssertionError: Polar judge lost captured tool evidence`. The judge double
always returns failure, so this control establishes evidence transport only.
It is not an unchanged-task outcome pass or a live judge replay.

The deepest proven cause is a lossful projection violating the Polar full
trajectory contract, not provider errors, lack of browser success, or evidence
that the benchmark definition is wrong. All three copies had zero screenshots;
that separate coverage gap is not needed to reproduce this truncation.

Archive searches: `polar-bu-002 canvas captcha` and
`polar judge trajectory screenshots failure`. No exact-task case was found.
The superseded 2026-08-21-declared-evaluator-evidence-omits-browser-a11y-text
case is a relative, not this cause; its proposed producer change was rejected.

## Solution

Applied: remove the per-tool text clipping in the isolated Polar builder;
preserve complete tool evidence for every rubric. No production edit was
applied before independent strong grounding review. Exact source reference:
Odysseys commit 837814633ef948479abb3d142458f0acdb73fa65,
`scripts/python/run_full_trajectory_per_rubric.py` lines 178-187 and 211-228:
it joins complete action/response strings and includes the full history in the
judge request. Retrieved file SHA256:
736c3c20a6d1d00d6fa1ffb34ae2b7c7835618bea0fe735bab99d036ee26983f.

This fixes the class of successful or failed tool output being omitted after
long setup output, including code-agent SDK event bundles. It adds no provider
calls, retries, task exceptions, or threshold changes. Input memory/tokens grow
linearly with the actual evidence; provider input limits remain a real risk and
must not be silently masked. There is no new shared state or per-agent polling
at 10,000 agents; only Polar benchmark judging changes.

Independent reviewer ph7dr4b0p5nc2qjtnfhtgsqpmx8h2zq6 returned GROUNDED for
snapshot fb257837e581f36899d179e420b1d8195441b2fee255b238c1d109f46fb378e5;
the parent authorized application of that exact snapshot. All three reviewed
file hashes matched after application. The identical pytest command was then
run on both revisions: red 1 failed (0.86s), green 1 passed (0.41s), 582 tests
deselected on each. The focused regression also passed five consecutive calls.
Polar evaluator/catalog suites: 17 passed (1.22s). The regression is explicitly
registered in benchmark.blackbox.py run_all_tests, discovered by the normal
blackbox domain runner used by run-coverage.sh. The full benchmark domain was
not run; it contains live funded judge tests outside this offline validation.

Status remains open solely for the parent-owned unchanged-task outcome proof,
not the now-proven evidence-preservation mechanism. The local attempt ledger
contains no polar-bu-002 attempts, but this campaign's unchanged-code r2 already
passed, so /descend requires at least three successful outcome copies, not the
ledger-only suggestion of one. A regrade of the captured r3 trajectory would
also test the exact evaluator failure without claiming a fresh actor pass.
No paid cloud benchmark or deployment was launched by this investigator.

## Human feedback

The user required no task changes, exact-source work, strong opened-reference
grounding before applying harness candidates, independent cross-review for a
task-definition proposal, and coordination before paid cloud runs or deployment.
The parent requested that r3 be included and kept separate from r1's prompt
conflict and the independent no-browser cluster.

## Reusable lesson

Preserve complete recorded tool output in a full-trajectory evaluator before judging absence of successful action evidence.
