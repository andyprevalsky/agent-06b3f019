---
id: 2026-10-29-relay-identity-read-depended-on-aggregate-app-status
date: 2026-10-29
title: Relay identity acquisition depended on aggregate application status
surface: infra
component: cloudbench-shared-relay
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _start_shared_relay required flyctl status JSON for app identity even though that command also reads active Machines and latest release; the original internal timeout phase remains unknown
symptoms:
  - "Command '['flyctl', 'status', '-a', 'navi-whisper-lux-bench', '--json']' timed out after 30 seconds"
  - "Campaign inventory did not initialize; see private publisher log"
  - "shared_inventory_failed"
tags:
  - cloudbench
  - relay
  - app-metadata
  - pre-admission
sources:
  - commit b5c9ea8372b703b3543f4b07a5f5336bc6934466
  - fleet run campaign-20261029-050100-287163
  - plan:.context/r62/proof.json
  - plan:.context/r62/review.md
  - plan:.context/r62/manifest.json
repro: python scripts/tests/cloudbench-shared-transport-integration.test.py CallerIntegration.test_actual_campaign_parent_starts_one_bootstrap_and_joins_before_archive
status: open
---

## Problem

R62 / It16 scheduled BU071–080 twice, concurrency16. The original campaign
started at 2026-10-29T05:01:00.033808+00:00 and finished at
05:01:44.781840+00:00 (44.698s campaign wall). All20 jobs were cancelled with
no start, zero peak concurrency and no scored outcome. This is a parent
pre-admission failure, not20 infrastructure-failed tasks or agent failures.

The original stdout first announces the parent-owned inventory feed, then
reports the exact30s `flyctl status -a navi-whisper-lux-bench --json` timeout.
Inventory history records three successful refreshes, durations2/3/2s. The
last Machines read completed in1.199s. The publisher log is empty; the generic
`shared_inventory_failed` label does not establish a publisher failure.

## Diagnosis

Exact executed source b5c9 binds the sequence: `start_shared_inventory` returns
after its owner file exists, then `_start_shared_relay` resolves the same bench
credential and runs aggregate app status. The parent consumes only exact app
Name, Organization.Slug and Network. The shared exception handler labels both
startup paths as inventory failure.

Personally opened Fly CLI v0.4.115 (`a1cf49a5` tree) status.go93–108 and
machines.go74–95/234–276 show GetAppCompact followed by ListActive and
LatestRelease before JSON. Fly Go v0.11.3 (`3a12e8af` tree)
flaps/flaps_apps.go30–65 exposes the equivalent identity fields directly via
escaped GET `/apps/{name}`. Fly CLI flapsutil/app.go12–26 maps native `default`
network to the empty WireGuard network. GetAppBasic omits network and would
not be an equivalent replacement. Full status remains appropriate for callers
that actually require deployment or Machine status.

The local owning reproduction injects the original TimeoutExpired at the
actual status-command seam; original code fails, while the replacement
obtains identity from a real loopback native App response, starts its existing
bootstrap/broker and joins them normally. This proves the unnecessary aggregate
dependency. It does not reproduce the remote30s stall or identify which
internal operation stalled. Original child stdout/stderr, binary hash/version
and selected credential-source label were not retained. The published CLI
version is contract research, not proof of the binary used in the incident.

Archive searches were `flyctl status TimeoutExpired` and `shared relay metadata
inventory initialization`. The prior per-route proxy and pre-allocation app-list
cases are relatives, not the same proved first-bad boundary. No blind retry,
metrics toggle or timeout expansion was adopted.

## Solution

The exact reviewed three-file change adds `--app-metadata` to the existing
bounded campaign native reader and invokes it with Python `-S` during relay
startup. It requests only the escaped App endpoint, requires exact name,
nonempty organization.slug and string network, and projects only the existing
parent identity fields. Default/custom network semantics are retained.

The same selected credential resolution/refresh, HTTPS and loopback endpoint
rules, redirect refusal, forced-instance refusal, complete bounded body/gzip
validation, absolute timer and private allowlisted diagnostics remain. Both
original30s bounds remain; no retry is added. The parent source check now binds
the invoked reader as well. Machine-list/individual-Machine modes are unchanged.

Fresh independent review approved exact patch
61665b5a4584b1b4241b83e036700d20042212ee2f5bd845dfd96930e95225e1,
R62-APP-METADATA-V1, with no substantive blockers. Reviewer opened Fly CLI,
Fly Go and CPython subprocess.py548–568 and contrary practice, verified hashes
and ran the actual baseline/candidate controls. Author exact-base owning suite:
17PASS25.010s; reviewer17PASS32.539s. Existing native gzip/body/duplicate-ID
control author1PASS0.668s, reviewer1PASS0.861s. Reviewer also rejected reader
source tampering and empty credentials before metadata GET. Pinned Python3.11.9
compiles the three changed files. Actual post-apply parent/metadata/refusal/cancellation controls:4PASS5.515s;
three files compile. Previous gates transfer only with exact output SHA identity.

The regression remains in the existing shared-relay suite registered by
scripts/test.sh. It exercises the parent, bounded child reader, native HTTP,
bootstrap and broker rather than a substitute identity-only helper. Invalid,
foreign, missing, malformed or failed metadata and cancellation cannot spawn
a relay. Native live admission and the full unchanged campaign have not been
rerun by this investigator; original outcomes remain unscored, and the original
remote timeout cause remains OPEN. No production/provider/DB/model operation
was performed.

## Human feedback

The coordinator required distinguishing successful inventory publication from
relay metadata acquisition, preserving original cancellation/scoring axes and
all deadlines, and refusing speculative retry/metrics changes. Public primary
source research and an isolated exact-reviewed branch repair were authorized;
root/owner source and live operations remained outside this worker's scope.

## Reusable lesson

Acquire only the native identity fields a transport bootstrap needs, while
preserving strict identity checks and recording unknown timeout phases honestly.
