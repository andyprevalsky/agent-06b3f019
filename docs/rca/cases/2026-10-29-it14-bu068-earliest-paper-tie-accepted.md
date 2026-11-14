---
id: 2026-10-29-it14-bu068-earliest-paper-tie-accepted
date: 2026-10-29
title: BU068 accepted one same-date paper while the exact ground-truth title differed
surface: agents
component: browser-semantic-completion-verifier
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Verifier acknowledged that the evidence did not establish a uniquely earlier paper but returned task_completed true for the other title
symptoms:
  - Native COMPLETED with three of four rubrics passing
  - Both candidate papers and matching publication dates reached the verifier
  - Exact ground-truth rubric required the unselected title
tags:
  - r55
  - it14
  - polar-bu-068
  - semantic-verdict
  - earliest-publication
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - agent bec47926-88a0-4033-bec8-285c2a0de8ae
repro: original request/response inspected; no model replay or controlled task-outcome reproduction
status: open
---

## Problem

Original assignment began 2026-10-29 at 04:03 UTC. The unchanged task asks
which 2015 paper author had prior papers and for the title of that author's
first paper. Native root COMPLETED after 1703.4 seconds, but the benchmark
failed three-of-four perfect-score acceptance: C1/C2/C3 passed and C4 failed.
Infrastructure failure is false. Neither the native completion nor the three
passing rubrics supersedes the original task FAIL.

## Custody

Archive SHA256
8fb934bda8c497a0563c28e0b32504913d7ba0fff375cca4b22cfd9b5c81df5e;
normal manifest SHA256
ea48291a1207a0a7bf5d601504e07ff3332a6dc111be7d8a9f7fa2307d7cb50e.
All seven normal members were independently checked for byte length and SHA.
Original run.json SHA256
0ecd72647515bed92a3399008826ccdd52553d25ac8a2b02e3b3fc115d513e21.
Execution provenance binds source85 above, with no patch. The decoded verifier
payload hashes below were checked against the original worker dump records.
No new browser, provider, model, capture, or remote evidence request was made.

## Diagnosis

Original outer row96 (zero-based message95), native browser step34, records
“A new software agent'learning'algorithm,” Pietro Murano, publication date
2001/6/19, conference pages297–301. Outer row100 (message99), native step36,
records “Mapping human-oriented information to software agents for online
systems usage,” the same author/date/conference, pages212–216. These are
captured page claims, not independently resolved publication precedence.
Different page numbers alone do not prove which work was authored first.
A bounded check of the retained encoded input found no independently established
within-day publication or authorship ordering. Search queries and search-generated
summary claims do not supply that missing order.

The final actor returns to the algorithm page at outer138/native52. Earlier
captured Bing search content includes an AI summary calling that title the
first identifiable paper. That summary is browser-delivered content, not an
independent bibliographic determination. Actor reasoning acknowledges the
same-date ambiguity before attempting completion.

Actual verifier request fbb49bb247c8, SHA256
75f09f85261444f186c97ecf05e9159b5e375f3bad92f1339db254318cd72b7f,
contains both titles and dates. Its required first_prior_paper_title field
still requests the earliest paper; no title-only narrowing or lost alternative
is established. The request includes the separate strict task-completion
instruction already installed on this executed source.

Actual response SHA256
1fc9237aa4f1ed1ef8967eb13e0d22b98e1438bd3e907ebab2a5fed7d6d3f8b5
returns the algorithm title, task_completed=true and score=1.0. Its reasoning
explicitly says the evidence does not establish a uniquely earlier paper,
but supports the selected title as an earliest publication. This is captured
boolean evidence, not a success-path inference. The existing handler's strict
true/score admission therefore receives the verdict it requires. The root
then retains that title as its final extracted output.

The declared C4 requires exactly “Mapping Human Oriented Information to
Software Agents for Online Systems Usage.” C1–C3 accept the selected title as
grounded and acknowledge the same-date alternative; C4 rejects its mismatch.
This establishes selection and verdict disagreement with exact ground truth.
It does not establish that the ground truth is wrong, that both answers must
pass, or that the provider/model is generally defective. No raw judge HTTP
request is claimed byte-identical to a reconstructed trajectory.

## Prior cases

After the original boundary inspection, archive searches used “ambiguity
earliest” and “retained contradiction.” The BU052 conflicting-foster case and
Polar C3 author-context case were opened, including their Solution and Human
feedback. They support distinguishing retained evidence from missing transport,
but neither proves this same-date bibliographic selection is the same cause.
A separate case retains this task's exact contract and unresolved precedence.

## Solution

OPEN: no safe general deterministic runtime repair is established. Selecting
by a specific title, page range, search phrase, or expected answer would encode
the benchmark answer. Reclassifying the original FAIL, weakening C4, changing
the task, or adding a prompt nudge would not demonstrate a causal repair.
The precise remaining floor is how the requested first publication should be
established when captured primary-looking records share a date, and how the
semantic verifier should treat that unresolved distinction. A future general
mechanism needs controlled counterexamples and an owning causal test; none was
invented or run here. No runtime, schema, evaluator, model, or budget changed.

## Human feedback

The coordinator required original encoded inputs before family attribution,
no speculative task-specific repair, and preservation of the live source.
This intake follows that scope. Tokens are UNMETERED. No independently reviewed
runtime candidate or new task-outcome success is claimed.

## Reusable lesson

A strict completion flag is only a protocol boundary: a verifier may explicitly
acknowledge unresolved precedence and still set it true. Preserve the actual
request, competing observations, raw verdict, and exact rubric separately;
complete transport and populated output are not proof of the requested fact.
