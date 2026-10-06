---
id: 2026-10-04-browser-manager-completion-fixture-missed-status
date: 2026-10-04
title: Browser manager resume fixture omitted the completed result status
surface: harness
component: spawn-browser-agent-v3-blackbox
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: successful resumed activity fixture omitted status completed
symptoms:
  - manager_terminal_scope_and_pending_resumes
  - expected FINISHED but received ERROR
tags:
  - browser
  - fixture
sources:
  - PR #1299
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py
status: fixed
---

## Problem

An existing browser manager blackbox failed during the wider validation repair.
Its resumed successful activity fixture supplied success and task identity but
omitted the completed status required by the existing result contract.

## Diagnosis

A fresh isolated reproduction failed in the write-pending case. The manager
returned one terminal result with the correct task identity and two activity
starts; only its expected terminal status differed. Source history confirmed
that real completed activities already supply the required status. Archive
search used browser manager completed fixture success status.

An independent reviewer reran the same eleven scenarios with unchanged
assertions: original fixture failed; adding only status completed passed.
Both runs made zero external HTTP calls and retired their exact owners.

## Solution

Add the missing completed status to the successful resumed activity fixture.
Keep the manager implementation and every assertion unchanged. The normal
registered browser blackbox then passed; no runtime behavior changed.

## Human feedback

Keep compact runner checks in deploy and avoid verification that changes the
benchmark outcome or imposes artificial execution deadlines.

## Reusable lesson

Update controlled activity fixtures when the real result schema changes;
retain the behavioral assertions that verify terminal identity and ordering.
