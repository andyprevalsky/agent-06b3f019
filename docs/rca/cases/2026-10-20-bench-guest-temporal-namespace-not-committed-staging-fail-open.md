---
id: 2026-10-20-bench-guest-temporal-namespace-not-committed-staging-fail-open
date: 2026-10-20
title: A host without the private guest Temporal override restaged bench-app secrets onto the production namespace
surface: infra
component: cloudbench-guest-env-staging
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/run-bench-cloud _inject_secrets_locked — staged the controller's env unchanged when cloudbench_guest_temporal_override_file found no override, because the expected bench namespace existed only in a host-local private file
symptoms:
  - "guest .env TEMPORAL_NAMESPACE=rose-labs-us-east-1.tch2n differs from launcher guest namespace rose-labs-bench.tch2n"
  - "FATAL: guest agents.env TEMPORAL_NAMESPACE=rose-labs-us-east-1.tch2n differs from the launcher's guest namespace rose-labs-bench.tch2n; the bench app secrets predate the guest override"
  - "guest Temporal namespace: unchanged from agents/.env (no .env.benchmark-temporal override)"
  - in-controller infra canaries refuse and the live proof aborts before any task
  - bench app AGENTS_ENV_B64 restaged with 146 lines instead of 156
tags:
  - cloudbench
  - temporal
  - fly-secrets
  - guest-env
  - multi-host
sources:
  - commit aa2dd6c3b (guest Temporal override introduced)
  - commit 4801438f4 (launcher-bound guest namespace check)
  - agent boxes-thread ph79e8xgy4m94bfjbw6ta0w2gs8ghary (whm-analysis, devbox 18863612) ran --refresh-wmh 2026-10-19 21:59Z
  - agent boxes-thread ph7envbe63a63jj9t40nx5rvhh8gh1pd (Benchmark Infra V3) observed the canary refusal and restaged 23:38Z
repro: scripts/tests/cloudbench-env.test.sh (guest_temporal_case bench-missing / bench-off / bench-wrong-ns / bench-applied)
status: fixed
---

## Problem

On 2026-10-19 a live proof's shard-01 in-controller infra canaries both refused with
`guest .env TEMPORAL_NAMESPACE=rose-labs-us-east-1.tch2n differs from launcher guest namespace rose-labs-bench.tch2n`,
so the run aborted before any task. The shared bench-app secret `AGENTS_ENV_B64` on
`navi-whisper-lux-bench` had been restaged with a 146-line agents env carrying the
production Temporal namespace. A correct guest copy is 156 lines (sha `7d1b00c89af1`).
The close-out deploy agent restaged it correctly at 23:38:54Z with `--refresh-secrets`.

## Diagnosis

Source of the restage. The Fly secrets API keeps only the latest `updated_at`
(23:38:54Z), so the bad write came from Machines API config history. ULID-decoded
`/machines/<id>/versions` for every live machine showed only these warm-source
(`cloudbench-warm` 683e47df5094d8) activations between 18:16Z and 23:38Z:
21:59:39Z (1 CPU, `inject_secrets` skip-start activation), 21:59:43Z (4 CPU,
`prepare_warm_source`) and 22:46:57Z (1 CPU, `park_warm_source`). That is the exact
shape of `run-bench-cloud --refresh-wmh`, which calls `inject_secrets` before
upsizing the donor and parks it afterwards. The boxes.dev thread `whm-analysis`
on a different devbox (18863612, branch `e413f9dce`) ran "Donor --refresh-wmh" in that
window (turns 102–108: "The refresh is now stopping the donor and taking the
snapshot", 22:29Z). Inferred, not observed: that host had no
`agents/.env.benchmark-temporal` (its branch already had the override feature, so a
present override would have staged the bench namespace) and its agents env had 146
lines. That host's staging stdout was not readable; the attribution rests on the
machine version timeline plus the thread transcript, and version history records
activations, not who staged.

Ladder:

1. `_inject_secrets_locked` staged the controller env unchanged.
2. Why: `cloudbench_guest_temporal_override_file` returned nothing for a missing
   file, which was treated as "historical byte-identical staging".
3. Why was that possible: the bench app's required guest namespace was not
   recorded anywhere shared. It existed only as a private, host-local 0600 file on
   one host. Every other host or fresh checkout that ran any staging path
   (`--refresh-secrets`, `--setup`, `--refresh-wmh`, image activation) silently
   clobbered the shared app secrets.
4. The next rung (secret distribution across hosts) leaves the code we own. It
   depends on boxes.dev managed env or the user's credential custody.

The guest-side check (`cloudbench_require_guest_temporal_namespace`) only ran when
a launcher bound `CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE`, which only the
original600 operator did. It caught this incident, but ordinary launches would
have run guests on production Temporal silently. Side finding:
`cloudbench_env_value` ignored dotenv `export KEY=value` lines, which the override
writer and both dotenv loaders accept.

Local repro: `TMPDIR=/var/tmp bash scripts/tests/cloudbench-env.test.sh`. Before
the fix it failed with
`FAIL: bench-missing: bench app staging without its committed guest namespace must fail closed`:
staging the real app without an override succeeded and staged `prod-ns.acct`.

## Solution

- The committed per-app guest namespace is
  `cloudbench_expected_guest_temporal_namespace` (`navi-whisper-lux-bench` →
  `rose-labs-bench.tch2n`) in `scripts/lib/cloudbench-env.sh`. The namespace name is
  not secret; the address and API key stay in the private override.
- `cloudbench_require_staged_guest_temporal_namespace` runs in
  `_inject_secrets_locked` before `FLY secrets set --stage`. It refuses when the
  rendered guest copies do not carry the committed namespace. The error message
  names the expected namespace and says how to install the override (missing
  override, or `=off`), or which file to fix (wrong override). Nothing is staged or
  activated. This covers every staging caller, because all of them go through
  `_inject_secrets_locked`.
- `run-bench-cloud` binds the committed namespace as the default
  `CLOUDBENCH_EXPECTED_GUEST_TEMPORAL_NAMESPACE`. Every guest launch therefore
  refuses stale app secrets, even when they were staged by an older checkout that
  lacks the staging guard.
- `cloudbench_env_value` accepts `export KEY=value`.
- The regression is in `scripts/tests/cloudbench-env.test.sh`, run by
  `scripts/test.sh` and the `/deploy` cloudbench Linux gate. It passed 5
  consecutive runs.
- Golden reference: `claude-code-src/`, `codex/`, `openclaw/` and `hermes-agent/`
  were searched for Temporal namespace and staged-secret validation. None has an
  analog (they have no multi-host shared deploy secrets).
- Remaining exposure: a host still on a pre-fix checkout can still overwrite the
  shared secrets with a wrong namespace. Guests launched from fixed code now refuse
  it by default, but only at launch. The check covers the namespace only; a correct
  namespace with a stale guest API key would still stage. The original600
  operator's `guest_temporal_env` does not compare with the committed namespace;
  its launches inherit the default guest binding instead.
- 10k-agent behavior: there is one additional local file read per staging and a
  constant-time env check per guest boot. Nothing scales with agent count.

## Human feedback

None recorded.

## Reusable lesson

When a shared remote resource (app secrets, snapshots) must carry a host-independent invariant, commit the invariant and make every writer verify it before writing; a missing host-local file must never select a silent default.
