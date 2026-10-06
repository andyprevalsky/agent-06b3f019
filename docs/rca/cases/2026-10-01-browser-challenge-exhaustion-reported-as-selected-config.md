---
id: 2026-10-01-browser-challenge-exhaustion-reported-as-selected-config
date: 2026-10-01
title: Failed browser config search was reported as a selected browser without CDP
surface: agents
component: spawn-browser-agent-v3 challenge recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "recover_from_challenge classified an explicit success:false config-search result as config_selected"
symptoms:
  - "Challenge recovery selected a browser without a CDP URL"
  - "ChallengeConfigSearchExhaustedError: No stable browser configuration cleared the challenge"
tags:
  - browser
  - challenge-recovery
  - result-contract
  - cloud-benchmark
sources:
  - commit 7d3d18c923fe1cad75176a8109ac12d1b72e578a
  - fleet run 20261001-102223-31053
  - PR #1299, private proof86-browser-error-review receipts and original controller/publication archive
repro: agents/tests/blackbox/challenge_recovery.blackbox.py::test_config_search_failure_preserves_backend_error_without_selecting_browser
status: fixed
---

## Problem

Manual review of the first campaign slice found a browser action error before
the 300-second backstop: `Challenge recovery selected a browser without a CDP
URL`. The same static message appeared in `polar-odysseys-71f8e3e9b5a2` at
10:31:37.732 UTC and `polar-bu-023` at 10:33:01.966 UTC. It did not describe a
selected provider session with a missing connection URL.

The ten-task slice had passed native lifecycle, correlated LIVE-query and
durable publication checks. That did not establish absence of an internal
browser action defect. The original slice was retained and rejected with zero
credit; the campaign did not continue.

## Diagnosis

For each affected action, the backend's first search tried six configurations.
Every configuration was allocated and probed, returned zero stable passes out
of one attempt, and logged that it remained challenged. There were no candidate
creation or probe exception events in those searches. The backend then emitted
`ChallengeConfigSearchExhaustedError: No stable browser configuration cleared
the challenge` and returned HTTP 503. Its lane-search event carried the same
browser task ID as the action error. Individual candidate events omit that ID;
their attribution uses the exact per-task backend archive and search interval.

The result crossed these boundaries:

1. `repo.recover_browser_challenge` correctly decoded HTTP 503 into a mapping
   with `success:false`, the original error, failed config keys, blacklist
   state and status code.
2. `challenge_recovery.recover_from_challenge` unconditionally wrapped that
   mapping in a `config_selected` result.
3. The handler treated the mapping as a winner and reached its valid
   successful-winner missing-CDP guard. Its ordinary action error branch then
   reported the wrong reason.

This is a result-contract and diagnostic defect over a normal exhausted search.
The evidence does not show a promoted provider omitted CDP, and does not prove
that correcting the report will clear the site's challenge or improve its
benchmark result. Browser execution continued after the action error.

Archive searches for `config_selected`, `failed_config_keys`, `No stable browser
configuration`, `without a CDP URL` and recovery HTTP 503 found related challenge
exhaustion and stale caller-contract cases, but no owning regression for this
explicit unsuccessful result.

Related cases are
[2026-09-04-browser-recovery-stale-keyword-crashed-provider-rotation](2026-09-04-browser-recovery-stale-keyword-crashed-provider-rotation.md),
which records caller/callee keyword drift, and
[2026-08-21-alchemy-evaluate-recovery-error-fails-no-tool-failures](2026-08-21-alchemy-evaluate-recovery-error-fails-no-tool-failures.md),
which records recovered stale-DOM errors being counted as terminal failures.
Neither owns this explicit failed-search result being labelled as a winner, so
this is a separate case rather than a recurrence of either fix.

## Solution

The recovery orchestrator now rejects an explicit `success:false` search result
before constructing `config_selected`. A `RuntimeError` subtype retains the
complete failed result on `result` and uses its original error text. The existing
handler therefore reports an ordinary failed browser recovery action. Its
purported-success missing-CDP guard remains unchanged, as do successful legacy
results without a `success` field. No retry, task deadline, provider verification,
model, prompt or evaluator was changed.

## Reproduction and validation

The new case in the existing owning blackbox uses the real repository HTTP
codec with an offline `httpx.MockTransport` HTTP 503 response, then calls the real
recovery orchestrator. The identical final case failed on the original source
in 0.635 seconds because it returned `config_selected`; it passed after the
repair in 0.361 seconds. It checks the original failed result metadata and error,
unchanged source browser state, a normal HTTP 200 winner, and a purported HTTP
200 success without CDP that must still reach the caller's guard.

The exact focused command executed before and after the repair was:

```bash
cd /Users/andyprevalsky/Developer/rose-pr1299/agents
source venv/bin/activate
python /Users/andyprevalsky/Developer/rose-pr1299/.context/acceptance/proof86-browser-error-review/repro/run-permanent-case.private.py
```

That retained runner loads the permanent blackbox file, forbids live socket
connections and executes
`test_config_search_failure_preserves_backend_error_without_selecting_browser`.
The unchanged pre-fix assertion was:

```text
AssertionError: Failed backend search was incorrectly represented as config_selected
```

Its recorded return code changed from 1 to 0 with identical runner and test
hashes. The complete owning-domain command, executed once after the fix with
the same activated virtualenv and working directory, was:

```bash
python tests/blackbox/challenge_recovery.blackbox.py
```

The complete existing challenge-recovery domain passed all 28 cases once in
0.361 seconds. The activated virtualenv and `agents` working directory were
used. The focused reproduction forbids live socket connections. No live browser
or model calls were made for this repair.

Private bindings are under `.context/acceptance/proof86-browser-error-review/`:
`permanent-case-red.receipt.private.json`,
`permanent-case-green.receipt.private.json` and
`owning-domain-green.receipt.private.json`. The original controller/publication
archive is `/data/proof86-original-20261001/original-controller-and-publication.private.tar.gz`,
SHA-256 `f8afa564f5f10ae65a4e11224a338adad267a720a38db141478ac4f84fc9b9fb`.

The new callable is registered as `config_search_failure_preserves_backend_error`
in that file's `run_all_tests`. Both `agents/scripts/run_blackbox_tests.py` and
`agents/scripts/run_coverage_blackbox_parallel.py` discover its existing
`challenge-recovery` domain by filename. The coverage runner executes that same
registration under instrumentation through `agents/scripts/run-coverage.sh`;
[/deploy Step 4g](../../../.claude/commands/deploy.md) runs it as part of the
canonical agents coverage/blackbox command, including the unchanged fast-cache,
unit-test and coverage-threshold tails. No new stage or duplicate full-domain
execution was added.

The original timing events are retained in the per-task backend archives and
the private `provider-candidate-events.private.json`,
`backend-causal-errors.private.json`, `search-identity-correlation.private.json`
and `action-provider-correlation.private.json`. The retained private runner and
red/green receipts bind the focused command, source/test/log hashes and elapsed
time; the owning-domain receipt also records its command explicitly.

## Outcome and scope

The deterministic owning failure is repaired and independently reviewed. The
canonical agents gate passed in 301.419 seconds: 103 blackbox domains, 162
fast-cache cases and 102 unit cases, with 81% displayed coverage against the
unchanged 80% threshold. All 935 recorded inputs remained unchanged and both
native gate owners retired. This proof binds the repaired working-tree inputs
on checkout `7d3d18c923fe1cad75176a8109ac12d1b72e578a`; it does not cover later
integration changes. The 100-task campaign remains a separate acceptance
objective. No website/task-success improvement or acceptance credit is claimed.

Separate review classified the two other pre-backstop browser errors as stale
element-index action misses; both were followed by successful actions on the
same browser task. Pause-time browser, explore and code-agent messages matched
their existing cancellation handlers. Those observations do not waive recording,
publication, query-correlation or exact provider teardown requirements.

## Human feedback

The user allowed genuine task FAILURE but required zero INFRA failures, and
asked for robust permanent benchmark-runner regressions without massive
verification. The review therefore traced the actual action errors rather than
crediting lifecycle/query/publication checks alone, preserved the failed slice,
and added one compact case to the existing owning suite. It did not retry the
task to chase business success, alter its settings, or add a broad new stage.

## Reusable lesson

Validate explicit failed-search results before declaring a selected browser,
and preserve their original error and metadata through the ordinary action
failure path.
