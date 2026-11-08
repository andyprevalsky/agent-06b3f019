---
id: 2026-11-08-independent-custody-ledger-transfer
date: 2026-11-08
title: Independent repair could not transfer no-remint custody without importing its donor deploy ledger
surface: harness
component: deploy-historical-custody
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: deploy_test_cycle refresh applies same-deploy selection preservation to an independent donor ledger; no fresh-ledger typed custody transfer existed
symptoms:
  - "DEPLOY_CYCLE BLOCKED: repair cannot silently remove originally selected checks"
  - "historical custody: original sandbox native bytes missing or changed"
tags:
  - deploy
  - custody
  - agentcard
  - no-retry
sources:
  - PR #1830
  - commit 5066feea73da4a966aa7655ccbc40ea8c26529a8
repro: scripts/tests/deploy-test-cycle.test.py
status: fixed
---

## Problem

An independent auto-tag repair had to preserve two historical sandbox payment
obligations before its smoke gate. The historical donor selected fifteen smoke
checks; the new repair's ordinary full plan selected thirteen. The existing
same-deploy refresh correctly refused to drop the two extra donor checks.
Restoring the donor READY ledger as current validation or injecting legacy SKIPs
would grant authority the repair did not have. No allocation was performed.

The first archive omitted discovery inputs and sealed closure evidence. Native
preparation refused missing bytes. An additive, separately restored supplement
supplied the exact original files; the unchanged known()/historical() checks
then passed. That export completeness issue was not fixed by weakening discovery.
Only after native preparation succeeded did the distinct ledger-transfer gap
become observable as the scope-preservation error above.

## Diagnosis

Path: verified archive → immutable native/index/audits → historical preparation
→ current-source binding → same-deploy refresh → scope-preservation refusal.
The first bad owned contract was treating an independent donor ledger as the
new deploy's execution ledger. Its protected financial facts must transfer;
its prior selection, PASS, READY, attempts and provider waivers must not.
Same-deploy source refresh intentionally preserves its full original selection
and remains unchanged. The missing capability was a typed import into a genuinely
fresh current-source ledger, distinct from refresh and warning renewal.

The owning coordinator tests first failed with the missing adoption API, while
the native real-data refresh failure was retained separately. The unchanged
expanded tests now cover the documented CLI, current-only peer dispatch, zero
financial/execution credit, source/environment/input binding, exact replay,
duplicate identities, tampered debt, lost projections/history and atomic refusal.
The independent review reproduced holes in an early implementation: a retained
transfer receipt with deleted obligations could return success or lose an auth
case during ordinary admission; an ignored duplicate id could import an unrelated
row; replay initially did not cross-check the current ledger binding. Each was
closed and its failure evidence retained. Transferred identities now participate
in ordinary discovery and child state identity, as well as replay validation.

Archive searches: `repair cannot silently remove originally selected checks`
and `independent donor fresh ledger no retry historical custody transfer`.
Existing historical custody cases are relatives; their same-deploy refresh and
provider-renewal contracts are preserved. This adds the missing cross-deploy
operation rather than relaxing those contracts.
Golden reference: not applicable (operational deploy tooling, no harness prompt,
agent behavior, schema or production-environment change).

## Solution

The existing preparation proof still verifies the entire donor and immutable
native closure against the current full plan. `import-historical-no-retry`
requires a normally initialized fresh ledger, then transfers only validated
failure/history facts and canonical pending/resolved repair debt. It atomically
records the donor digest, proof and current binding. Same-deploy refresh still
rejects reduced selections. No current-source PASS, waiver, financial state or
provider timestamp comes from the donor. Every selected current peer runs.

Exact replay revalidates the current source, environment, fingerprints, complete
protected history and projections. Normal guard/admission/verify also reject
lost transferred identities. Duplicate raw failure aliases and changed pending
wrappers fail before publication. The operation makes no provider calls and
never restores live ownership claims or executes historical worker requests.
The CLI flow is documented in docs/deploy-test-cycle.md and the regression stays
in the existing deploy-test-cycle structural suite. The work scales with the
bounded deploy ledger, not concurrent agents; it adds no runtime per-agent work.

## Human feedback

The user prohibited reminting, reclaiming or reissuing both original 4,396-cent
cases and required typed NO_RETRY_CUSTODY with exact native/index proof before
smoke. Historical auth failure/root-ACTIVE timeout remain FAIL, never a standing
stall PASS/SKIP. A later separate 100-cent production mixed-mode obligation also
remains protected; it is not imported as a sandbox custody qualification.

## Reusable lesson

Transfer verified historical obligations into a fresh independent ledger without importing the donor's execution authority.
