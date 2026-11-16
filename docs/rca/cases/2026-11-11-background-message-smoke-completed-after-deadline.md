---
id: 2026-11-11-background-message-smoke-completed-after-deadline
date: 2026-11-11
title: Background message forwarding succeeded but completion crossed its unchanged 180-second task deadline
surface: agents
component: web-fetch-summarizer-and-completion
classification: our-bug
problem_class: other
first_bad_boundary: summarize_and_filter_links forwards the complete discovered-link list beside the bounded page preview; inherited execution and completion work exhausts the task budget
symptoms:
  - "Timeout after 182s (task timeout=180s)"
  - "Agent status: ACTIVE (expected COMPLETED)"
  - Original FAILED followed by the single native same-source PASS is FLAKY
tags:
  - background-agent-message-smoke
  - web-fetch
  - summarize-web-fetch
  - completion-summary
  - flaky
sources:
  - PR #1865 source 3a17a82150c28c67669f27a51682a2d234c2a452
  - commit f8c8255003d70ac639facf623b30397d62baf38a (actual upstream)
  - benchmark run native44 request96753f5850c3482aaacc697c906977c9
  - task background-agent-message-smoke native FLAKY occurrence7bfbdd7853c2444fadec678325f57763
repro: Unchanged scripts/run-bench background-agent-message-smoke plus the privately preserved captured-request and real upstream/current poll controls
status: open
---

## Problem

The first native smoke44 attempt finished fifteen tasks PASS and this task
FAILED. Its original root agent 7798b440-5b85-4962-a8e2-9ea095ae11cf remained ACTIVE
when the unchanged 180-second task deadline expired. Message forwarding and
research had succeeded, and the verifier reported 100%, but the completion
summary crossed the task deadline. These intermediate successes do not make
the original run PASS. Its recorded task duration is 182.9 seconds; the native
error says 182 seconds.

The prescribed single retry on the same 3a17 source passed with
root agent c40685ec-84cc-493e-8de7-451b9546ca40. Native44 therefore records
FLAKY, attempts 2, and retains the first failure. Both attempts and the outer
gate have actual cleanup evidence. Neither this rerun nor the attribution
demonstrates a performance fix.

## Diagnosis

Gate: NOT_INTRODUCED relative to the actual upstream f8 source. Six complete
critical source files are byte-identical upstream/current. The captured
summarizer call carries a 40000-character page preview and 3469 discovered
links whose JSON occupies 213992 characters. Both real source versions
reconstruct the exact authenticated 255005-character provider request. Native
input usage is 92089 tokens and the successful call took 41.253 seconds; its
parallel companion took 49.223 seconds.

After research returned, the root spent 33.836 seconds on a display-producing
call, 18.016 seconds on verification and 14.387 seconds on the completion
summary. The real PAUSE arrived during summary generation, before its final
output. The formatter and deadline path are inherited; this evidence does
not establish the summarizer as the sole latency cause.

Both real poll-function bodies reject an over-deadline 182.9-second schedule
and accept a 179-second COMPLETED counterfactual. That diagnostic rounds to
183 seconds; it is not the exact original poll instant, which was not
recorded. Their only source delta is question deduplication, unused in this
run. The removed browser/code automatic-completion shortcut returns None on
the actual explore-only transcript. The raw pre-summary Firecrawl response
was not independently recovered; the replay proves the inherited formatter
path from the authenticated rendered request.

The six request/output objects were authenticated against their original
encrypted native archive, sizes, hashes, root/dump/span identities and
manifest membership. An independent review repeated the upstream/current
formatter control with networking blocked. Private evidence and full
commands are preserved under the PR1865 closeout packet:
smoke44-watch/background44-rca/RCA.json (SHA256
f8a958a4a32c99a0108c19ed4ada0a80b723fb8f7b48c45d92c0732194bb43fb)
and background44-independent-review/review.json (SHA256
612d8ce25360cb28531a66e05d0c2d289f7648cf1fa57e19f6913032cee040bb).
Raw requests and keys are not published.

## Solution

The native FLAKY policy requires an ordinary quarantine marker naming the
actual pending post-merge occurrence. It does not omit this task: smoke
continues to execute it with its original prompt, evaluators, declared
response schema, forwarding requirements and 180-second limit. The marker
records this failure and its repair ownership; it grants no fix or
unconditional PASS. The distinct mass-agent deploy-only exclusion is
unchanged.

The repair remains OPEN. After the originating merge, deliver a separate
different-devbox Bugs goal for the original unchanged task, performance and
completion behavior, permanent regression and its own completed /deploy.
The archived same-summary-timeout worker ended UNKNOWN with no active exact
repair goal; title-only RFC repairs concern a different cause. The RFC
titles and forwarded markers in this run are correct.

Related cases read before this disposition: head-only metadata loss
(2026-10-26), provider-chain/activity-budget mismatch (2026-11-06) and HTML
title provenance (2026-11-07). They do not demonstrate a fix for this captured
large-input and completion-budget path. Golden-reference review is not
applicable to this metadata-only disposition; no runtime/prompt repair was
introduced here.

## Human feedback

The user requires finishing the existing /deploy and preserving Freedom.
The source-freeze, exact-evidence and unchanged-task constraints here are
coordinator instructions, not invented additional user corrections. The
native policy supplies the single rerun, FLAKY attribution and post-merge
repair requirements.

## Reusable lesson

Keep successful forwarding, verifier progress, durable completion and the
task deadline verdict separate. Authenticate the captured request and
compare the real upstream producer before attributing a slow run to branch
changes. A same-source retry and its FLAKY marker preserve repair ownership;
they do not demonstrate a latency fix or authorize weaker tests.
