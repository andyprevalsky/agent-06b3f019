---
id: 2026-10-29-it14-cleanup-ticket-prepare-lost-diagnostic
date: 2026-10-29
title: Cleanup-ticket preparation discarded its failure identity before final cohort admission
surface: infra
component: campaign-cleanup-ticket-admission
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: The campaign prepare catch discarded the exception while persisting only cleanup_ticket_failure=prepare
symptoms:
  - Final eight jobs cancelled before admission
  - No prepare exception detail retained
  - Only prepare.lock exists in the failed cohort budget directory
tags:
  - r59
  - it14
  - cleanup-tickets
  - diagnostics
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - plan: original packet 3fa5c2ac29c75faf515be7da0e3e107ebb47f65ecc6a6edbeaad25c3f757d81c
repro: agents/venv/bin/python .context/r59/run_selected.py .context/r59/candidate
status: open
---

## Problem

Original assignment04:21UTC is retained. The c003 cohort aborted at
04:19:02.453191Z with cleanup ticket preparation failed before child admission.
The parent-reported final original40 outcome is18PASS/14taskFAIL/8never-admitted
CANCELLED, confirmedinfra0 and e2e_timeoutfalse. These original outcomes are not
changed by this repair; no new task or cleanup attempt was run.

## Diagnosis

The independently opened original c003 manifest contains exactly r002-j0033
through r002-j0040 and SHA256
30cf27377a91cb0bfb41a903a09d3714c192b7557cb54c24fb4adb9ad17c4aac.
Abort SHA256 is
d672421bc85d6478e8468e8c180484bc8726f594e5589d94c7ddb704542dfb45.
The original prepare.lock is empty. No budget.json or ready.json was supplied
or found by the owner. Original stdout/stderr scans are owner-attested, with
hashes recorded in the packet, not independently reopened full log bodies.
Their scans found no exception detail.

The supplied source bytes match executed85: campaign SHA256
44b816fab4e63265c325cc2e096330d49c4eddc1f255cd279eb0800adf80da02;
cleanup-ticket helper SHA256
29c2f6e4c71bf45a182f2beb59298e63f7a82e1e0bddd3956ac7d603a823c81b.
The campaign loads the immutable helper in-process. Its existing catch for
OSError, ValueError and SubprocessError stores only the generic prepare marker
and aborts. Thus no stderr from a separate helper exists. The exact historical
failed predicate is UNKNOWN: it could not be reconstructed from the lock file.
This is not proof of a provider, capacity, policy, parent-identity or grant error.

A separate owner read-only prospective snapshot1793248000.9355295 has
9593131008 freebytes,0 ticket liability and8321499136 legacy liability. Default
nine-slot headroom2415919104 leaves -1144287232bytes before minimum admission.
Original effective policies and original free-space snapshot are unavailable.
This current readiness deficit is not retrospective proof of the first failure.
A subsequent owner reconciliation reports31 dead standalone legacy rows and
no inflight allocations. Its safe retirement is a separate pending repair;
this diagnostic patch neither removes state nor waives those commitments.

## Solution

The scoped diagnostic repair adds an optional summary object at the same catch.
It contains a closed exception category, eight exact known predicate codes,
and bounded numeric errno. Unknown text is represented only by a SHA256 of
its first4096 characters; raw paths, arguments, environment, exception objects
and traceback are never serialized. That hash is for correlation, not a secrecy
claim against guessed messages. The original caught classes, abort, failed
summary, no-child admission, cleanup ownership, floors and retries are unchanged.

Actual campaign fixture baseline:3tests with5missing-diagnostic errors in2.709s;
unchanged successful retirement control passes. Exact candidate:3PASS2.681s.
Cases include physical-floor predicate, unknown secret/unicode text, OSError28,
unknown subclass/long prefix, and later failure after the first cohort passes
and retires. Fresh independent review marked patch
 a5ae914e4674160c6525878afff92faae83ba931113d194b4e6d4f4c0731313e
GROUNDED after independent baseline3/5errors and candidate3PASS, three existing
collaterals, and six additional negative projections. Postapply actual checkout
runs the same registered controls:3PASS2.723s. Python3.11 compilation passes.

Personally opened references: OpenClaw diagnostic-stability.ts182–213/228+
uses safe reason-code and field projection; Codex keyring-store/lib.rs28–51
suppresses payload-bearing error chains; Hermes terminal_tool.py978–992
returns a redacted typed error envelope. The latter two retain some redacted
or native text; this repair intentionally uses a stricter closed projection.
None is claimed to supply Rose's prefix size or resource-ownership policy.

## Human feedback

The parent authorized diagnostic preservation, not a capacity override or
historical-cause invention. Fresh independent review approved the exact two
runtime/test files. Missing historical FE/LLM artifacts are not applicable to
this pre-child controller failure. Prospective legacy-accounting work remains
unapplied and requires its own causal proof and exact independent review.
No provider/API/model/browser/DB calls, operational ledger edits, retries or
new benchmark were performed. TokensUNMETERED.

## Reusable lesson

Persist a safe typed failure at the owning catch before ending admission.
A generic failure marker and later capacity shortage cannot establish the
original predicate. Diagnostic identity must not grant cleanup or launch authority.

## Same R59: current stale standalone accounting repaired

The original04:21UTC clock and unknown historical prepare predicate remain.
A subsequent exact owner read-only state snapshot has SHA256
36cc00c2812fa6085003fac01f45be3fdc5ec53cdbe46db6de3812733fc22ed1:
31 standalone fully consumed groups, no inflight records, each retaining
256MiB headroom. The owner's reconciliation reports all31 recorded PIDs absent,
terminal provider teardown audits and absent reserve/registry paths. These are
owner observations, not independent provider/resource probes by this author.
The 8321499136-byte logical liability is not allocated reserve-file bytes.

The existing run-bench-fleet cold allocator already prunes nonparent,
nondebited dead consumers while holding the same per-device admission lock.
Ticket preparation previously counted old legacy rows indefinitely. The new
helper runs only inside that existing exclusive lock and only before fresh
cohort budget admission. It accepts strictly shaped, fully consumed standalone
rows with valid policy/owner fields. Any inflight record disables the entire
pruning pass. Only a positive ProcessLookupError from the exact PID's POSIX
signal-zero query permits removal. Live/reused PIDs, permission errors, zombies,
unknown or malformed rows, partial membership and all parent-backed groups
remain. No reserve file is opened, allocated or unlinked by this retirement.
The existing atomic state replacement preserves every other field and the
historical failures. Physical df capacity and existing minimum/headroom guards
remain authoritative after pruning; no manual state edit or floor override.

Permanent registered fixture keeps the exact31-row original bytes and captured
9593131008 freebytes. It substitutes the owner-observed absent PIDs only in the
private child fixture. Baseline actual prepare fails insufficient physical
cleanup cohort floors; exact candidate prepares eight jobs at512MiB. Four owning
controls pass, including seven retention subcases, held-global-lock ordering,
existing cross-cohort budgeting and dead-owner/live-allocator custody.
Author baseline1FAIL/3PASS0.987s, candidate4PASS1.081s. Fresh reviewer independently
observes baseline1FAIL/3PASS and candidate4PASS1.103s, plus seven malformed/unknown
controls and versioned-state persistence. Postapply actual checkout4PASS1.083s;
Python3.11 compile, archive and diff checks pass.

Exact patch897846f469d26617e0b80a0153ef340d16e4c87f7338dac0222ea4443cc5152d
received fresh scoped GROUNDED review. Opened OpenClaw stale-lock-file.ts48–84
and pid-alive.ts149–159, Codex app-server-daemon/install_lock.rs62–86, and Hermes
_subprocess_compat.py652–672 support positive absence and retaining uncertainty.
Contrary age, PID-reuse or broad-OS-error reclamation was deliberately not copied.
The candidate is narrower than existing canonical pruning and does not claim
resource cleanup, actual next-run admission, full release or a task PASS.
Both repairs remain isolated from the frozen live operator until the parent
qualifies composition and authorizes canonical readiness/preparation.
