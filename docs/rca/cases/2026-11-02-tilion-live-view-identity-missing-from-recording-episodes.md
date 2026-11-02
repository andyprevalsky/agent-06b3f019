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
repro: scripts/tests/publish_evidence_links_browser_validation.test.sh
status: open
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
This is captured-state boundary proof, not a fresh media GET, published bundle,
FE outcome, benchmark pass or deployment. Those outcomes remain pending, and the
case remains open. No browser session was recreated, connected or released for
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
explicit aliases. No merge or deployment is authorized.

## Reusable lesson

Recover recording provenance from the provider's immutable native session contract and require complete matching saved episodes before classifying deployment diagnostics.
