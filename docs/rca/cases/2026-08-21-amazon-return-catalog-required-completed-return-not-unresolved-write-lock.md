---
id: 2026-08-21-amazon-return-catalog-required-completed-return-not-unresolved-write-lock
date: 2026-08-21
title: Amazon-return catalog required completed return instead of unresolved write-lock
surface: harness
component: browser-amazon-return-catalog
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/tasks.json browser-amazon-return — approval_handling auto_approve + completion semantics demanded RMA after approval
symptoms:
  - 'amazon-return-completion-semantics'
  - 'write-lock alone is not completion'
  - 'approval_handling": "auto_approve"'
  - 'Your return request is confirmed'
tags:
  - browser-agent
  - amazon-return
  - write-lock
  - catalog
sources:
  - agent d943db4b-43c4-4e72-8ab4-8f93ba7ebe4e
  - commit b9bb7d8bc
repro: agents/tests/blackbox/benchmark.blackbox.py test_amazon_return_catalog_stops_at_unresolved_return_write_lock
status: fixed
---

## Problem

`browser-amazon-return` auto-approved the write lock and required a completed
return confirmation plus order-history / nearest-drop-off grounding. Andy’s
intended pass bar is the same as amazon-beanie: hit the write lock with a
semantically correct approval request and leave it unresolved.

## Diagnosis

Catalog contract mismatch (test-bug). Sibling benches already use
`approval_handling: ignore` and fail if the write lock is approved or the
order/return is completed. The agent on
`d943db4b-43c4-4e72-8ab4-8f93ba7ebe4e` already emitted a correct
`generic_write` approval; the judge failed on post-approval criteria that
should not be in scope.

## Solution

Set `approval_handling` to `ignore`; replace completion evaluators with
unresolved write-lock static + semantic checks (approval identifies item,
amount, payment method, drop-off; fail if approved/submitted). Cemented in
`test_amazon_return_catalog_stops_at_unresolved_return_write_lock`.

## Human feedback

Andy: we are not supposed to approve the write lock; hitting the write lock
with the correct approval request emitted (approved semantically) is the
condition. Approved H-02 for this catalog realignment; rejected a11y evidence
packaging as the fix.

## Reusable lesson

Ecommerce write-lock benches that validate approval copy must use unresolved `ignore` handling like amazon-beanie — do not auto-approve and demand post-submit confirmation unless that is explicitly the product under test.
