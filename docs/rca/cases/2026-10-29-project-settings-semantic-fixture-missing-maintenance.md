---
id: 2026-10-29-project-settings-semantic-fixture-missing-maintenance
date: 2026-10-29
title: Project settings semantic fixture omitted required maintenance fields
surface: front-end
component: projects-sidebar-flow-semantic-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: projects-sidebar-flow.spec.ts emits a project without maintenance and snapshot and returns an empty maintenance status
symptoms:
  - Cannot read properties of undefined (reading script)
  - Startup timeout spinbutton absent
  - Error in App Root
tags:
  - project-settings
  - semantic-tests
  - fixture-contract
sources:
  - PR #1634
repro: front-end/tests-e2e/projects-sidebar-flow.spec.ts
status: fixed
---

## Problem

Both 1280px and 390px project-settings semantic cases failed waiting for the
startup-timeout input. Original browser traces show a TypeError reading script
from undefined maintenance before that assertion. The full UI run retained
31 passing cases and these two failures.

## Diagnosis

The mock project omitted maintenance and snapshot although the current Project
interface requires both and backend toProjectDto always supplies them. Opening
settings calls draftOf, which reads project.maintenance.script. The test also
answered the maintenance-status endpoint with an empty object, which lacks the
runs array consumed by the maintenance section. The first owned error is the
obsolete controlled API fixture, not the production renderer.

The investigator reproduced both original failures with the unchanged affected
spec. Related mobile-sidebar and project-setup cases were inspected but had
different causes. Evidence is retained in .context/pr1634-project-settings-rca/,
including original traces, extracted exceptions, before.log and handoff.json.

## Solution

Type the project fixture as Project, include its required maintenance defaults
and null snapshot, and return a typed MaintenanceState with an empty runs list.
No production behavior, assertions or timeouts change. The same two cases pass
in 11.0 seconds; repeat-each=5 passes all ten in 54.5 seconds. This remains a
controlled API test, not proof of live maintenance execution. There is no
production cost or behavior change at ten thousand agents.

## Human feedback

The user requested completion of deployment and repair of intervening issues.
Only treasury was explicitly overridden; semantic failures remain required.

## Reusable lesson

Type semantic API fixtures against the current client DTO so required backend
fields cannot silently disappear from mocked user flows.
