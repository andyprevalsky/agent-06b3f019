---
id: 2026-11-10-local-worlds-scorecard-reader-missed-native-custody
date: 2026-11-10
title: Local-worlds scorecard ignored native cohort custody and accepted contradictory pass flags
surface: harness
component: scripts/cloudbench-scorecard.py local-worlds adapter
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the scorecard reader did not consume local-worlds journals and child result custody; its candidate positive-verdict path also bypassed strict passed-boolean validation
symptoms:
  - no recorded artifacts
  - UNRECORDED scheduled/source despite native local-worlds results
  - positive canonical verdict with passed false could classify PASS
tags:
  - benchmark
  - scorecard
  - local-worlds
  - result-custody
sources:
  - plan:.context/agentcard-stability/local-worlds-scorecard/red-green-final.json
  - plan:.context/agentcard-stability/local-worlds-scorecard/receipt.json
  - plan:.context/agentcard-stability/local-worlds-scorecard/applied-public-checks.json
repro: python3 scripts/tests/cloudbench-scorecard.test.py, LocalWorldsScorecard cases; benchmark-scorecard deploy structural registration
status: fixed
---

## Problem

Reading round02's native local-worlds parent directory returned UNRECORDED
scheduled/source although eleven child canonical results and ownership receipts
existed. Operators used honestly scoped child cards, not fabricated aggregate
HTML. Private review then reproduced a candidate false-positive path: positive
verdict plus false/nonboolean passed could produce PASS. The latter is an owning
fixture failure, not an observed corrupt native browser result.

## Diagnosis

Canonical local runner -> local-worlds.json -> exact child result index and
canonical grade -> reader adapter -> existing renderer. The reader omitted this
native producer shape. Adding the adapter exposed a second first-bad admission
boundary: trusting a positive verdict before checking passed is exactly True,
including fallback paths without an index.

Literal ownership/report strings and behavioral report-card cleanup/local-worlds
searches found no duplicate. The related case
2026-10-26-local-scorecard-used-fleet-only-lifecycle-state repaired nonterminal
status mapping for a single report; it did not read coordinator/child custody.

## Solution

Reviewed patch b659c701facde424a559849804abae7ef11f691ee8fc3039ee5b955c5629b9a9
adds a native reader adapter using existing journals, exact child result custody,
source and cleanup evidence. It retains scheduled denominators, cancellations,
SKIP and unknown classifications; missing parent clocks stay unmeasured. Positive
canonical grades require passed is exactly True before indexed or fallback
classification. Contradictory records become UNKNOWN, never invented PASS.

Identical private causal command:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 .context/agentcard-stability/local-worlds-scorecard/run-owning.py
```

The final strict-flag receipt records16 false-PASS subcases red, then six owning
cases green: passed false/null/string/numeric, failed/failed-retained world,
with/without index. The separate native artifact reader command was:

```bash
python3 .context/agentcard-stability/local-worlds-scorecard/candidate/scripts/cloudbench-scorecard.py .context/benchmarks/agentcard-v2-stability-20261109-partial11-round-02-worlds --json --ledger .context/agentcard-stability/local-worlds-scorecard/empty-ledger.jsonl
```

Both CLI invocations exit0; the observed defect is the output, UNRECORDED before
versus eleven PASS afterward. This re-reads retained native artifacts; it is
neither a new browser experiment nor additional stability credit.

Applied public verification records52 tests PASS using
`python3 scripts/tests/cloudbench-scorecard.test.py`. The initial unittest
filename-discovery invocation found zero tests/exit5 and receives no test credit.
The direct suite is registered as benchmark-scorecard in
scripts/run-deploy-structural-gates.py. No native journal, task result, prompt,
fixture, timeout, source clock or financial state was rewritten. The original
round01 ERROR/false-card and round05 signup FAILED remain authoritative.

## Human feedback

Use the existing native reader/renderer instead of a new dashboard or synthetic
summary bundle. Preserve unknowns, strict boolean/custody checks and original
counts. Public owning tests verify reporting; they do not make a failed E2E pass.

## Reusable lesson

Adapt native custody at one reader boundary and require independent positive-grade facts to agree before reporting PASS.
