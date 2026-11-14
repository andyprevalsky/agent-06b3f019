---
id: 2026-10-28-it9-bu023-archived-evidence-temporal-completion-open
date: 2026-10-28
title: It9 BU023 discloses historical assets but receives different temporal-completion judgments
surface: harness
component: polar-evaluator
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Live challenge leads to disclosed historical substitution; original C1 judgments differ across distinct archived inputs, with no proved local repair
symptoms:
  - "The live Pngtree Text Effect page remained behind Cloudflare"
  - "a November 2023 Wayback snapshot"
  - "not the current live listing"
tags:
  - polar-bu-023
  - r21
  - it9
  - historical-substitution
sources:
  - commit 339894f88c95837c608b74c7a394ebc6fd338c6f
  - agent e6527625-7835-418c-8750-f67922fe19a5
  - agent 833d7206-d49e-412f-a7e0-0fbe52706d0c
  - fleet run 20261028-080447-19700
  - fleet run 20261028-080447-19636
repro: Exact original final-verifier TOOL_RESULT projection for both runs; no model or task replay
status: open
---

## Problem

R21 covers only It9 BU023 run2 root e6527625-7835-418c-8750-f67922fe19a5,
fleet20261028-080447-19700, and named run1 comparison root
833d7206-d49e-412f-a7e0-0fbe52706d0c, fleet20261028-080447-19636.
The task asks to browse Pngtree's Text Effect section and note the file formats
(PNG) offered in its first10 assets. Neither the task nor this investigation
is rewritten to demand or permit a particular historical date.

The exact normal archive SHA256 is
49df9b9e07a20de9e0e229815ad414e35dc436672011ee55ec3f42bcd64c02d0,
129940574 bytes. Both source receipts bind base_sha
339894f88c95837c608b74c7a394ebc6fd338c6f with workspace_patch_sha256=none.
Runtime-evidence manifest checks match:

- Run2 run.jsonadd1d834def2b4cdbbf5add06bb6c452eaab01873dd92a224ba7852391bfb709;
  worker92168960819b0ad575ccde08d0f842382875ba04ed7dd2366d911471c903b889.
- Run1 run.json31bb97de650921ff149e5a7a5fe1807a5d02ac815a6b82f1b3d496fc9434af04;
  worker966315472aa3dcdd557b8c4e43a4e69f26c310037921adb6804331f323693aa6.

Original run2 taskFAIL scores2/3; run1 taskPASS scores3/3. Both agents reached
COMPLETED. Raw durations are1771.4s and2009.7s respectively. Original grades,
infra=false, release and clocks remain unchanged. Other bundled task families
were not inspected as part of R21.

## Diagnosis

Observed path: live challenge -> unsuccessful recovery -> disclosed archived
page -> native archived-page and card-attribute evidence -> browser completion
verifier -> final output -> separate declared Polar judges. Evidence transport
for the decisive archived source is present, but the deeper live recovery cause
and a safe general repair remain OPEN.

1. Native run2 read_browser_state observations repeatedly show Pngtree live
   URLs titled Just a moment with Cloudflare text. Recovery rows record no
   stable configuration clearing the challenge. The actor then browses an
   archived homepage, locates the Text Effect route, and navigates to
   web.archive.org/web/20231127161852/https://pngtree.com/free-fonts.
   Its recorded card extraction identifies ten titles and PNG-format attributes.
2. Run1 also fails to clear live security verification. Its eventual source is
   web.archive.org/web/20240106050518/https://pngtree.com/so/text-effect.
   Native state shows the Text Effect PSD page and ten cards; recorded attribute
   extraction reports PNG+PSD for nine and PSD-only for one. It is not a live
   success comparator, and its page/date/items differ from run2.
3. Final browser verifiers explicitly acknowledge each archive. Run2 verifier
   0e08902c9cde accepts the November2023 data with task_completed=true/score1;
   run1 final verifier d2c81f1e9ddc accepts January2024 similarly. Final structured
   lists each contain10 assets and exactly equal their own verifier output.
4. The unchanged canonical build_verifier_context_messages reproduces all
   TOOL_RESULT lines in both final encoded verifier requests. Run2 contains
   56,109 tool characters; run1 contains106,127, both below160,000. Exact request
   SHA256 values are fbb9cc51375ecdd24fa4448b4b5beb30996acf7066f34e35eb09a96e7499930d
   and0b9e62df7f97de642dedcd9a8ca9d0396c45128f13b5dcf8025fb4253a571a06.
   Existing caps remain; this is no evidence of hidden archive-date removal.
5. All six original declared-judge requests and responses were decoded and
   checked against recorded payload hashes. Every input includes the historical
   source/disclosure. Run2 C1 fails because the2023 snapshot does not establish
   the requested site's current first ten assets. Its C2/C3 pass for the
   disclosed historical extraction. Run1 C1/C2/C3 all pass while explicitly
   acknowledging January2024 archived data instead of the current live listing.
   This is differing temporal-completion treatment across distinct original
   inputs. It is not a controlled same-input judge replay, proof of stochastic
   failure, or authority to regrade either run.
6. Generated schemas both require10 named asset/format entries. Run1 also has
   nonempty-string constraints. These recorded differences are not established
   causes. Full actor request coverage differs: run2 has55 captured actor input
   payloads and no skip event; run1 has60 and four skips. Missing earlier input
   parity is not filled from the sibling or later verdict.

The owning completion and evaluation paths are separate: service.py constructs
browser evidence, helpers/llm.py serializes it under existing bounds, the handler
returns structured completion, and polar_evaluator.py builds the root/hydrated
trajectory and each rubric request. Exact admission proves retained tool text,
not complete site eligibility or a repaired end-to-end task.

Archive search `Pngtree Wayback archive` found
2026-10-28-pngtree-challenge-recovery-cause-unresolved. Its It6 historical-output
failure and It8 R11a recovery timeout are related leads. Their first-bad local
cause was not proved there and is not newly proved here. No prior case was
appended. The current pair both use historical pages, unlike It6's live PASS
comparator, so those outcomes must not be interchanged.

## Solution

No runtime repair, task change, prompt/schema/criterion edit, cap increase,
retry, challenge/authentication bypass, provider operation or regrade is
proposed. Do not present a historical snapshot as present-day evidence, infer
that it is universally disallowed from one C1 response, or infer universal
permission from the sibling's PASS. No causal local mutation with an unchanged
full-task result has been established.

Validation is read-only: exact archive/hash/length, source/no-patch custody,
run/worker manifest hashes, original native URL and card evidence, exact final
admission equality, final structured-list equality and six actual judge
request/response inspections. The scripts are investigation artifacts, not a
registered red/green repair test. Underlying live challenge cause and appropriate
completion decision remain OPEN. Any later protected fix needs the required
causal test and independent opened-reference grounding before application.
No new browser/model/provider/controller/DB calls or paid run occurred; no
images were viewed or published. Own token usage is UNMETERED.

## Human feedback

The parent assigned only BU023 run2 with its named same-source PASS comparison,
prohibited assuming the old R11a cause, and required preserving all grades and
clocks. R21 is the final eighth It9 slot. BU042 and the separate BU025 run2
admission cause are carried forward by the parent; they are not silently grouped
into this family. No new reviewer/subagent, images, speculative fix or runtime
application was authorized. Earlier R14/R16/R18/R20 cases remain separate.

## Reusable lesson

Check what the supposedly passing comparator actually proves. Two disclosed
historical outputs with different judgments can establish evidence availability
and a decision discrepancy without identifying a causal repair or changing the
original task's accepted scope.
