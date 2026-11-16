---
id: 2026-11-16-production-cli-overrode-explicit-github-credentials
date: 2026-11-16
title: Production CLI replaced explicit process GitHub credentials with dotenv credentials
surface: infra
component: deploy-production-github-auth
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_prod.py gh_setup selected back-end dotenv GITHUB_TOKEN over explicit process GH_TOKEN or GITHUB_TOKEN on boxes
symptoms:
  - "HTTP 401: Bad credentials"
  - "production-semantic exited 1 (run None)"
  - explicit process GH_TOKEN replaced by back-end dotenv GITHUB_TOKEN
tags:
  - deployment
  - github
  - credentials
  - precedence
sources:
  - PR #2411
  - commit 4a9d224abd5bf5ab1770237f2a8097762938a876
  - commit 562cc8c49008708918d15ee9844ab1c8c333062c
repro: scripts/tests/deploy-prod.test.py (OtherLanesTest.test_gh_setup)
status: fixed
---

## Problem

PR2411's first production attempt bound the frontend to merge
562cc8c49008708918d15ee9844ab1c8c333062c but semantic workflow dispatch
failed with HTTP401 at 2026-11-16T20:22:58Z before a workflow run existed.
Render, Vercel, Mac release and backend probes passed; these do not replace
semantic verification. Original `production-lanes.json` is FAIL, and the
semantic fields run_id, conclusion and completed_at are null.

The preserved receipts are under
`.context/rca-147bb3eb/production-first-attempt/`, including `manifest.json`,
`production.json`, `production-lanes.json`, and `logs/semantic.log`.
Parent separately captured expired primary401, App deployment-read403,
and an existing configured credential with deployment-read200 and suitable
actor/scopes. No provider call was performed by this RCA worker. A successful
read alone does not prove a subsequent workflow write succeeded.

## Diagnosis

Critical path: explicit process input -> gh_setup -> child environment ->
real gh binary -> semantic workflow dispatch. On boxes, gh_setup always
loaded back-end/.env GITHUB_TOKEN into GH_TOKEN, overwriting the caller's
explicit token. The first bad boundary is local input selection, before gh or
GitHub. The boxes wrapper still needs its existing real-binary override;
removing that override would reintroduce App-token behavior.

Gate: NOT_INTRODUCED for compared source4a9d224abd5bf5ab1770237f2a8097762938a876
and cached-main562cc8c49008708918d15ee9844ab1c8c333062c. gh_setup AST is
identical at those revisions. The same extended existing test has five
assertion failures against both immutable originals. This is not an attribution
claim against an unrecorded earlier baseline, and does not waive the repair.

The extended test asserts both token names, GH_TOKEN precedence when both are
nonempty, empty-input behavior, existing dotenv fallback, missing dotenv,
real binary selection and unchanged non-boxes explicit binary behavior.
Original assertions remain. Synthetic tokens only were used. Independent
review confirms the selection boundary and finds a separate inherited-token
redaction gap, retained below.

Archive/thread searches: production GH credential precedence, bad credentials,
gh_setup, credential and GitHub/token cases. The shipped poller repair owned by
ph72f9k1xmvrbz6cpqh191dcph8hx80s addressed quota/pool/GraphQL reads, not this
explicit-input overwrite. Stale Render-token and rotating guest-credential
cases are relatives with different boundaries. No active matching precedence
owner was established from the bounded search. No token rotation, automatic
credential fallback, or managed-settings write is a solution to this CLI bug.

## Solution

The initial two-file candidate selects nonempty process GH_TOKEN, then process
GITHUB_TOKEN, then existing dotenv GITHUB_TOKEN, retaining the real gh binary
and DEPLOY_GH_BIN propagation. It reports the selected source without exposing
its value. Pool reads, GraphQL fallback, workflow writes, provider acceptance,
source binding and production outcome guards remain unchanged.

Original candidate patch SHA256:
2c8cf1d4d2522368d8246d4253469443cd3177e5ee96fb75372c7963b3a0327b.
Candidate module SHA256:
4364b9bd70ef123b22575c27cf4f8ddb6a9ea4e2b26b0b8388bc6e08bda83a1f.
Unchanged extended test SHA256:
06000925669ef14f0924d06e12f4fc15d820492db850ab4ac93da107532962b4.
These identify the initial reviewed candidate, not later parent edits.

Exact original/candidate command from repository root:

```bash
TMPDIR=$PWD/.context/rca-147bb3eb/prod-auth-rca/tmp python3 -B .context/rca-147bb3eb/prod-auth-rca/run.py OtherLanesTest.test_gh_setup
```

Original exit1, five assertion failures; candidate exit0, one test passes.
`logs/red-boundary.log` and `logs/green.log` under that directory retain both.
`compare-base.py` exits1 with the same assertions against cached-main.
`run.py` with no case argument exits0, full owning suite90/90 in17.348s;
`logs/full.log` preserves the output. `stability.py` exits0, five consecutive
unchanged focused runs under one owned CPU load worker; each individual
run exits0. This is local one-core load evidence, not the canonical all-CPU or
Blacksmith stability gate. The runner asserts actual staged module identity
and logs module/test SHA256. The patch applied to original staging copies
compares byte-identically and the applied module passes the same assertion.
The canonical helper dependencies remained in the original checkout, so this
is not a frozen whole-dependency-graph proof.

Initial `logs/red.log` is a missing staged selector import error, retained as
a fixture mistake and excluded from regression proof. The corrected setup
uses unchanged source helpers and obtains the authentic assertion failure.
The existing deploy registry runs this suite as deploy-structural-gates /
deploy-prod. Golden reference: not applicable, ordinary operational code and
tests with no prompt/schema/trajectory change.

The initial independent review in
`.context/rca-147bb3eb/prod-auth-independent-review.md` found R1: the
unselected inherited process token was not registered for redaction, also
affecting both process tokens off boxes. This finding is retained as history,
not an unresolved disposition. The canonical follow-up registers both tokens
before any lane, pool or dry-run output. Its Fake/main integration assertion
uses distinct process and dotenv credentials, exercises the real semantic lane,
and checks propagation, binary selection and redaction in console/log/report/
dry-run for boxes and non-boxes. Against4cc087c5c2344daae2735f274b8b0e07d30ea822
it failed both branches; unchanged after the one-line fix it passed, then
passed five consecutive runs. The canonical full suite passed91/91 in16.452s.
The follow-up reviewer verified these receipts and returned PASS, no remaining
findings, on module SHA256
add5d38b0371698963fcbb23632987a883eb58f69229d11ad91077cf17bd5271
and test SHA256
70d0e28579b7028a99bd5c4f6ea25842700b525126584ba4988bd7755627e05a.
Exact commands/exits and original leaks remain under
`.context/rca-147bb3eb/prod-auth-r1/receipts.json` and adjacent logs.

Operations commit6e2496487add55f3416737566873573528474fd3 was delivered by
`/push`, preserving the existing provider/outcome/source guards. This limited
91-test validation is separate from PR2411's17-gate full deploy on4a9.
The subsequent semantic-only production retry passed at20:48:30Z with all
five jobs successful in run43951508861. It verifies target product562cc8 via
live frontend/spec source1ec28940191764ecf435ffc38b345006269bc95b;
workflow head is6e249. Its status is PASS-verified-by-descendant, not exact.
The original dispatch401/no-run remains in semantic_history and the preserved
first-attempt receipt. Native finish exited0. No credential rotation, settings
write, provider fallback or original paused-session recovery is implied.

## Human feedback

The user required staging-only work, explicit process credential precedence,
existing default behavior and real gh override, no provider calls, no settings
or credential changes, no auth login, no new fallback waiver, and preservation
of all production guards. The parent performed application after source
consumers finished and owned independent review, operational delivery and the
production retry. Records retain original failures and the final native result.

## Reusable lesson

Respect explicit process credential precedence at the CLI boundary and register every inherited credential for redaction before launching children.
