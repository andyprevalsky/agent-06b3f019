---
id: 2026-10-15-exact-profile-read-accepted-missing-record
date: 2026-10-15
title: Exact Lantern profile retrieval accepted an absent record as billable success
surface: agents
component: people-search
classification: our-bug
problem_class: other
first_bad_boundary: execute_people_search validated profile rows as a list but accepted zero rows for an exact source ID before the manager marked success
symptoms:
  - Exact-ID enrichment must reject HTTP200 items[] instead of empty success
  - Missing enrichment must fail before returning billable success usage
  - SOURCE_RECORD_NOT_FOUND
tags:
  - lantern
  - enrichment
  - source-identity
  - billing
sources:
  - commit 19b3f5bb924e4354f0d9908136b94c54a6b2bd71
  - PR #1510 CodeRabbit inline 4289126759
  - task .context/lantern-enrich-missing19b/.context/enrich-missing-rca/red-checkpoint.json
repro: cd agents && /home/boxes/rose/agents/venv/bin/python /tmp/lantern-review-reds-run-owner.py people-search
status: fixed
---

## Problem

A review reported that native HTTP 200 with `items: []` for exact-ID enrichment
became successful `results: []`. The manager then used the normal finished event
and per-query cost path. The registered people-search owner reproduces this
without live provider, credentials or database access: its actual activity receives
the native response through the existing HTTP transport fixture. A second case
runs the actual manager into that activity and rejects billable empty success.
No actual production charge or failing live benchmark is asserted by this case.

## Diagnosis

The request builder requires an exact source ID for enrichment. Response validation
rejected malformed rows, multiple profiles and mismatched nonempty identity, but
its missing-record branch was absent. The guarded mismatch check explicitly skipped
empty normalized results. The first incorrect boundary is therefore the service's
cardinality validation, before the manager's otherwise-correct success billing.

Archive searches for `Lantern enrichment missing record empty items source identity`
and `people search empty enrich billing error missing source record` found related
broker and grant-lineage cases, not this missing-result invariant. This is a new
response contract defect, not a recurrence of those credential issues. The golden
reference `claude-code-src/src/tools/FileReadTool/FileReadTool.ts:610-647` similarly
surfaces an absent explicitly requested resource as an error instead of empty
successful content. Bounded searches in OpenClaw, Hermes and Codex found no closer
Lantern exact-profile contract. No reference implementation is copied.

## Solution

After row-shape validation, reject empty enrichment rows through the existing
non-retryable LanternPeopleError factory with SOURCE_RECORD_NOT_FOUND. There was
no existing dedicated missing-record code in the people-search tool. Keep empty
discovery successful, and preserve multiple-result disambiguation, exact identity
mismatch, native auth/broker selection, retry bounds and provider selection.

The exact executed command on both sides was:

```bash
cd agents && /home/boxes/rose/agents/venv/bin/python /tmp/lantern-review-reds-run-owner.py people-search
```

This wrapper installs process-only offline configuration placeholders, then uses
runpy to invoke `scripts/run_blackbox_tests.py people-search`, the normal registered
owner entrypoint. It does not load live credential files or replace the activity,
service, manager or transport boundary under test.

The same normal people-search owner fails before and passes after the two-line
service change. Both unpinned and generation-pinned IDs are covered. The manager
case preserves an ERROR event, zero cost and no successful usage return; exactly
one native request proves no retry or discovery fallback. Existing successful
profile/null-field, empty discovery, mismatch, broker and FastMode cases pass too.
The broker authority helper and selection block remain byte-identical; its
previous review scope has not changed despite the service file's new hash.

The initial post-fix execution exposed a test-only metadata lookup error: the
established key is toolStatus, not status. Correcting that lookup did not weaken
the asserted ERROR/no-FINISHED/zero-cost contract. The exact original runtime was
restored and the final test was observed RED, then rerun unchanged GREEN after
reapplying the guard. All initial and final logs are retained in the listed
artifact directory. Full deployment gates and any live acceptance are separate
root-owned work; these are owning offline causal receipts.

## Human feedback

None recorded.

## Reusable lesson

Validate required exact-identity result cardinality before converting a provider response into successful output or billable usage.
