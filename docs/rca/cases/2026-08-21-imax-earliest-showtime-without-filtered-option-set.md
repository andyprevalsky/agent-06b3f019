---
id: 2026-08-21-imax-earliest-showtime-without-filtered-option-set
date: 2026-08-21
title: Browser agent claimed the earliest IMAX showtime without capturing the filtered option set
surface: agents
component: browser-use-system-prompt
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/browser_use.py build_browser_use_system_prompt `# Browser Rules` never required capturing the filtered option set before an ordered (earliest/latest/cheapest) selection
symptoms:
  - "imax-group-ticket-adjacency-semantics"
  - "does not expose the complete filtered showtime list"
  - "browser-imax-group-tickets"
tags:
  - browser-agent
  - benchmark-evaluator
  - grounding
sources:
  - agent 2982550e-0c34-42c3-a217-de16abd6885c
repro: agents/benchmarks/run_benchmark.py --task browser-imax-group-tickets
status: open
---

# RCA: IMAX earliest showtime selected without grounded filtered option set

## Symptom

`browser-imax-group-tickets` outcome-proof agent
`2982550e-0c34-42c3-a217-de16abd6885c` (run `20260821_024712`) passed
`imax-group-ticket-runtime-contract` (payment_approval ~$95.94, seats A1/A2/A3)
then failed `imax-group-ticket-adjacency-semantics` (score 0.0):

> The first missing requirement is grounded evidence that the 10:00 PM IMAX
> 70MM showing was the earliest qualifying premium-format showtime remaining
> tonight. The browser output shows the IMAX filter being selected and the
> 10:00 PM showtime clicked, but it does not expose the complete filtered
> showtime list… The assistant’s statement that it was the earliest is
> unsupported.

## Classification

**Agent Reasoning Failure** — task criteria, judge, tools, and fixtures are
valid; the browser agent selected a showtime and claimed “earliest” without
leaving a trajectory-grounded capture of the full filtered option set.

## Archive search

- `earliest showtime ordered options filtered` — related IMAX contract cases
  (payment prerequisite, purchase verifier) are evaluator/contract issues, not
  this agent-behavior gap.
- `adjacency-semantics grounded` — no prior case for missing showtime-list
  evidence before earliest pick.

Novel incident; not a recurrence of H-01–H-04.

## First-bad boundary

`agents/providers/rose/browser_use.py` → `build_browser_use_system_prompt`
`# Browser Rules` — no instruction required capturing the filtered option set
before an ordered (earliest/latest/cheapest) selection, so the acting agent
could click a single showtime and rely on thinking text alone.

## Owning-boundary proof

- **Pre-fix:** strip the ordered-options Browser Rules bullet →
  `test_build_browser_use_system_prompt_requires_ordered_option_set_capture`
  fails (`AssertionError: assert 'choosing among ordered options' in prompt`).
- **Post-fix:** restore bullet → same test passes; existing
  `test_build_browser_use_system_prompt_does_not_advertise_extract` still passes
  (bullet uses `screenshot` / `evaluate`, not `extract`).
- **Cement:**
  `build_browser_use_system_prompt_requires_ordered_option_set_capture` in
  `agents/tests/blackbox/rose_browser_use.blackbox.py`.

## Fix (superseded by Andy edit)

Initial proposal: Browser Rules bullet requiring filtered option-set capture
before ordered picks (landed on branch as defense-in-depth).

**Andy edit (H-05):** remove evaluator `imax-group-ticket-adjacency-semantics`.
Only that judge failed; `imax-group-ticket-runtime-contract` already passed.
Task becomes static_check-only, matching sibling `browser-event-ticket`.

## Outcome proof (pending)

Exact local `scripts/run-bench --local browser-imax-group-tickets` after Andy
approves the evaluator-removal snapshot. Owning-boundary green does not
complete the benchmark RCA.

## Problem

See `## Symptom`. `browser-imax-group-tickets` agent
`2982550e-0c34-42c3-a217-de16abd6885c` passed the runtime contract
(payment_approval ~$95.94, seats A1/A2/A3) then scored 0.0 on
`imax-group-ticket-adjacency-semantics`: it clicked the 10:00 PM IMAX 70MM
showing and asserted it was the earliest qualifying premium-format showtime,
without ever capturing the filtered showtime list that would ground the claim.

## Diagnosis

See `## Classification`, `## First-bad boundary`, and `## Owning-boundary proof`.
The prompt at `agents/providers/rose/browser_use.py`
`build_browser_use_system_prompt` (`# Browser Rules`) never required capturing
the filtered option set before an ordered (earliest / latest / cheapest)
selection, so a single click plus thinking text satisfied the agent while
leaving the judge no grounded evidence.

## Solution

See `## Fix (superseded by Andy edit)` and `## Outcome proof (pending)`.

## Human feedback

Andy superseded the original fix; see `## Fix (superseded by Andy edit)`.

## Reusable lesson

When an agent must justify a superlative ("earliest", "cheapest"), require it to
capture the full option set it chose from — a click plus prose is not grounding.
