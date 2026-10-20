---
id: 2026-10-18-parent-canary-omitted-shared-relay-environment
date: 2026-10-18
title: Parent canary omitted the campaign shared relay environment
surface: infra
component: run-bench-campaign
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the parent N2 policy environment omitted the existing shared relay values that worker dispatch already supplied
symptoms:
  - parent canary proxy traffic selected the raw flyctl proxy path
  - a default Fly agent remained after Original77 stopped
tags:
  - cloudbench
  - shared-relay
  - preflight
sources:
  - commit c9d4817832720cc2b1bc6a212383973a77baf004
  - commit ffe622243b8d704692fd3b69ab1d08eb1bb54040
  - fleet run original600-1792279176545861179
repro: python3 scripts/tests/cloudbench-cleanup-ticket-campaign.test.py
status: open
---

## Problem

The campaign created its shared relay before starting the parent N2 canary. Worker dispatch received the relay environment, but the earlier parent canary dispatch did not. The proxy helper therefore selected its ordinary direct Fly path. The difference bypassed the already-created relay without an intentional policy decision.

## Diagnosis

Source inspection follows campaign relay creation, parent policy construction, preflight environment copying and the production proxy helper. Preflight intentionally removes worker barrier, job and seed fields while retaining permitted shared services; the missing relay values originated in the parent policy construction. The nested relay requester supports descendants of the campaign owner and validates the current published Machine identity without requiring a main campaign job ID.

Original77's sole remaining writer was a default Fly agent. Its recorded source and fleet token are retained, but the available evidence does not uniquely establish which direct CLI invocation first started it. SSH and SFTP paths can also use a default agent. This repair addresses the demonstrated missing parent relay binding; it does not claim to eliminate every default-agent lifecycle issue.

## Prior archive search

The search `Fly agent controller export relay parent preflight` found the normal-export missing-borrower-capture case and the retained-retirement FIFO export case. Neither corrects the parent canary's shared relay binding.

## Solution

Use one binding function for the parent canary and ordinary worker dispatch. It supplies only the existing shared relay values, or removes stale inherited values when no relay exists. Preserve the canary's distinct owner and its worker-field scrubbing, the relay's ancestry and Machine checks, and the task and campaign deadlines.

## Verification and limits

The owning fixture exercises campaign dispatch, actual preflight and the production proxy entry point with a real local relay broker and a simulated remote transport. The old source selects the raw proxy route; the corrected source uses the shared relay. Final owner results and immutable source hashes are recorded in the integration manifest. Original77 remains unchanged and failed; future full qualification remains required.

## Human feedback

Complete the authorized benchmark and deployment goal without hiding original failures or weakening resource ownership. The separate requested 20-second claim observation change does not reset this run or its deadlines.

## Reusable lesson

Bind a shared service consistently at every child-dispatch boundary. A later worker binding does not configure an earlier prerequisite child, and a routing repair alone does not prove complete daemon cleanup.
