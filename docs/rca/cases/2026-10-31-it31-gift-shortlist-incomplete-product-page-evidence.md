---
id: 2026-10-31-it31-gift-shortlist-incomplete-product-page-evidence
date: 2026-10-31
title: Gift-shortlist runs retain incomplete product-page evidence after recovered sockets
surface: agents
component: browser-verifier-completion
classification: unresolved
problem_class: other
first_bad_boundary: Final native verifier rejects incomplete shopping evidence; deeper site-failure and action-selection causes remain unproven
symptoms:
  - task_completed false with score 0.5
  - task_completed false with score 1.0
  - lululemon product page GE401001 Bad Request
  - Native browser task did not complete successfully
tags:
  - r136
  - it31
  - shopping
  - task-completion
sources:
  - commit 618430e2a32e619406cb24fb537e2f6e2fe291e7
  - agent 602beaad-89e0-4f1b-80e1-93540c199da6
  - agent 88279010-e8f2-4be4-a12e-da0d36105174
repro: original sealed run and native verifier payloads; no causal runtime reproduction
status: open
---

## Problem

It31 task polar-odysseys-1211fbaa6464 asks for a five-item Father's Day
shortlist: the specified Milwaukee battery, a Tecovas leather boot, Nike Ja3
with its price and under-$60 determination, a lululemon athletic item, and an
Old Navy jogger. It requires actual product pages kept open for comparison.
Both originals ran source618430e2a32e619406cb24fb537e2f6e2fe291e7/patchnone.

Run1 r001-j0006/root602beaad-89e0-4f1b-80e1-93540c199da6 ends nativeFAILED
in2178.7s with progress1 and canonicalFAIL. Run2 r002-j0016/root88279010-
e8f2-4be4-a12e-da0d36105174 ends nativeFAILED in2221.0s with progress1 in its
local diagnostic; the canonical campaign row is CANCELLED after the separate
operational stop. Do not promote that diagnostic into a scored canonicalFAIL.
Run1's audit/lifecycle is verified; run2's release remains BLOCKED/unknown per
parent custody. Both diagnostic run cleanup_failure fields are null, which is
not proof of run2's full release. Original grades and flags remain unchanged.

## Diagnosis

Archive63040d5a3743934187bf956a7416ee3c596f5079ab3b50a3cac828fb071024fa
and archive6e289804615e6ddc7f1cd193cac32b5ede0b38c1ccfea799b3a3980ee37cfb62
have independently verified normal seven-member manifests respectively
ecacb6e70cc82a151fbe06f8efe6312becd13b249807756e8947e28cb7787b7a and
6ab24eecd37f6edad798f93182a267c532f6a26d6430e734a30b04690f9211e2.
All77 and116 captured compressed model payloads were SHA-checked.

Run1's code1006 socket close at worker16472 (02:11:25.124287Z) is followed by
successful reconnect16846 at02:11:31.197326Z, after5.8s, and further work.
Run2's proxy-rotation close also reconnects; its later code1006 close14261 at
01:57:27.774086Z reconnects14478 at01:57:34.171378Z, after6.3s, followed by
continued research and three native verifier calls. These are contrary evidence
to treating either final failure as R135's unrecovered global CDP silence.
They do not prove the close initiator or a provider root cause.

Run1's final verifier_browser_max_steps response at worker19329 has payload
SHA7d910bd668527d670c5685fcf70f62773d2d6383803312e750ef84088cacfd33.
It returns task_completedfalse and score0.5: the selected lululemon variant's
single price, breathable features and usable product page were not established;
no specific Old Navy jogger listing was researched. The output includes
partial fields and explicit missing-evidence reasoning. It does not claim a
completed task. The generic nativeFAILED result is not an independent semantic
judge rejection of a completed shortlist.

Run2's final verifier_browser response at worker22975 has payload SHA
f12779302647466309ee9cc1f96594c96100dfbfbadb9f50b0c8d547540eec18.
It extracts the five entries, including Milwaukee$99, Tecovas$325,
Nike$129.99, lululemon$54 from search evidence and Old Navy$34.99.
It returns score1.0 but task_completedfalse: the lululemon product and men's
We Made Too Much pages show GE401001 Bad Request rather than the requested
viewable product page. This distinguishes populated output fields from the
browser work the user requested. Max iterations100 is logged at23241;
native execution ends error at23462. No cap increase is justified.

The exact source requires both score>=1 and task_completedtrue for normal
completion (handler12055). Its final synthesis can retain partial structured
output without turning that into successful execution. The schemas preserve
the requested comparison categories; no demonstrated schema/parse/persistence
repair follows from these records. Product-page failure and the allocation of
remaining actions remain causal investigation gaps, not a proven common model
or transport cause. Historical fast-mode flags and cache events are separate
from these completion and transport observations.

## Solution

OPEN: preserve the explicit missing-evidence feedback and the original outcomes.
Do not reinterpret score1 as task success, loosen product-page requirements,
force prices, hide the inaccessible page, or attribute recovered closures to
an unrecovered connection failure. No runtime, prompt, evaluator, task budget,
model route or grade changed; no new model/provider/browser/DB call or replay.
Run2's post-stop release requires independent authoritative custody and is not
resolved by a diagnostic cleanup_failure field.

## Human feedback

The user prioritizes native agent failures and progress-zero cases while
keeping other failures tracked. This case preserves the distinction between
native failure, task-completion evidence, canonical cancellation and release.

## Reusable lesson

Keep structured-field score, explicit task completion, recovered transport
errors and canonical campaign outcome separate when diagnosing browser work.
