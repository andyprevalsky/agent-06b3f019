---
id: 2026-11-08-review-quota-reply-required-legacy-sha-prose
date: 2026-11-08
title: Modern CodeRabbit quota command replies lacked the legacy SHA-bearing prose required by the review ledger
surface: harness
component: deploy-review-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_review_cycle.py _exhaustion_comment required legacy quota wording and an inline SHA, rejecting a native command reply whose current HEAD was bound by authenticated PR and bot configuration evidence
symptoms:
  - "no CodeRabbit comment names b3a75f518386 with 'Review limit reached'/'usage spending cap'"
  - "Your included review limit is currently reached under our"
  - "CodeRabbit review command invocation: v2:"
tags:
  - coderabbit
  - review
  - provider-quota
  - provenance
sources:
  - PR #1828
  - commit b3a75f5183867198f931b24bb2ddbef68c59d55e
  - agent CodeRabbit issue comment 6720514622
  - agent CodeRabbit configuration comment 6720503588
repro: python3 scripts/tests/deploy-review-cycle.test.py ModernQuotaTest
status: open
---

## Problem

PR1828 received a path-filter skip for exact HEAD b3a75f5183867198f931b24bb2ddbef68c59d55e.
The parent correctly requested a full review in issue comment6720513816 at
2026-11-08T10:45:32Z. Bot reply6720514622 was created10:45:38Z, updated10:45:46Z,
and explicitly reports the included review limit under its Fair Usage Limits
Policy, with the next included review in59minutes. It contains a native v2
command-invocation token but no SHA. Configuration comment6720503588 was
updated10:45:44Z and contains both configuration and commit links for exact HEAD.
The normal tool rejected this evidence. A path-filter skip alone would correctly
remain insufficient; neither a new review nor usage-based billing was requested
by this investigation.

## Diagnosis

The original quota classifier accepts only legacy review-limit/spending-cap
wording in a bot comment that itself names HEAD. Both assumptions fail for this
actual native reply. Expanding a phrase list alone would still lose the SHA
binding, while accepting a generic action-not-completed or rate-limit message
would waive a real review gate without quota proof.

Authenticated GitHub reads captured PR identity/head, issue comments, all check
attempts, reviews and inline comments. CodeRabbit check128706968531 is completed,
conclusion skipped, title Path filters excluded7files, exact head; there are no
substantive or inline reviews in that capture. The command reply's opaque token
cannot be reverse-mapped to a request; the supported binding instead requires a
unique unedited member command in the open cycle, official bot/app identity,
matching configuration updated during that reply and a live authenticated PR
head match. Missing or ambiguous evidence refuses.

This is related to the publication-provenance case of2026-11-03, but not a
recurrence of its substantive-review classifier or the quota budget-counting
cases. Searches: CodeRabbit usage spending cap review limit; review quota exact
head command invocation. The C15 test-fixture repair did not change this script;
this is an additional compatibility blocker, not a waiver or reassignment of C15.
No agent self-report applies to this command-gate failure.

## Solution

Retain the legacy SHA-bearing path and add a narrowly recognized native quota
reply path. Require the official policy phrase/link, one v2 invocation marker,
unique positive comment IDs, matching PR issue URLs, current-cycle timestamps,
an unedited trusted review/full-review request, bot configuration links naming exact
HEAD, a completed non-success exact-HEAD CodeRabbit check/app, and a live PR API
read confirming the open PR's number, base repository and head. Reject after the
provider's stated reset time. Preserve the substantive-review refusal before
quota handling, duplicate-head rules, review budgets and skipped disposition.
Prior-cycle replies are historical only; a unique current-cycle reply can bind
the CLI incremental command @coderabbitai review as well as full review.
Ambiguous current requests still refuse. A second-cycle regression failed the
first candidate, then passed unchanged after current-cycle filtering and command
recognition. Receipts record binding IDs, timestamps, token and raw-body hashes; they never
claim that the SHA-less reply names a commit or that a skipped review is PASS.
Bounded endpoint pagination now fails closed instead of returning an incomplete
inventory that could hide a substantive review or another request.

The existing owning suite contains native API projections and adversarial
mutations for wrong head/PR, missing or spoofed bot/app/configuration/request,
stale/edited/duplicate/ambiguous evidence, missing exact check, successful check,
expired quota and substantive review. Original tool failed the new positive
regression; fixed tool passes unchanged. Final-source frozen replay of the same
six regression methods failed old code with two positive errors and one pagination
failure, then passed6/6 after changing only tool bytes. The full existing suite
passes56/56 and passed five consecutive runs with unchanged tests. It is already
registered as deploy-review-cycle in scripts/run-deploy-structural-gates.py.
A live CLI replay on a private copy of the open ledger exited0 with Skipped,
binding request6720513816/configuration6720503588/quota6720514622 to the actual PR
head. The parent's ledger, review cycles and receipts were never mutated.

Local compatibility repair is verified. Status remains open pending parent
review/integration and parent-owned deployment acceptance; no deployment or
commit/push was authorized for this worker. C15 full original sharded coverage
and native deploy outcomes remain separate mandatory gates. Golden reference:
not applicable, ordinary command evidence handling with no approval-gated hunk.
No production agent runtime cost is added at10000agents; one read-only PR API
request is added only when resolving this modern quota disposition.


## R1 adversarial correction — 2026-11-08

Independent review found that the first compatibility patch rejected only
full40hex reply references and checked configuration links by presence, allowing
an explicit wrong abbreviated commit or mixed source targets. The original
native b3a disposition was independently accepted as SKIPPED and is unchanged;
these are synthetic counterexamples to the general guard, not claims about
corruption of the captured payload.

Added two methods to ModernQuotaTest. On the pre-R1 implementation, the targeted
pair exited1 with10negative subtest failures and1positive opaque-identifier
error. After the correction the same pair passed2/2 unchanged. Contextual
commit/HEAD references accept matching7..40hex prefixes and reject conflicting
ones; explicit commit/configuration links must agree with HEAD/repository.
The native Run configuration requires unambiguous commit/configuration target
sets, not one correct URL embedded beside a contradictory one. Opaque invocation
hashes and unrelated identifiers are not scanned as commit identities.
An additional mixed commit/main link control failed before link-target parsing
was broadened to observe nonhex references, then passed the same one-method
command afterward. Failed controls assert byte-identical ledger and existing
receipt contents, not merely absence of a new file.

Full suite initially exposed an inconsistent synthetic cycle2 fixture label:
its link target had changed to the new head while its abbreviated label still
named the old head. Only that synthetic label was corrected; original native
bodies and cycle history remain unchanged. Final full owning suite passes58/58
and five consecutive runs of these final bytes pass58/58 each. Archive validation
and diff checks pass. No real GH calls or actual cycle1 replay occurred during
R1; parent supplied the independent accepted disposition. The parent reports
the original native backend command exited0; final frozen deployment acceptance
is still a separate mandatory parent gate.


## Human feedback

The parent remains the sole deploy coordinator. Preserve exact-head and
no-substantive-review guards, do not fabricate evidence, do not convert a
path-filter skip into quota proof, and never call a skipped provider review PASS.
No changes to CodeRabbit configuration, prompts, CLAUDE/AGENTS, Freedom or
historical payment restrictions were permitted.

## Reusable lesson

Bind a provider's SHA-less command reply to authenticated current identities and its complete request/configuration evidence instead of inferring quota or review delivery from presentation text alone.
