---
id: 2026-10-06-campaign-cancellation-left-terminal-hub-status-stale
date: 2026-10-06
title: Campaign cancellation left its Hub group with the earlier status
surface: infra
component: benchmark-campaign-hub-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-campaign.py final publication cancellation updated only the local summary
symptoms:
  - cancelled campaign retained passed Hub group status
  - startup Hub projection remained starting after cancellation
  - cancelled campaign Hub projection is pending
tags:
  - benchmark-campaign
  - hub-publication
  - cancellation
  - terminal-handoff
sources:
  - PR #1424 review comment 4203414279
  - commit f04b845f9642bf0cc724b5d65a01b4cb3255f353
repro: agents/benchmarks/cloudbench_campaign_inventory_test.py test_campaign_inventory_cancellation_reconciles_with_its_existing_hub_publisher
status: open
---

## Problem

The final publication serialized the earlier group status before observing a
late campaign cancellation. The local summary subsequently became cancelled,
while the submitted Hub record remained starting or passed. The existing native
cancellation controls joined the exact publisher but did not check the remote
projection. An actual localhost HTTP control ran the production campaign and
Hub CLI, held the acknowledged request, signalled the parent, and compared the
remote group, original record and final summary. The final identical eight
controls on immutable f04 produced seven failures and one pass in 7.630 seconds;
the reviewed candidate produced eight passes in 8.095 seconds. Original logs,
records and private tokens remain outside the archive.

## Diagnosis

The first bad boundary was the cancellation handoff between the already-owned
publisher and the final summary. Killing that publisher and changing only the
summary could not undo its already accepted HTTP request. Starting a replacement
uploader after stop would create a second lifetime owner and permit the earlier
request to overwrite its terminal projection. The owning control demonstrates
that exact ordering using real HTTP requests rather than a desired fake status.

A second boundary was cancellation after the terminal publisher had already
acknowledged and closed. The old parent changed its completed summary even then.
The inverse controls now distinguish actual publication from wrong token, record
digest or publisher PID. An invalid receipt keeps cancellation and explicit
pending remote status; it never claims remote reconciliation or completion.

Two archive searches used `cancelled campaign terminal group status passed` and
`Hub publisher drained remote projection cancellation`. The prior
[blocked-publication case](2026-10-06-campaign-hub-publisher-blocked-owner-cancellation.md)
is a relative: its first bad boundary was synchronous waiting that prevented
native cancellation. Its fix joined the auxiliary session; this incident is
about the accepted record at that joined handoff. Both prior Solution and Human
feedback were read. Claude Code graceful shutdown, Hermes CLI unwind and OpenClaw
owned-child termination supplied related cleanup patterns. The local Codex
reference path was absent, so no Codex comparison is claimed.

## Solution

Keep the original group record and its timestamp. On in-flight cancellation,
atomically write its cancelled projection before draining the existing publisher.
The opt-in campaign publisher finishes its original request, rereads the same
identity-bound record, and reconciles it through its existing required transport.
It uses no replacement process, new transport timeout or new stage budget.
Ordinary Hub CLI callers retain their signal and upload behavior.

A completed final publication returns an acknowledgement bound to the exact
publisher PID, a fresh private handoff token and the canonical record digest.
The campaign accepts that commit point only after native session closure. A
signal after this point retains completed status; earlier cancellation retains
its exit code and all original child grades. Cleanup remains in a nested finally
so exceptional record handling still drains its exact owned process session.
Unacknowledged or corrupt publication remains honestly pending.

Independent review then reproduced malformed acknowledgement JSON escaping
before the cancellation record was written: one failure in 1.281 seconds on the
first candidate. The narrow observation correction made that unchanged inverse
pass in 1.359 seconds. Invalid or unreadable acknowledgement/native observation
is now unverified completion, so cancellation rewriting and exact native drain
still run. The original first packet and counterexample remain retained. The
final identical nine controls against the original f04 runtime bytes produced
eight failures and one pass in 8.732 seconds, then nine passes on the corrected
candidate in 9.122 seconds. Both final runs captured 18 absent native PIDs and
empty leader groups; their fixture source hash is identical. One earlier local
fixture-string syntax setup error is retained with no causal credit.

The existing permanent campaign-inventory family owns starting and final
in-flight reconciliation, the completed commit point, and three wrong-binding
inverses plus malformed JSON. The original exact-session/foreign-neighbor assertions remain. All
16 captured native PIDs were absent in each paired run; each pytest group was
empty. The ordinary Hub uploader file also passed all 27 tests in 5.04 seconds.
The existing family needs final composed normal qualification and production
verification; this open case grants no LIVE task or rollout credit.

The work remains constant per campaign publication: one record, one existing
owned uploader and, only on cancellation, one corrected projection. It does not
scan task payloads or launch a process per member. Deleting required schedule
publication would hide the state consumers need; unifying its handoff with the
existing owner avoids a manual repair or a parallel uploader.

## Human feedback

### October 8 opt-in retry and whole-experiment cutoff

The user authorized one fresh retry for infrastructure failures only and a
90-minute image-start through durable publication/full-release limit. During
implementation, the existing expired-clock scheduler control failed because a
previous cutoff suppressed the ordinary final group publication entirely.
The unchanged control then passed after distinguishing a prior stop from a new
stop during the final publication. Both retry-enabled and E2E-only invocations
now exercise this handoff; ordinary flag-off cancellation remains unchanged.

The physical attempt must first have an exact run/owner/workspace release audit,
matching copied metadata and positive release epoch, absent owner registry,
released terminal row and healthy publication. A retry preserves the original
logical member and timestamp, retains the failed physical attempt, and uses a
fresh controller without restarting healthy peers or either clock. Independent
review supplied an actual failing contradictory PASS/INFRA inverse; a genuine
PASS or task FAIL now prevents retry even when another marker says error.

The compact owning scheduler, normal CLI and real HTTP uploader controls run
through the existing deploy gate. Focused cutoff verification passed ten checks
in 5.28 seconds; final combined campaign/barrier/uploader qualification passed
81 checks with one existing skip in 60.12 seconds. Earlier source-qualified
normal-gate evidence is 511 passes/four skips in 449.01 seconds and is not
claimed as an exact final-source rerun. No LIVE retry, fleet acceptance or
production rollout is established by these local controls. The whole original
90-minute clock remains authoritative even when cleanup finishes later.

The user required accurate live frontend results and supported CLI shepherding
through complete owner release. The parent review required actual foreground
remote reconciliation rather than a pending receipt alone. It also required an
acknowledged terminal commit point, exact owner/digest evidence and native closure
before retaining a completed status after a later signal. No new microtimer,
post-stop publisher or restart was authorized as a substitute.

## Reusable lesson

Native publisher retirement and a local terminal summary do not prove that its
accepted remote record has the same terminal state. Bind the publication commit
and cancellation reconciliation to that original owner and record.
