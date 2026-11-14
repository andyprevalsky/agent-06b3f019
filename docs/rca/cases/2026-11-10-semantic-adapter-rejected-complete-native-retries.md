---
id: 2026-11-10-semantic-adapter-rejected-complete-native-retries
date: 2026-11-10
title: Semantic adapter discarded completed assertion failures after the canonical CI retry
surface: harness
component: deploy-semantic-native-result-classification
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: classify_lane accepts only one retry-zero result although the canonical semantic driver retries failures once
symptoms:
  - semantic-stack UNVERIFIED with complete false despite complete native failed test reports
  - len(results) != 1
  - 55 passed and 3 failed UI tests became 55 PASS and 3 UNVERIFIED native cases
tags:
  - deploy
  - semantic
  - playwright
  - retry
  - evidence
sources:
  - PR #1915
  - PR #1918
  - PR #1919
  - commit 009e97401550115295b42af9ef83be37bda55055
  - plan: .context/rca-playwright/semantic-retry/findings.json
repro: scripts/tests/deploy-test-semantic.test.py::SemanticReports.test_complete_native_retries_preserve_terminal_assertion_failure
status: fixed
---

## Problem

The source-bound native semantic gate completed with 55 UI successes, three UI
assertion failures and five latency successes. Every failed UI assertion ran
both its initial attempt and the canonical single retry. The final adapter
receipt nevertheless reported UNVERIFIED and complete=false. All before/after
hooks completed, the stack was ready, exact source remained unchanged, native
exit was one and cleanup was positively confirmed. The three UI defects are
separate, evidence-matched repairs owned by PR #1916; this case owns only loss
of their terminal failure classification.

## Diagnosis

The request-to-result path is canonical Playwright configuration -> native JSON
report and lifecycle reporter -> classify_lane -> composite worker receipt ->
deploy cycle. The first bad boundary is classify_lane's one-result/retry-zero
assumption. The report contains 61 UI attempts (55 passes and six failures),
with 122 successful hook-end records. Each failed test has two results and
exactly eight complete lifecycle events, so the old guard drops it before
examining the terminal native failure.

An immutable captured-report replay asserts 55 PASS, three FAIL and five latency
PASS. It fails against the original classifier with three UNVERIFIED cases.
The exact same capture and assertions pass against the strict candidate. The
classifier, native reporters, driver configuration and existing owning tests
are byte-identical between base 145b59fe8 and repaired-SDK source 009e97401:
Gate: NOT_INTRODUCED for this additional reporting failure. The assigned
Playwright runtime repair remains independently owned and cannot be waived.

Archive searches used semantic native retries, retry attempt complete and
UNVERIFIED assertion failure vocabulary. Related semantic inventory/evidence
cases do not supply this diagnosis: the actual immutable retry chain identifies
this distinct contract mismatch. Golden reference: not applicable (code-only
operational reporting; no approval-gated hunk).

## Solution

Validate each observed attempt's contiguous retry index, exact lifecycle shape,
successful before/after hooks and matching report/event status. Require failed
terminal chains to exhaust their declared native retry budget. Preserve every
complete terminal assertion failure as FAIL. Missing originals or final attempts,
gapped, duplicated, reordered or interrupted attempts, failed hooks and incomplete
reports remain UNVERIFIED. A first-attempt pass remains PASS. Retried recovery
remains conservatively UNVERIFIED until its existing FLAKY attribution channel
is positively corroborated; this patch does not invent an ordinary PASS.

This unifies the one-attempt and repeated-failure validation in the existing
classifier. Deleting lifecycle checks would weaken the contract; per-attempt
validation is required because the native driver intentionally emits retries.
The execution recipe, retries, assertions, deadlines, inventories and native
records are unchanged. No retained result is rewritten. The regression extends
the existing deploy-test-semantic suite, already registered in the deploy
structural gate, rather than adding a new validation system.

The permanent existing-suite regression was executed against the original source
and failed with UNVERIFIED instead of FAIL. After applying the reviewed code,
the identical command passed:

`TMPDIR=/tmp agents/venv/bin/python -B scripts/tests/deploy-test-semantic.test.py SemanticReports.test_complete_native_retries_preserve_terminal_assertion_failure`

The full owning suite passed all twelve tests in 2.822 seconds. The immutable
captured replay also passes against the actual repository classifier (SHA256
ca97c9e6d191861cc9af699c6f8a48d55fc1b9b265e9c9f6612ecb81e444254a),
retaining three native UI failures rather than reporting an aggregate PASS.
Independent adversarial review rejected earlier drafts for missing retry-budget,
closed-world inventory and malformed-object controls. Those objections were
reproduced and corrected; the accepted review separately ran thirty adversarial,
twenty supplied and eighteen general-budget controls (sets may overlap).

The existing real-reporter fixture now explicitly writes its output into its
private temporary directory: Playwright otherwise selected the nearest package
root and emitted untracked test-results into the frozen checkout. Its assertions
and native fixture execution remain unchanged. Local Node resolution controls
run with TMPDIR=/tmp, outside the repository's installed dependency ancestors.

Final source-bound native gate validation and deployment remain required;
these local checks do not upgrade the original receipt or the three UI grades.

The full native rerun on commit 8187414b0fe70a2f1f114a05ebac141b9703bc49
completed with 55 UI PASS, three UI FAIL and five latency PASS. Its aggregate is
now correctly FAIL with complete=true, native exit one, unchanged source and
verified stack cleanup. The same three assertions remain separately attributed
to the existing UI repair owner; the original UNVERIFIED receipt is unchanged.

CodeRabbit review 5836575916 identified a valid remaining caller defect:
`_execute` accessed the last event after `classify_lane` had rejected a non-object
JSONL record. The permanent existing-suite regression appends each of 1, an empty
list, a string and null to an otherwise complete native lifecycle. All four
reproduce AttributeError against 8187414. Rejecting non-object events inside the
existing lane try/except preserves UNVERIFIED and the `ui: ValueError` diagnostic
without broadly suppressing programming errors. The identical regression then
passes, as does the full thirteen-test owning suite. Cleanup, native exit, the
healthy latency lane and the original malformed record are explicitly retained.
The immutable prior capture still produces its three FAIL results. Final
validation must bind this additional caller repair to its own frozen source.

## Nested native report boundary (B1)

The follow-up candidate passed independent review: all 14 owning tests and 46
adversarial controls. Its implementation is included in this stabilization.
B1 is owned even though it also exists on 1f81 and published 9905809. On the actual existing worker caller fixture,
`report['suites'] = [None]` escapes receipt creation with AttributeError in
`specs()`. Adjacent malformed suite/spec collections and test objects either
escape similarly or lose the lane diagnostic.

What: worker receipt creation fails instead of retaining UNVERIFIED evidence.
Where: parsed native UI JSON -> classify_lane -> specs/test-object access ->
unchanged lane handler in _execute -> deploy_test_worker.execute.
Why: nested JSON collections/objects were used before their type contract was
checked; the lane catches typed evidence errors, not arbitrary AttributeError.
Proof: the identical permanent owning caller regression fails on exact published
9905809 and passes on this private candidate, with all 13 original tests passing.
Problem class: unvalidated nested evidence shapes escape typed lane rejection.

Validate the existing suites/specs/tests envelope while traversing it, before
classification's conservative catch. Reject malformed collections and objects
with ValueError so the unchanged lane handler records `ui: ValueError`, leaves UI
UNVERIFIED, and retains the healthy latency PASS. No AttributeError catch is
added. Deleting report traversal or its contract would discard required native
coverage; one traversal validates every accessed nested object without adding an
alternate classifier. Results/config/project object guards already exist and
remain unchanged. Retry, inventory, lifecycle, source, cleanup, deadlines and
coverage checks are untouched. At 10k agents this adds only linear traversal of
one worker's existing report; no shared state, locks, queries or subscriptions.
Golden reference: not applicable (ordinary code and owning test changes).

The added test writes malformed raw native report bytes inside the existing
fixture, then calls actual deploy_test_worker.execute. Thirteen malformed shape
subtests check diagnostic, aggregate UNVERIFIED/complete=false, UI UNVERIFIED,
latency PASS, native exit one, unchanged source, cleanup true, no interruption,
and exact retained raw bytes plus artifact hash. Every original assertion remains
AST-identical in original order. The new test passes five consecutive runs.
Full 14-test owning suite and separately all exact published 13 test bytes pass
using a private import overlay with the real canonical __file__/ROOT, TMPDIR=/tmp
and -B; only original fixture cleanup signals its own fake child.

Immutable actual run 42915050171/attempt 23 remains 55 UI PASS, two UI FAIL and
five latency PASS under published and candidate; current remains 55 PASS/two
UNVERIFIED. Original native receipt, ten artifacts and reviewer evidence are
unchanged. This run's two genuine UI failures remain failures. No new native
acceptance or deployment is claimed. Exact commands, exits, timings and hashes
are in the private semantic-classifier-hardening packet. The independent review retained the original artifact hashes and every prior
assertion. Final combined-source native validation and deployment remain required.

### PR1918 recurrence on November 10

Native run 42922184900 on a5e1c0375238d99fdf52f28c8cb367df84310b70
reported 53 UI passes, five UI failures and five latency passes. Complete native
retry chains again became five UNVERIFIED cases under the old adapter. All nine
reporting/driver/config modules are byte-identical at base 1f1e176a4736b2f948ba2fa5ffb2b119a7edbbc9,
failed source a5e1c037 and the chat candidate b177933a. The immutable original
capture fails the exact same assertion on all three, then passes under the exact
published 9905809a46e392997e834801a3c7adce87267a10 implementation: 53 UI
PASS, five UI FAIL, five latency PASS, aggregate FAIL with complete=true,
native exit one and positive cleanup. The original receipt is never rewritten.

The existing owner supplied a three-path patch; independent reuse preparation
verified its hashes and base compatibility, ran the unchanged published permanent
regressions RED on the old code and GREEN on the reused code, and passed the full
thirteen-test suite. Parent integration independently reran all thirteen tests
and the unchanged actual-capture replay successfully. Only this existing repair
was reused; the owner's separate SDK/runtime changes were not imported. The five
underlying UI failures retain their own attribution and post-merge obligations.

The subsequent PR review found malformed suite and test objects could still
raise `AttributeError` outside the existing invalid-data fallback. Registered
shape cases reproduced three errors before adding that exception to the
fallback. All fifteen owning tests then passed, including a worker case that
writes an UNVERIFIED aggregate while preserving the other lane's result and
cleanup evidence. Independent review also retained a native FAIL in that other
lane; malformed evidence never receives assertion credit.

### PR1919 recurrence

PR #1919 independently reproduced the same boundary against its immutable
native capture from GH run 42922686197: the original adapter yields 53 UI PASS,
five UI UNVERIFIED and five latency PASS; the exact reviewed classifier from
commit 9905809a46e392997e834801a3c7adce87267a10 yields 53 UI PASS, five UI FAIL
and five latency PASS. The existing permanent retry regression fails on the
original classifier; all thirteen owning tests pass after exact reuse. No
original receipt, test assertion, retry budget or timeout was rewritten.
The underlying UI failures retain their own attribution and repair requirements;
this reporting correction grants none of them passing credit. At that point, final native
wrapper execution on PR #1919's frozen source remained pending.

## Human feedback

None recorded.

## Reusable lesson

Classify complete native retry chains using their declared attempt budget and lifecycle evidence while preserving original failure and uncertainty states.


## Required native evidence retention

The separate 1f81 native run retained genuine mobile and realtime assertion
failures on both attempts, with 55 UI PASS and 5 latency PASS. Their causes remain
UNKNOWN and blocking. The native bundle omitted already-created development
LLM dumps and numeric worker-log siblings; both mobile traces exceeded the
unchanged 64MiB/file cap. No original missing context or trace is reconstructed.

The existing GitHub collector now retains preexisting dumps and actual service
manifest log paths, including numeric worker siblings, ahead of bulk cache JSON.
It keeps 64MiB/file and 400MiB/total limits, symlink/private-config exclusions,
private transport and hash-bound captured-file manifest. Safe diagnostics record
only constructed tools URL origin plus agent/task/provider, and bounded monitor
state/close metadata. They do not expose URL tokens, objectives or raw events,
enable production plaintext dumps, change routing, or alter completion predicates.

Independent review reproduced and rejected two candidate defects: cache saturation
still displaced a valid 60MiB dump, and new diagnostic set membership raised on
malformed event types accepted by the original monitor. Corrected priority
snapshot ordering and tuple membership pass the identical controls. Permanent
regressions extend the existing transport and agent blackbox files; owning checks
pass 70 transport, 6 backend and 9 selected agent tests. Production monitor AST is
identical after removing diagnostic additions. These are capture-boundary proofs,
not fixes or acceptance for either timed product failure. The original required
semantic assertions, retries, deadlines, concurrency and provider choices remain
unchanged. Final combined-source native validation is mandatory.
