---
id: 2026-11-08-fresh-cycle-lacked-historical-custody-admission
date: 2026-11-08
title: Independent repair cycles could not import preserved no-retry custody without copying old coordinator state
surface: harness
component: deploy-test-historical-custody
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: deploy_test_historical_custody supported same-cycle refresh only while initialize created empty historical failures and no cross-state admission action existed
symptoms:
  - "AttributeError: module 'deploy_test_historical_custody' has no attribute 'prepare_import'"
  - fresh independent repair cycle has no discoverable historical no-retry obligations
  - init did not consume historical-no-retry-proof
tags:
  - deploy
  - historical-custody
  - agentcard
  - no-retry
  - state-admission
sources:
  - PR #1770 independent repair handoff
  - commit 5066feea73da4a966aa7655ccbc40ea8c26529a8
repro: scripts/tests/deploy-test-cycle.test.py historical-import regressions
status: fixed
---

## Problem

The independent report-bug repair had to preserve two historical sandbox
obligations while running its own deploy on another devbox. The documented
prepare-historical-no-retry/refresh workflow required the same existing cycle.
A normal fresh init created empty failures/history, so known() discovered no
obligations. Copying the donor cycle would also copy unrelated old coordinator
state and was prohibited. Merely passing the old proof flag to init did not
import anything. Both catalog allocations had to remain blocked.

## Diagnosis

A read-only investigation traced init, prepare, refresh, discovery and dispatch
admission. The first-bad contract mismatch was cross-state transfer: repair
policy requires a fresh coordinator, but only same-cycle rebinding existed.
The existing unchanged native/financial validators could validate the records;
the missing boundary was admitting them to fresh metadata without old results.
A real lifecycle/audit fixture called the absent prepare_import API and failed
on the original module. This RED is preserved with exact commands and hashes
in the encrypted causal evidence archive receipt in
`docs/handoffs/report-bug-fetch-repair/evidence-archive-receipt.json`.

The owning test suite then passed all five new regressions for five consecutive
unchanged-source runs, plus 17 existing historical/renewal regressions. Tests
retain original native/auth/ACTIVE-timeout debt, actual repair links and all
peer checks. They reject donor/source/plan/environment/native/adapter/catalog
or audit drift, missing closure, live/unknown owners, broken ownership symlinks,
attempt collisions, removed tasks and mixed authority. Invalid CLI input leaves
cycle bytes unchanged. Existing native/renewal/admission guards are unchanged.

The ladder stops at the supported metadata API: a workflow that requires a new
coordinator cannot express transfer using only an old coordinator's refresh.
No provider, credentials, financial state or agent behavior caused this gap.

Integration validation also exposed an instruction-level environment mismatch.
Manual Python init/import bound the caller's environment, while the documented
shell wrapper prepended dependency directories to PATH again. The existing guard
correctly refused that launch with `source/plan changed; refresh after RCA before
running` (exit 2), before tests started. Running the same gate coordinator through
`python3 scripts/deploy_cli.py gates` preserved the original environment and passed
all four quick gates. The operational instructions now use that entrypoint after
manual setup; the environment guard and shell wrapper remain unchanged.

## Solution

Normal init remains unchanged. Separate prepare-historical-import and
admit-historical-import actions require the canonical preserved donor path and
its verified-manifest SHA256. Preparation binds donor bytes, fresh current state
and exact state path, plus current source/full-plan/environment/input hashes.
Admission re-reads and validates the whole expected proof, then uses the existing
atomic cycle writer. Only exact verified custody/failure/authority records and
required auth-repair debt are admitted. No donor attempts, PASS, READY, environment,
old fingerprints or legacy skips are copied. Immediate exact replay is idempotent;
non-fresh state and drift fail closed. Wrong-action proof flags are rejected.

Immutable native files are admitted separately without overwrites, only after
canonical/hash checks. Both recovered historical obligations passed unchanged
known()/historical() validation on this repair devbox. No current cycle was
claimed READY and no smoke was dispatched by that validation. A separate current
state directory avoids the historical adapters' attempts/5 and attempts/11 paths.
The existing documented state-directory/locator route is retained.

Current execution and financial state remain UNVERIFIED. Omitted cases retain
case_complete=false and all credit flags false; every peer still runs. No provider
reads or financial mutations occur. Existing warning renewal, task contracts,
native source/cleanup seals and ownership guards are preserved.

10k-agent behavior: this is bounded deployment metadata admission, not a running
agent path. It adds no production per-agent queries, channels, polling or locks.

## Human feedback

The user required complete historical custody/native proof before smoke, forbade
minting, reclaiming or reissuing either original case, and forbade manufactured
current provider confirmation or weakened renewal contracts. Historical custody
is not current execution, assertion, refund or financial-release credit.

## Reusable lesson

Provide explicit typed admission into fresh coordinator state instead of making cross-devbox custody depend on copying an old cycle or silently ignoring a proof.
