---
id: 2026-11-06-docker-fixture-inherited-system-database-override
date: 2026-11-06
title: Mock Docker restoration tests inherited a system Postgres coverage override
surface: harness
component: deploy-test-worker-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Backend.postgres_fixture did not clear BACKEND_COVERAGE_DATABASE_URL before testing the Docker-only restore contract
symptoms:
  - "KeyError: 'postgres_fixture'"
  - "AssertionError: ValueError not raised"
  - "test_stopped_owned_postgres_is_restored_before_the_unchanged_setup_and_sweep"
tags:
  - deploy
  - postgres
  - fixture
  - environment
sources:
  - PR #1708
  - commit c58bfb880e9aafff9839cf50f7f03ba78b76ae69
repro: scripts/tests/deploy-test-worker.test.py
status: open
---

## Problem

The structural gate's worker tests reported nine failed assertions and one error across three Docker Postgres scenarios. The stopped fixture was not started, healthy-fixture evidence was absent, and malformed-owner/volume/port/image fixtures were not rejected.

## Diagnosis

Gate: INTRODUCED at this deploy's worker-preparation boundary: the category inherited an explicit BACKEND_COVERAGE_DATABASE_URL for isolated system Postgres. The Docker fixture's partial patch.dict environment left that caller flag intact. restore_workspace_postgres correctly treats an explicit coverage URL as system Postgres and bypasses Docker restoration, so the fake Docker inputs were never exercised. The environment and owning code establish this boundary; no provider outage or test waiver applies.

Running the same three permanent tests with the inherited local override reproduces all nine failures and the missing postgres_fixture error. The unchanged assertions pass after setting the override to an empty value inside the Docker fixture's own environment. The fix preserves every negative control, native call order, restoration action and original timeout.

## Solution

Clear only BACKEND_COVERAGE_DATABASE_URL in Backend.postgres_fixture so these tests explicitly select their mocked Docker contract. Production system-Postgres behavior is unchanged. The full worker test file remains required; failing and passing original logs are preserved in the private deploy evidence. This changes only local test setup and adds no application or 10k-agent work. Golden reference: not applicable (no approval-gated hunk). Release validation is pending.

## Human feedback

None recorded.

## Reusable lesson

A fixture for one storage mode must neutralize inherited selectors for another mode before asserting its native lifecycle.
