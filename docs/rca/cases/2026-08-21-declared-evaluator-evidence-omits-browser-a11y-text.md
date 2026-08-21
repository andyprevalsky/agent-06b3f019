---
id: 2026-08-21-declared-evaluator-evidence-omits-browser-a11y-text
date: 2026-08-21
title: Declared LLM judge evidence omits browser a11y text the agent already saw
surface: harness
component: declared-evaluator-evidence
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py::_declared_evaluator_evidence — only root tool message texts; screenshot results carry byte counts, not page a11y text
symptoms:
  - 'amazon-return-completion-semantics'
  - 'opaque screenshots'
  - 'does not expose the order-history dates'
  - 'Delivered August 19'
  - 'All declared static checks passed'
tags:
  - browser-agent
  - llm-judge
  - evidence-packaging
  - amazon-return
sources:
  - agent d943db4b-43c4-4e72-8ab4-8f93ba7ebe4e
  - commit 9ac3e35ca
repro: pending — cement after fix; red proof via _declared_evaluator_evidence on saved run vs browser_use_step_4 dump
status: open
---

## Problem

Local `browser-amazon-return` agent `d943db4b-43c4-4e72-8ab4-8f93ba7ebe4e`
completed the return (static contract PASS: COMPLETED, 1 write-lock,
generic_write approval with $15.04 / Visa 9616 / Whole Foods, RMA
`DfDvpBlzRRMA`, “Your return request is confirmed”) but failed
`amazon-return-completion-semantics` with Score 0.0 because the judge could
not ground “most recent delivered eligible item” or “nearest” drop-off.

Judge reasoning (literal): order-history dates / delivery / eligibility not
in supplied browser/tool output; “opaque screenshots.”

## Diagnosis

Archive search: novel relative to write-lock return cases; related to
evidence-packaging / judge-grounding class (not Eventim cheapest-overfit —
do not weaken criteria).

Causal chain:

1. Browser LLM dumps (`browser_use_step_4`) contain a11y text:
   `Order placed August 16, 2026`, `Delivered August 19`,
   `Return or replace items: Eligible through September 18, 2026`, `Mr. Pen…`.
2. Root tool messages only say `Screenshot captured from browser viewport (N bytes)`
   / click titles — no a11y excerpt (`service_actions.py` screenshot message).
3. `_declared_evaluator_evidence` copies those root texts only (12k cap) into
   the judge TOOL_RESULT. Measured: `Delivered August 19` / `Eligible through`
   absent from evidence pack; present in browser dump.
4. Judge correctly scores 0 — selection criteria ungroundable from the pack.

First-bad boundary: evidence packaging between browser-visible a11y and the
declared judge (producer: screenshot/nav tool messages; consumer:
`_declared_evaluator_evidence`). Not model intelligence — the browser model
already saw the grounding.

## Solution

Pending H-02 approval. Proposed generalizable fix: include a truncated
visible-page / a11y text excerpt on screenshot (and key navigate) tool-result
messages so declared judges receive the same grounding the browser agent used.
Do not weaken `amazon-return-completion-semantics` criteria.

## Human feedback

None recorded on this specific packaging fix. Prior descend guidance: no
reward hacks; keep return/`generic_write` notification path.

## Reusable lesson

When an LLM judge fails for missing page grounding that exists in browser LLM dumps, fix tool-message / evidence packaging — do not weaken the judge or treat it as model intelligence.
