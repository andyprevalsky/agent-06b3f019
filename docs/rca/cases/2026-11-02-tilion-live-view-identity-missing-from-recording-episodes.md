---
id: 2026-11-02-tilion-live-view-identity-missing-from-recording-episodes
date: 2026-11-02
title: Tilion recording validation omitted the native session identity retained in live-view URLs
surface: harness
component: recording-episode-validation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/publish_evidence_links.py _recording_episode_identity rejected Tilion live-view identity before matching saved episodes to deployment diagnostics
symptoms:
  - "has no correctly attached recording (need reachable recording_view_url or fetchable recording_file_pointer)"
  - "covered_diagnostic_count=0"
tags:
  - tilion
  - browser-recording
  - episode-identity
  - deployment-diagnostics
sources:
  - commit 6f3f53201faac3a3e70de099e7c211cee6770fad
  - commit a3c4929f3bbd296766013a7545439b682015a6ef
  - agent 100a9330-bc94-49e3-a28c-116f159c2eff
  - PR #1668
  - commit ee81230384c6e3507636a5be4793d753b9e59029
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh
status: fixed
---

## Problem

The original 81-message run contains two saved Tilion recordings and two later
source-less deployment-fenced recording diagnostics. Both genuine attachments
were fetched successfully by the original operator using the verified owner's
requester context (595364 and 3344538 bytes). The full validator nevertheless
rejected the task before probing either attachment. Wrong-requester failures
were a separate, corrected operator error; this repair does not change auth.

The supplied source comparison and local replay establish Gate: NOT_INTRODUCED
between the baseline and source above. Recording start/finalizer metadata,
persistence, diagnostic writers and the publisher were unchanged. Native closure
and saved media exist. This is not an attribution to changed close/pause ordering.

## Diagnosis

Critical path: provider live-view mint → recording start/saved message metadata →
message persistence → deployment seal copies the original start → publisher
matches exact recording episodes → media probes.

The start and saved messages preserve browser_url and browser_session_metadata.
The provider's live view retains /v1/session/sess_<32 lowercase hex>/live-view;
its query token is ephemeral. The two episodes have different native IDs but
reuse the same local recording_path. Neither metadata builder adds the explicit
session keys recognized by the publisher. The publisher parsed only Kernel live
URLs, so both Tilion starts had unknown identity and neither diagnostic could be
matched to its saved recording. All four FINISHED rows became candidate media,
and the source-less pair failed all(parts) before either real media probe.

The first bad boundary is identity interpretation, not missing capture or media.
The deeper owned gap is an incomplete provider identity contract shared by
recording validation. A path-only match, blanket diagnostic exclusion, synthetic
session metadata or filtered input would discard required provenance.

Archive searches were `has no correctly attached recording` and `recording episode
stale deployment diagnostics native session`. The August31 recording-validation,
September11 producer-cleanup and October3 code-task-classification cases are
relatives. Their first-bad boundaries differ: this capture has actual closed
sessions, media and sufficient immutable identity. No matching episode case was
found; this is a new cause, not a repeat of genuinely missing media.

The final permanent test fails against the original publisher with `Tilion native
session URLs must distinguish saved episodes sharing a local path`. The identical
command, `bash scripts/tests/publish_evidence_links_browser_validation.test.sh`,
passes with the repair. A private source fixture changes only publisher source,
retaining the identical final test. Logs and hashes are retained under the ignored
recording-publication-repair directory. The final publisher test passed five
consecutive runs in 1.06–1.16 seconds each. The full browser-tilion domain passed
58 registered cases in 189.8 seconds; its new pure parser check also passed five
consecutive runs. Agent structure, registration, syntax, diff and RCA archive
validation passed. The three existing approval guards found no gated hunks.

## Solution

A separate pure Tilion live-view parser in the provider URL module recovers only
the session handle from a trusted HTTPS deployment URL. It excludes query tokens
and rejects foreign/lookalike origins, userinfo, malformed ports, control/space
characters, fragments and malformed/encoded/extra path components. Regional and
configured deployment hosts use the existing host policy.

The publisher canonicalizes URL and explicit native IDs to one identity. Conflicting
aliases, provider declarations and URL-vs-explicit IDs fail closed. Unknown
providers cannot authorize diagnostic coverage through an arbitrary explicit ID.
Terminal rows validate every provider declaration even when they carry no handle.
Existing task, generation, start-call, local-path, saved-media, terminal and exact
deployment-fence requirements remain in force; every real part is still probed.

The permanent publisher controls include shared-path episodes, token rotation,
mixed explicit/URL identity, missing start/close/media, unreachable media,
unrecorded/foreign episodes, wrong generation/task/provider/session, conflicting
aliases, malformed handles and unrelated diagnostics. The parser is also registered
in the existing browser-tilion blackbox domain. Both suites are already reached
by normal deployment gates; no new benchmark or gate is added.

The private replay reads all 81 original messages without modification. Source
rejects before media; candidate covers exactly rows78/80 and consumes both actual
recorded successful pointer-probe results. Making either probe unavailable still
rejects the same unmodified input. Original input SHA256 remains
`e533d4bab2dc34f8ce5711d62d2cc18b78ec6b9a36581db48b21b235540d0ac8`.
That initial replay was captured-state boundary proof. The replacement owner
then ran the exact original publisher invocation unchanged on integrated HEAD
`ee81230384c6e3507636a5be4793d753b9e59029` with process-only
`BENCHMARK_HUB_USER_ID=00000000-0000-4000-8000-000000000107`. It exited 0,
recovered archived LLM content through the normal read path, uploaded the unchanged
run bundle, and reported `verified in fresh browser (81 msgs)` on November 2, 2026.
The raw input hash above is unchanged. Private output and manifest hashes are
retained in the replacement owner receipt. This proves the assigned publisher
outcome; it does not claim the underlying payment benchmark passed. Deployment
verification remains pending in the replacement owner deploy run; the assigned
publisher failure is now fixed with the real outcome proof above. No browser session was recreated, connected or released for
this investigation; local fake-provider blackboxes use their own fixture browsers.

At 10000 agents, parsing adds constant local work per examined row and no provider
calls, shared state, polling or new resource. The existing per-transcript matching
algorithm is unchanged. Removing the episode checks would weaken validation;
unifying native identity avoids that change. Golden reference: not applicable
(no approval-gated hunk; no runtime agent recovery or trajectory change).

## Human feedback

The user required a separate branch/devbox, private raw evidence, no sourcebox
operations, no paid/provider/financial calls, no filtered publication and no
weakening of missing-media rejection. The parent required a strict native URL
contract and independent review before draft PR. Review added negative controls
for unknown explicit providers, conflicting task-only terminals and malformed
explicit aliases. That earlier draft-only endpoint was superseded by the corrected end-to-end
acceptance contract: the replacement owner must make the exact publisher pass
and complete deployment through merge, production verification and cleanup.
The original account-context omission is corrected and is not a security bypass.
Preserve financial/provider facts and all missing-media negatives.

## Reusable lesson

Recover recording provenance from the provider's immutable native session contract and require complete matching saved episodes before classifying deployment diagnostics.


## 2026-11-11 recurrence — publisher requester configuration

This is a recurrence of the **separate wrong-requester operator error** already
noted in this case, not a recurrence of the repaired Tilion episode parser. The
original episode-validation diagnosis and permanent regression remain unchanged.
This appendix records a configuration repair using existing publisher inputs;
it does not claim a new code fix, automated owner inference or regression test.

### Problem and first bad boundary

The round-8 `agent-payment-new-user-journey` task passed, but its first standard
publication exited 1 with `has no correctly attached recording (need reachable
recording_view_url or fetchable recording_file_pointer)`. Root agent was
`7965e15f-af71-4426-9681-3a4e721435e0`; the rejected browser task was
`507ea03b-e556-5c99-a2ac-5a03170b7ae6`. The original run contains two FINISHED
recording parts with genuine file pointers. A missing-media message alone did
not establish missing capture.

The unchanged `scripts/publish_evidence_links.py` resolves `X-User-Id` from
`BENCHMARK_HUB_USER_ID`, otherwise using its canonical default. This publication
omitted the explicit requester. Its default was a different user from the
original run owner authenticated by the run's final cleanup evidence. The
recording-pointer probe collapses an attachment HTTP error to a false probe,
which surfaces as the recording-validation error above.

### Archive searches and causal proof

Before drafting this appendix, the archive was searched with both vocabularies:

- `has no correctly attached recording recording_file_pointer` — 42 matches of
  1,686 cases; relevant relatives included this November 2 case, October 3's
  code-task recording classification and August 31's recording validation.
- `publisher attachment wrong owner X-User-Id 403 recording` — 156 matches of
  1,686 cases. A subsequent literal-source search located July 8's benchmark
  agent owner/RLS mismatch. That viewer boundary is related but distinct.

The prior Solution and Human feedback were read. The November 2 case explicitly
separated requester mistakes from its code defect and used an explicit owner
for its successful publication; it did not add automatic owner selection. This
operation repeated that omitted input. Archive matches were leads, not proof.

Root authorized exactly one paired read of the **first original pointer**:
canonical default requester, then the authenticated original owner on the same
attachment URL, followed by at most one returned media GET. The retained result
contains exactly three GETs, with no redirects, retry or mutation:

- Default requester: attachment HTTP 403 (`HTTPError`).
- Explicit original owner: same attachment URL HTTP 200, signed URL present.
- Exact returned media: HTTP 200, 1,568,262 bytes, matching the original pointer
  size; SHA256 `a58c5fb6435ab6c9b4c0ed3680d1de35782b60d30eb4c6cb6b6fa4420e2c3619`.

The identical attachment-URL hash in both requests binds the requester change to
this boundary. The canonical owner-context probe accepted the media. This proves
wrong-requester configuration for that pointer, not a global media-availability
claim. The original failed publisher had no per-request HTTP trace; its error
and the later paired observations remain separate evidence.

### Supported repair and actual outcome

Root authorized one corrected standard publication of the same run and root,
using the existing process-scoped `BENCHMARK_HUB_USER_ID` set to the authenticated
original owner. No default-owner fallback or source modification was introduced.
The selected existing API key came from exact decoded `BACKEND_ENV_B64` in the
sealed approved capsule and matched the canonical publisher file's selected
key. It was not taken from ambient environment fallback.

The initial local continuation stopped before output creation, publisher launch
or network effects because its wrapper incorrectly required the caller HEAD to
remain the original task HEAD. The actual mismatch was **caller HEAD**, not the
publisher hash. Root corrected that precondition explicitly: original task
source remains `3b48f21a0379d93cba8937bc41f67aa2f97a1657`; publication caller was
`94f96dd0d3c22905edba49726308699ce9ccba95`, stable before and after. The publisher,
original run and capsule hashes matched throughout. This zero-effect refusal is
preserved and is not counted as another publication.

The corrected publication exited 0. Fresh FE validation reported **70 messages**
and accepted both original recording parts under the unchanged all-parts and
terminal-browser checks. The standard publisher also produced the durable last
LLM artifact and HTTPS evidence manifest. The original first publication remains
exit 1; the repair does not rewrite that receipt or retag original task source.
No task, browser recording, financial action or Native lifecycle was rerun for
this repair. No new source/test change or full benchmark rerun is claimed.

### Evidence bindings and limits

Private evidence is under
`.context/preparation-recovery/round8-smoke-monitor/`:

- Original `evidence-publications/7965e15f-af71-4426-9681-3a4e721435e0/`:
  failed log SHA256 `9bc772bcac7b762a08fbdc1247ae09b7ffd637ecf35fc1f0e50dd2165ea72c25`.
- `recording-paired-read-once/result.private.json`:
  SHA256 `1d0ac91311d49c12d285b5c47621c978f484ed0ca02869088672dcb0688d076e`.
- `corrected-owner-publication-once/` retains separate intent, status and log:
  corrected log SHA256 `a604e4f6e6f645376342147003d1bb7e9442cfad8ed482b79bb510b34bb24501`.
- Original run JSON SHA256
  `af25a6d197a40fa37229d4fefa9a3de80eeb64a869cf21b6cf20791817efab44`;
  unchanged publisher SHA256
  `02ec0c0fe42204f72fd284230dadf50bb97598cd14516eaafc46d5168584247b`.
- Approved private capsule SHA256
  `446f2fb1c0b3a3dbc68425341e80d09b460ac63432f3a5dd262c7971316c6e62`.
- `.context/rca_evidence/7965e15f-af71-4426-9681-3a4e721435e0/manifest.json`:
  SHA256 `053dc4aed40c90e0ae84b1b0b331649fdeca8a403b227e423ebe6eea31f55141`.

The current raw backend dotenv SHA256 was
`9944b6d5422409e536816556d7df026a3cc932c26d8bddee74d476ce23d29150`;
request runtime custody recorded
`d533fed41e44a4a96c66e4bdfcae0e83c9a801bad622249a13af04900dc09bf2`.
These raw-file and normalized/runtime digests are distinct. Approval was bound
to the sealed capsule and exact selected-key equality, not an assertion that
those whole-file hashes were equal. Credentials and signed URLs remain private.

The scope's terminal proof is `terminal-proof.private.json`, SHA256
`fddacd2a34d234ddb2739dab41709eca149106906979910d106581fc0f71f79a`.
It records 14 PASS plus one distinct policy SKIP, all 16 fleet closures and all
14 genuinely graded roots' durable publication, with 1,908 older bound files
unchanged. It does not turn the skipped task, old CBC failures or retained
quarantine/provider debts into passes. Current-assignment usage is UNMETERED
where no counter baseline exists.

### Coordinator constraints and recurrence lesson

The coordinator required finite original-pointer reads, authenticated original
owner binding, no silent fallback, no publisher loop, private raw evidence and
an explicit task-source/caller-source distinction. The records-only follow-up
permits this ignored appendix and schema validation, not another probe, task,
publication, test run or deployment. These bounded operation counts were
coordinator instructions, not a user requirement for a particular cohort size.
The user's unchanged protected-resource, Kernel and financial restrictions
remain in force.

For future standard publication, supply each root's authenticated original
owner through the existing per-publication `BENCHMARK_HUB_USER_ID` when available;
do not assume a default requester owns new-user roots. Preserve a missing-owner
or authorization failure rather than trying owners until one succeeds. There is
no new automatic guard in this repair: the earlier explicit-owner procedure was
not followed, and operator input remains required. Original recording validation
and all privacy/ownership checks stay unchanged. Golden reference: not applicable
(no approval-gated source or prompt hunk).
