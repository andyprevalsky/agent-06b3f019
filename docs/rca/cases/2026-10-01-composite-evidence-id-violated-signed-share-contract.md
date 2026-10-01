---
id: 2026-10-01-composite-evidence-id-violated-signed-share-contract
date: 2026-10-01
title: Composite evidence projection IDs did not satisfy the signed-share UUID contract
surface: harness
component: durable-evidence-publisher
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Composite evidence projection constructed a non-UUID run_id before the signed-share publisher required a UUID
symptoms:
  - "a UUID run_id from --run-json or --run-id is required for a share link"
  - "ValueError: badly formed hexadecimal UUID string"
tags:
  - evidence
  - composite-benchmark
  - signed-share
  - uuid
sources:
  - PR #1299
  - commit 6dc35920ab8398586bde0534aa40b3ac760c5c46
  - commit ba50405e3fc3d1ba3cae40906cf248ef96dab12d
repro: scripts/tests/publish_evidence_links_composite.test.sh
status: fixed
---

## Problem

Integration with the incoming signed benchmark-share publisher exposed a local
contract mismatch before a new campaign was launched. The branch publishes each
root of a composite task as a separate evidence bundle, because its aggregate
comma-joined agent ID and nested stage logs cannot be resolved as one root by the
Hub. Those bundles used `<source-run>.evidence.<root>` as their run ID. The incoming
publisher and backend share-token verifier require a UUID run ID.

The merged draft retained the existing projection and therefore could not sign a
composite evidence run. This is an integration defect caught locally, not a new
live benchmark failure or a diagnosis of an earlier publication timeout.

## Diagnosis

The first bad boundary is the identifier returned by
`evidence_bundle_for_agent`. Removing projection would lose the exact root's
captured transcript; loosening the share-token format would discard the incoming
contract. The source run and exact root already provide a stable identity for a
separate evidence-only run.

Archive searches used `badly formed hexadecimal UUID string share link run_id`
and `composite durable evidence projection publisher`. The related
[shared code lifecycle classification case](2026-09-10-shared-code-lifecycle-misclassified-as-browser.md)
owns task-type recording checks, while the
[publisher timeout case](2026-09-30-durable-publisher-timeout-without-phase-evidence.md)
retains an unlocalized latency failure. Neither owns this identifier mismatch;
their guards and claim limits remain unchanged.

## Solution

Derive the projection run ID with UUIDv5 from a domain-separated source-run and
exact-root identity. Preserve `source_run_id`, the original captured stage logs,
task result, aggregate source bundle and existing projection metadata. Repeated
publication selects the same evidence ID; distinct roots and source runs select
distinct IDs in the permanent controls.

The merge retains the incoming signed fragment link, shared-agent API and fresh
browser transcript verification. It also retains the branch's exact
zero-allocation receipts, explicit code/browser identity, terminal recording
checks and Claude Code transcript mirroring. Private campaign publication and
finalization now require the exact `verified in fresh browser` result rather
than the earlier `verified reachable` label. Their 180-second publisher and
1800-second allocation-to-durable bounds are unchanged.

A second owning integration control caught the incoming Node verifier importing
Playwright from the repository root, where no dependency is declared. Native
controller inspection observed that root resolution failed, while the installed
backend package resolved Playwright. The verifier now anchors `createRequire`
to `back-end/package.json`, preserving every incoming fresh-browser assertion.
It uses the existing declared package instead of requiring an incidental root
installation.

## Reproduction and validation

The same final permanent fixture was executed against the merged draft with the
old projection and against the repaired publisher:

```bash
cd /Users/andyprevalsky/Developer/rose-pr1299
source agents/venv/bin/activate
bash scripts/tests/publish_evidence_links_composite.test.sh
```

The first run returned 1 in 0.112 seconds with
`ValueError: badly formed hexadecimal UUID string`; the second returned 0 in
0.081 seconds. The test hash was identical. It requires a canonical UUIDv5,
deterministic identity, distinct source/root IDs, unchanged failure verdict and
captured transcript, an unchanged aggregate source bundle, and refusal of a
missing captured stage. Existing browser validation controls passed separately
in 0.063 seconds through
`bash scripts/tests/publish_evidence_links_browser_validation.test.sh` with the
same activated virtualenv.

The same final browser-validation fixture also executes the actual Node verifier
in a temporary layout containing only a backend Playwright stub. The stub stops
at the launch boundary before creating a browser. Against the original root
import this fixture returned 1 in 0.156 seconds with
`Cannot find module 'playwright'`; with backend-anchored resolution it returned
0 in 0.134 seconds. The test hash was identical. All existing recording and
terminal assertions run in that same fixture. `node --check` also passed.

Three existing type-ignore comments were then removed from the touched fixture;
its embedded Python AST remained identical. The final byte-identical test was
replayed in a private isolated copy, with the original root-import verifier and
the final backend-import verifier: RED 0.191 seconds, GREEN 0.123 seconds.
Original receipts remain retained alongside the final-hash receipts. The exact
repeated command was:

```bash
source agents/venv/bin/activate
bash .context/acceptance/proof87-publisher-integration-rca/final-import-fixture/scripts/tests/publish_evidence_links_browser_validation.test.sh
```

These are existing Step 4s commands in `.claude/commands/deploy.md` and
`scripts/run-deploy-structural-gates.py`; the existing durable-evidence suite also
invokes them. No new test stage, model request, provider browser allocation,
public publication or production environment write was made. Private source,
logs and receipts are retained under
`.context/acceptance/proof87-publisher-integration-rca/`.

This closes the bounded identifier and dependency-resolution defects. It does not establish deployed
signed-share readiness or give benchmark acceptance credit. Native presence-only
inspection initially found the controller share secret absent and its root
Playwright import unresolved; the installed frontend/backend Playwright packages
resolved but their Chromium executable was absent. The package-resolution repair does not install Chromium. A subsequent parent
read of the authoritative Render environment verified that the production share
secret already exists; its value was retained privately for scoped reuse, with
no production write or rotation. The deployed verifier and publisher must use
that same existing secret, and the fresh-browser runtime must be prepared and
verified before a live campaign can depend on this path.

## Human feedback

The user required genuine task failures to remain distinguishable from
infrastructure failures, robust permanent verification without massive reruns,
and preservation of resource and evidence ownership. The repair therefore
keeps signed-link and fresh-browser checks together with the existing terminal
and exact-owner defenses, uses the existing focused fixtures, and changes no
tasks, prompts, models, evaluators or deadlines.

## Reusable lesson

Keep evidence projection identifiers within the downstream publication contract while preserving exact source and root provenance.
