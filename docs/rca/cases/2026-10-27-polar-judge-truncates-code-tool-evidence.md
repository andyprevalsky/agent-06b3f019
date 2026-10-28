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

## R3 recurrence: executed browser inputs and native observations

Polar iteration 6 BU022 run 2 root
`93c2b8f7-ffc1-4e83-9df2-ca1adcc6ba2a` at source
`4c6861dcd2a9aacf22e3937cea27fae904727349` failed C1 (2/3 total).
The external judge reported that later JavaScript results listed 2022 movies
without showing the applied filter parameters. The saved internal verifier raw
context contains actual action-history step 31: an executed browser evaluation
POSTed to `/discover/movie` with `primary_release_date.gte=2022-01-01` and
`primary_release_date.lte=2022-12-31`; its result includes HTTP 200 and movie rows.
This original verifier context is in the saved worker log, not reconstructed
from the final answer. The immutable failed fleet archive SHA256 is
`e1ceea5db3befe6fe45381374d2580756e73556dc0a54eac53f1512bfc9cff7d`.

The first missing-input boundary is browser success-message persistence: it
stores `result.message` but not the executed action parameters. Separately,
`build_polar_trajectory` ignores the already-persisted masked
`metadata.browser_observation`. The passing BU022 sibling instead retained a
filtered URL in completion text; that single pass does not prove causality or
that the failed task should pass. Both external evaluations had zero attached
screenshots. The failed internal verifier had a final screenshot, but the
persisted message did not carry it; this candidate does not invent or recover
missing historical images.

The evidence-transport repair records successful executed parameters through
the existing private persistence owner and includes those parameters and native
observations in Polar's full history. It preserves task criteria, filter
confirmation requirements, model, step budget, scoring and actor behavior.
A recorded POST alone is not proof that the requested advanced-search UI state
was applied and confirmed. Original BU022 FAIL remains authoritative; this
repair has no unchanged paid-task outcome proof.

The registered local reproduction executes the actual success-persistence AST
slice and supplies the result to all three actual Polar judge inputs. Corrected
baseline: two assertion failures and one privacy control pass. Candidate: all
three pass. The initial double raised TypeError on existing None metadata and
was withdrawn as invalid causal evidence; the corrected double matches the
serializer's existing optional-metadata behavior without changing assertions.
The judge double always returns failure, preventing score promotion. A separate
control executes actual persistence privacy owners with real DOM secret policy,
retains public year parameters, removes secret plaintext, and verifies metadata
does not duplicate code into parent planner tool text.

BU030 run 1 root `e44bbf5f-5a6c-46ed-a6aa-9facb8cc6205` is distinct: its internal
verifier explicitly accepts manually excluding old listings from Newest results.
The external C1 failure says the native last-seven-days filter is unconfirmed.
No general actor/prompt repair or changed criterion is justified by the evidence
transport regression. BU030 remains open. BU023 challenge handling is separate
R4, and BU025 TLS is separate I25. No original verdict was edited; no live browser,
paid rerun, provider/image/deploy/task/Freedom mutation was performed here.

Independent reviewer `ph74rex3pescaywbxyjn3njr158h3pp9` grounded final six-path
R3v3 patch SHA256
`b4bc34253046a0cb15cd26cb454b11c0623ed76d04a85f2bc1eaba4165f4ea4c`
before application. The reviewer independently ran the exact three controls
against the candidate (3 PASS) and restored only the original runtime files
(2 assertion FAIL, 1 PASS). Intermediate v2 approval was withdrawn after the
invalid initial baseline was identified; only final v3 was applied. This
appendix is truthful documentation added after protected patch review.
