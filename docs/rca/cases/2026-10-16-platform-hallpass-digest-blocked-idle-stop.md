---
id: 2026-10-16-platform-hallpass-digest-blocked-idle-stop
date: 2026-10-16
title: Exact older platform hallpass digest blocked idle STOP probe
surface: infra
component: cloudbench-billing-stop
classification: our-bug
problem_class: incomplete-authenticated-platform-version-set
status: fixed
---

The user-directed idle STOP batch refused its first targets before STOP. The
canonical runner count was zero, but the strict guest probe classified the
platform's `/.fly/hallpass` as unknown. The failed attempts and paused batch
remain preserved; no STOP success is inferred from this repair.

Root's separate read-only observation of Machine `82d16e1a091498` identified
only PID651/birth93 as unknown. The exact follow-up descriptor confirmed UID0,
PPID1, PGID0, exact singleton argv, exact executable path, regular root-owned
15,589,111-byte binary and stable birth. Its SHA256 was
`1fc252c042a279787eb1a83a15c7e19d634fc0059ad8abf4acaa9a752f5684a2`, absent from the
two explicitly accepted platform hashes. The complete safe descriptor is retained
as `scripts/tests/hallpass-platform-descriptor.fixture.json`.

The fix adds only that exact digest to the existing predicate. Every identity,
file, process and unknown-process rejection remains unchanged. It does not
permit arbitrary hallpass names or other processes. The captured descriptor
fails the original predicate and passes the changed one; all nine altered-field
negatives reject. The new case and the existing platform identity case passed
five consecutive unchanged runs. Tests remain in the existing registered
bootstrap-recovery family. No provider operations were performed by the author;
new native confirmation belongs to the root operator.
