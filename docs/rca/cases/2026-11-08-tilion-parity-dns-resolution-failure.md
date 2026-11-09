---
id: 2026-11-08-tilion-parity-dns-resolution-failure
date: 2026-11-08
title: Hosted Tilion parity browser could not resolve example.com
surface: back-end
component: browser-provider-live-parity
classification: third-party-failure
problem_class: other
first_bad_boundary: a direct (exit worker) Tilion session landed on a west worker whose browser fails every DNS lookup for the whole session
symptoms:
  - "page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/"
  - "FAIL live Tilion provider parity"
  - "navigating to \"https://example.com/\", waiting until \"domcontentloaded\""
tags:
  - tilion
  - dns
  - external-provider
  - live-parity
sources:
  - PR #1831
  - PR #1844
  - commit 66adafe0bb9707fbc0568eb298773e1483402327
  - PR #1852 deploy gate (GitHub Actions run 42524375050; also runs 42480384775, 42480672127, 42500968866), deploy-gate-result browser-provider.log line 664
  - PR #1844 superseded; Blacksmith live repro GitHub Actions run 42529620811 (240 fresh direct sessions)
  - PR #1844 superseded; Blacksmith GitHub Actions run 42530551265 (unchanged vendor contract 12x on main vs fix)
  - plan:.context/production-mixed-mode-evidence/tilion-dns-waiver-prepared.json
repro: GitHub Actions run 42529620811; back-end/src/tests/blackbox/browser-provider.tilion-dns-worker.support.ts
status: fixed
---

## Problem

Live Tilion provider parity failed four times on 2026-11-08 in the
backend-coverage-blackbox gate on Blacksmith VMs (12:32, 12:36, 16:44 and
21:25 UTC; PRs #1783, #1837 and #1852 among them) with
`page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/`. Every failure
is at the same step: the first navigation of the direct session that
`assertLiveTilionVendorContract` creates (`POST /v1/session`, no proxy, so
`exit: worker`, `exit_tier: datacenter`) at the start of parity, before any
backend `/init`. The native session DELETE 204 precedes each FAIL line. The
other live Tilion cases passed in the same domain.

## Diagnosis

Gate: NOT_INTRODUCED. The fault is in the provider, not in a change.

- The four failed sessions all have the prefix `sess_26173b`. A Tilion session ID's
  first six hex characters identify the worker. Production rows show prefixes such as
  `sess_c3d0eb` and `sess_993d70` that stay stable for days.
- Tilion assigns a client's sessions round-robin across two workers:
  - From a devbox they land on `oregon.back.tilion.dev`, workers `a651ef` and
    `c41189`. 300 + 60 fresh direct sessions there had 0 DNS failures, and an
    earlier owner's 492 had none either.
  - From the Blacksmith network (egress 192.240.254.124, same key fingerprint
    87b9c532052b) they land on `west.back.tilion.dev`, workers `26173b` and
    `6f1b23`.
- Live repro, run 42529620811: 240 fresh direct sessions, each making a first
  navigation and then retrying on the same page after 1 s, 2 s and 4 s.
  - Every one of the 130 sessions on `26173b` failed all four attempts with
    `net::ERR_NAME_NOT_RESOLVED`, about 35 ms per attempt.
  - All 110 sessions on `6f1b23` resolved on the first navigation.
- So one Tilion worker's direct-egress resolver is dead for the whole session. The
  failure is persistent per worker. It is not a transient lookup miss or a
  warm-up race.
- Serial assignment is not strict alternation: of 34 serial sessions from the gate
  network, 16 landed on `26173b`, and 6 of 15 came right after another dead one.
- The intermittency was which worker the assignment handed the vendor-contract
  session. In run 42480384775 the standalone vendor contract passed (line 10) before
  the in-parity one failed (line 664).
- PR #1844's same-session retry was disproven, and the PR was superseded:
  - The probe shows it cannot recover.
  - Its own round-2 gate at 14:07Z (HEAD d11fb63f7) failed all 3 same-session attempts
    on `sess_26173be1248b41e99f9efd4af42202ab`, while `6f1b23` sessions passed.
- Production: 14 days of production Tilion rows show only workers `98241c`, `c3d0eb`,
  `993d70`, `b28038` and `463b41`. None is `26173b`, so no production session was
  observed on the dead worker.

## Solution

Live Tilion parity now acquires its direct session through
`acquireResolvingSession`:

- When the first navigation fails with `net::ERR_NAME_NOT_RESOLVED`, the session is
  released and replaced, and a warning names the session. The replacement lands on
  the next worker.
- `use` is the contract's existing single attached-CDP block. A session whose use
  fails with `net::ERR_NAME_NOT_RESOLVED` is released and replaced.
- At most eight sessions are tried, sized from the serial data: about 0.08% residual,
  and about 1 s per dead session. A DNS failure on the last session, or any other
  failure, still surfaces natively, after the session is released.
- A failed release is logged, not swallowed.
- The PASS line now names the session, so passing worker assignments can be audited.
- The URL, the 4409, screenshot and DELETE assertions, and all timeouts are
  unchanged.

Regressions, all in the browser-provider blackbox domain:
- `browser-provider.tilion-dns-worker.support.ts`: real Chromium launched with
  `--host-resolver-rules=MAP * ~NOTFOUND` models a DNS-dead worker and produces the
  native `page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/`.
- The vendor-contract replay in `browser-provider.tilion-contract.support.ts` gains a
  `dns-dead-worker` fault.

Both fail on main / single-session acquisition and pass on the fix. Command:
`cd back-end && bash scripts/run-blackbox-tests.sh browser-provider`.

Live proof (run 42530551265): the unchanged vendor contract ran 12 times from
Blacksmith.
- On main it passed 6 of 12. All 6 failures were `sess_26173b*` with this exact error.
- On the fix it passed 12 of 12, with 11 replacements.

Production code is not changed. No production session was observed on `26173b`. A
production direct session that lands on a DNS-dead worker would not be caught by
this change; that stays open as a product follow-up. The dead worker itself is a
Tilion defect that needs a vendor ticket: worker prefix `26173b` on
`west.back.tilion.dev`, direct exits.

## Human feedback

The user forbids treating the production mixed-mode payment ERROR as an
external-outage waiver; that original result and all three financial duties
remain separate and unverified. The repair assignment required a reproduction
and allowed a retry only if evidence showed a transient resolver failure; the
evidence showed a persistent per-worker failure, so the fix replaces the
session instead of retrying it.

## Reusable lesson

Map a hosted-browser network failure to the provider worker that served it (session-ID prefix, connect host, client egress) and reproduce from the failing network before choosing between retrying and replacing the session.
