---
id: 2026-07-21-parent-agent-opens-second-browser-after-satisfied-schema
date: 2026-07-21
title: A parent agent opened another browser session after its child's browser result already satisfied the output schema
surface: agents
component: agent-loop
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the parent agent completion check — a verified browser result satisfying the output schema did not force parent completion
symptoms:
  - duplicate browser sessions in one agent tree
  - parent agent starts a browser after a child browser task already returned a verified result
  - simulated ecommerce benchmark opens more than one browser session
tags:
  - browser-agent
  - duplicate-session
  - completion-schema
  - wmh
  - sub-agent
sources:
  - PR #826
repro: the WMH Amazon simulated-ecommerce benchmark (asserts one browser session and one approval)
status: fixed
---

## Problem

While fixing the simulated World Model Harness ecommerce path, a parent agent was
observed opening another browser after its first browser result had already
satisfied the required output schema — producing duplicate browser sessions for
one logical task. The passing gate asserts the corrected behavior explicitly:
one browser session and one approval on the simulated ecommerce task.

## Diagnosis

Delegated browser work returned a verified result that fully satisfied the
parent's completion output schema, but the parent's loop did not treat that as
terminal — so it planned and executed more browser work of its own. The missing
rung is a completion check that consults the schema against results already
produced by children: without it, "the required output exists" and "I am done"
are two unrelated facts, and any parent will redundantly redo delegated work.
Duplicate sessions are not merely wasteful here — a second browser session on a
checkout flow can repeat a side effect.

## Solution

Force parent completion after a verified browser result satisfies the output
schema, preventing the duplicate browser session. This generalizes past the
browser: redundant browser/code work is now skipped whenever a delegated child
task already provides the required completion output. Verified by the WMH Amazon
simulated ecommerce benchmark passing 1/1 with exactly one browser session and
one approval, on cloud run `20260720-180734-78393` at commit `65e43327c`.

## Human feedback

None recorded.

## Reusable lesson

When a delegated child result already satisfies the parent's output schema, the
parent must terminate — otherwise it re-runs the child's side-effectful work and
you get duplicate sessions.
