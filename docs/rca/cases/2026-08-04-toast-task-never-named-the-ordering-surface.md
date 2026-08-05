---
id: 2026-08-04-toast-task-never-named-the-ordering-surface
date: 2026-08-04
title: Toast task named only the restaurant, so the root routed to DoorDash while the judge demanded Toast checkout
surface: harness
component: benchmark-catalog
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: agents/benchmarks/tasks.json browser-toast-nopa-write-lock prompt
symptoms:
  - "root chose https://www.doordash.com/ instead of order.toasttab.com"
  - "Timeout after 601s; no payment_approval; payment_lifecycle null"
  - "semantic_judge_reached: false"
tags:
  - benchmarks
  - browser-agent
  - task-contract
  - descend-antibot
sources:
  - agent 20521b60-f2b6-485e-92a4-3a5555fc9db4
  - run 20260803-151006-65014
  - commit dca15b91e680deb188e88ca5db1d6c1baed5af22
repro: agents/tests/blackbox/benchmark.blackbox.py::test_toast_nopa_benchmark_uses_semantic_outcome_validation
status: resolved
---

## Problem

After the original harness false negative was fixed (static literal receipt
parsing replaced by a single-turn LLM judge), the exact rerun of
`browser-toast-nopa-write-lock` still failed — and failed *earlier* than before,
never reaching semantic evaluation at all.

Runtime evidence from agent `20521b60-f2b6-485e-92a4-3a5555fc9db4`
(run `20260803-151006-65014`, code-under-test `dca15b91e`):

- The root's `spawn_browser_agent` call selected `https://www.doordash.com/`,
  then Google, then Uber Eats.
- It never reached Nopa Fish checkout on Toast, never issued
  `request_payment_card`, and `payment_lifecycle` was `null`.
- Terminal state: `Timeout after 601s`, `approvals_triggered=0`, no order placed.
- `semantic_judge_reached: false` — the LLM judge never ran, so the previous
  epoch's evaluator fix could not be exercised.

## Diagnosis

The task prompt was:

> Order me 1 rocky fish sandwich from Nopa Fish Ferry Building

It names *what* to order and *which restaurant*, but never names the **ordering
surface**. Meanwhile the declared evaluator criteria require the official Toast
checkout:

> "The browser and payment-request evidence semantically identify Nopa Fish at
> the Ferry Building using the official Toast checkout…"
> …"Fail a different business, non-Toast checkout, …"

So the acting agent and the evaluator were graded against different contracts.
Ordering the named dish from the named restaurant via DoorDash is a *correct*
reading of the prompt as written; it is only wrong under a requirement the
prompt never stated. The root's marketplace-first routing was therefore not an
agent reasoning failure — it was the contract's missing requirement surfacing as
one.

Step 5a ladder to the deepest owned cause:

1. Timeout at 601s — downstream symptom, not the cause.
2. Challenge-recovery loop on DoorDash/Uber Eats — a consequence of being on the
   wrong site, not of a broken recovery tool.
3. `spawn_browser_agent` was handed `https://www.doordash.com/` — the root chose
   it, and nothing in its inputs said not to.
4. **The task prompt omits the ordering surface that the evaluator requires.**
   This is the first place the data was wrong: the requirement existed only in
   the evaluator, never in the contract given to the acting agent.

## Solution

Name the ordering surface in the task itself. The prompt becomes:

> Order me 1 rocky fish sandwich from Nopa Fish Ferry Building, from the
> restaurant's Toast site

The change lands in all four places the prompt is mirrored, so a Benchmark Hub
export cannot restore the superseded wording over `tasks.json`:

- `agents/benchmarks/tasks.json`
- `back-end/prisma/migrations/20260804185235_toast_nopa_prompt_names_toast_site/migration.sql`
  (row `prompt` **and** the runner `definition`)
- `agents/tests/blackbox/benchmark.blackbox.py`
- `back-end/src/tests/blackbox/benchmarks-hub.testkit.ts`

The regression guard is an explicit contract assertion, not just string
equality, so a future prompt edit that drops the surface fails the suite:

```python
assert "toast site" in task.prompt.lower()
```

A pre-existing failure in the same suite was fixed in the same change:
`test_toast_poll_stops_without_responding_to_payment_approval` still required
`_benchmark["expected_payment_receipt_seen"]`, a key the semantic-only contract
no longer emits (`expected_payment_receipt` is now `None`), so it raised
`KeyError`. The assertion now states the semantic-only invariant directly.

10k-agent behavior: this is a task-contract wording change plus one idempotent
`UPDATE` on a single `BenchmarkTask` row. It adds no runtime work, no per-agent
state, no channels, and no queries on any hot path. It strictly *reduces* load,
because agents stop burning a full 600s budget exploring the wrong marketplace.

**Rejected alternative (resisted reward hack):** an earlier attempt at this RCA
changed `build_system_prompt` to deliver global tool guidance to every acting
agent (commits `fb11d4d11`, `fc930b5fd`). Andy rejected it outright — "def dont
do whatever u did, u can add 'from the restauraunts toast site' but thats it."
Both commits were reverted in full (`cff3cf233`). Broadening a global agent
prompt to make one benchmark route correctly would have masked the actual
defect, which is in the task contract.

## Human feedback

Andy rejected the global system-prompt tool-guidance change and authorized
exactly one edit: adding "from the restaurant's Toast site" to the task prompt,
"but thats it." No other change to the task, evaluator, timeout, or pass
criteria was permitted, and none was made.

## Reusable lesson

When an agent takes a defensible path that the evaluator forbids, diff the task
prompt against the evaluator criteria before blaming the agent — any requirement
that lives only in the evaluator is an underspecified task, and the fix belongs
in the contract, never in a global prompt.
