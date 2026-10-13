---
id: 2026-10-13-human-report-prefixed-read-only-json-output
date: 2026-10-13
title: Benchmark launch instructions were emitted before a read-only JSON preview
surface: harness
component: benchmark-cli-output
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench stability-proof emitted benchmark_agent_instructions before delegating --dry-sample to its JSON-only owner
symptoms:
  - "json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)"
  - "FAIL: capability slices reused or excluded a task"
  - "stability-proof --dry-sample returned human instructions before JSON"
tags:
  - benchmark-cli
  - stdout
  - json
  - dry-sample
  - reporting-contract
sources:
  - commit b12f0ef0521766d65d1199f143fb5de54a7ac885
  - commit 71b6d2718ed7ea7953f253b20ca4902296a43df9
  - agent 07281fc3-5e49-4cd2-9573-235cb19b0481
repro: scripts/tests/fleet-infra-stability-proof.test.sh
status: fixed
---

## Problem

After main was integrated at `71b6d2718`, the ordinary local controller gate
failed while parsing a capability sample. The existing command
`scripts/run-bench stability-proof --dry-sample --runs 3 --width 10 --seed 20260908 --exclude-file <fixture-file>`
returned the canonical human reporting instructions before its JSON document.
The unchanged consumer in `scripts/tests/fleet-infra-stability-proof.test.sh:108`
passes the complete stdout to `json.loads`; it failed with
`json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)`.
Its enclosing diagnostic was `FAIL: capability slices reused or excluded a task`.
The task-uniqueness and exclusion assertions had not executed, so that diagnostic
does not establish task reuse or an actual fleet outcome.

The parent investigator preserved the unchanged owning command's failure in
`.context/google-session-rca/report-preview-before.log` and its later success in
`report-preview-after.log`. This was found during validation of the Google
session investigation; it is a separate CLI defect. It does not establish that
Google accepted a transferred profile, explain a Google security challenge, or
close `2026-10-12-cookie-bundle-ranking-used-sso-recency`, which remains open.

## Diagnosis

The incoming `b12f0ef05` launcher called `benchmark_agent_instructions`
unconditionally in its `stability-proof` branch. That function writes
`.claude/shared/benchmark-report-format.txt` to stdout. The delegated owner
`scripts/run-fleet-infra-stability-proof:56` expressly promises that
`--dry-sample` prints the slices as JSON and launches neither Fly nor a fleet;
its branch at line 162 executes the sampler before any fleet startup. The
first bad boundary was therefore the wrapper's extra stdout write, before a
valid machine-output producer. No sampler, task-selection, parser, model, or
provider failure was needed to produce the observed exception.

The deepest proven owned gap was failure to distinguish an actual benchmark
launch from a read-only preview when applying the launch reporting contract.
Help is a sibling read-only command. Removing the reporting contract from all
launches would violate the newly established human contract; repairing the
downstream parser to discard a prefix would hide the wrong output boundary.
The narrow repair keeps the complete canonical contract on launches and omits
that write from read-only delegation.

Archive searches used `JSONDecodeError Expecting value stdout` and
`human report dry-sample JSON stdout machine-readable`, followed by literal
stdout and contamination searches. The atomic-publication case
`2026-08-03-non-atomic-pid-file-publication` shares the parse error but produces
incomplete files, not prefixed stdout. The related
`2026-09-30-cloud-terminal-json-selected-lossy-progress-stream` chooses a lossy
display stream instead of a complete artifact. Neither records this cause;
this is a distinct output-ownership incident rather than a recurrence.

Golden-reference review searched all four locally registered harnesses for
JSON stdout and human diagnostics. `claude-code-src/src/utils/streamJsonStdoutGuard.ts:29`
describes and enforces protection against non-JSON stdout writes in structured
mode. `openclaw/src/cli/json-output-mode.ts:46` routes incidental notes and
console logs to stderr in machine-output mode. `hermes-agent/hermes_cli/stream_json.py:1`
reserves stdout for protocol records and stderr for diagnostics, and
`codex/codex-rs/exec/src/lib.rs:1` states the same separation, with distinct
human/JSON processors at line 890. The repair converges on their common output
ownership rule; it deletes an unnecessary human write from a non-launch path
rather than installing a general stdout filter.

## Solution

The `scripts/run-bench` stability-proof branch identifies its existing
read-only preview/help options before printing launch instructions. Its scan
respects the delegated parser's value-taking options, so a pool-file value
literally named `--help` does not change the invocation into a help command.
It still delegates the original arguments to the existing capability owner.
The canonical reporting asset, sampler, task pool, disjointness/exclusion checks,
concurrency bounds, timeouts, success criteria, and cleanup rules are unchanged.

The identical permanent owning command was run on both versions:

```bash
bash scripts/tests/fleet-infra-stability-proof.test.sh
```

Before: the unchanged JSON parser failed and the suite exited unsuccessfully.
After: the parser accepted the complete stdout; the existing assertions still
required 30 distinct task names and exclusion of the supplied task. All fleet
infra structural checks passed, including the suite's 27 Python checks in
26.940 seconds. Pre-fix elapsed time was not recorded in these artifacts.
The test remains invoked by `scripts/run-cloudbench-controller-gate:53` and
the existing descend command test. It uses local fake fleet controls and
provides no paid capability-run or deployed production acceptance credit.
The combined deployment gates remain the release owner's responsibility.

Adversarial review found that an initial raw argv scan could misclassify an
option value spelled `--help` or `--dry-sample` as a flag. The existing
`scripts/tests/approval-format.test.sh` public-launcher fixture gained controls
requiring a complete contract before its fake runner for those option values,
and requiring no contract for actual read-only flags. The same expanded test
failed before the scan respected option arity, then passed afterwards;
evidence is `.context/google-session-rca/report-arity-before.log` and
`report-arity-after.log`. No provider was launched by those controls. The final
unchanged fleet proof rerun also passed all 27 checks in 26.926 seconds.

Separate test maintenance accompanies the CLI repair: scripts-only campaign
fixtures now include the exact canonical reporting asset required by the real
launcher, and the descend test applies its banner prohibition outside balanced
approved text fences. Existing strict approval-format checks still verify the
fenced scorecard structure. These corrections do not change the primary
runtime cause or remove task, grouping, admission, or cleanup assertions.
The independently reported focused campaign checks passed 2 Python cases and
24 TypeScript cases; those results certify their fixture maintenance, not a
fleet campaign outcome.

This is O(argument count) work at one CLI dispatch, with no per-agent polling,
shared lock, resource admission change, or additional work at 10,000 agents.

## Human feedback

None recorded for this separate CLI regression.

## Reusable lesson

Apply human launch reporting only to actual launches and preserve machine-output stdout unchanged on read-only CLI paths.
