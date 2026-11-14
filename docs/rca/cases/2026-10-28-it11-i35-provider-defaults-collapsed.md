---
id: 2026-10-28-it11-i35-provider-defaults-collapsed
date: 2026-10-28
title: It11 preflight collapses backend and worker browser defaults into one contract
surface: harness
component: cloudbench-provider-environment-contract
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/lib/cloudbench-env.sh cloudbench_validate_browser_provider_contract rejects different production role defaults before checking each role's mirror
symptoms:
  - 'FATAL: production browser provider drift: backend=tilion worker=kernel'
  - guest validators receive CLOUDBENCH_BROWSER_PROVIDER as both role defaults
tags:
  - cloudbench
  - preflight
  - provider
  - environment
sources:
  - commit 33b9c256bb00bf6e7cfde7b21798943e5f3b138f
repro: scripts/tests/cloudbench-provider-contract.test.py; five registered deterministic role/staging/guest controls, no live run
status: open
---

## Problem

It11 was not launched. The existing preflight receipt at1793215857.8557851
records production Render backend `tilion`, production Fly worker defaults
`kernel`, and local backend/worker `kernel`/`kernel`. The canonical validator
refused the different production defaults. This does not prove production is
misconfigured: the default of a backend selecting new browser sessions and the
default of a worker consuming their metadata are different roles.

Receipt SHA256 `e27ec2b67505ffe87750483f2b1feac7f45866f180c5a7fb16c9eac9ba99ae88`;
local contract SHA256 `7d26ee07d3e4323e7566478752a07b2c1e490ae36dff0a0f7385ae47a8ddf1fa`.
They are historical reads, not a new live probe. The rollout transcript says
Tilion was intentionally enabled on Render after a regional-CDP fix, but that
is context, not proof of current wire behavior. The current local backend
still independently mismatches the captured production backend and must not
be admitted. Local env hashes also differ from the staged manifest.

## Diagnosis

`selectedBrowserProvider` selects the backend default. Session creation can
also use a compatible recorded preference or an explicitly required Steel
profile, and persists/returns the actual session provider. The worker's
`init_browser_session` POST contains user/agent/start URL/task ID, not its
BROWSER_PROVIDER environment default. The handler takes
`session_data.browser_session_metadata.provider`; that value controls Tilion
CDP setup, download path/persister, keyboard serialization and usage. Existing
sessions likewise dispatch through their persisted provider. This is source
reachability evidence, not a new browser or model execution.

The first erroneous assumption is the cross-role equality at the canonical
validator. With synthetic local worker=kernel/backend=tilion, each matching
its respective captured production role, the unchanged function rejects
`backend=tilion worker=kernel` before checking either mirror. A second boundary
prevents fixing only that condition: `_inject_secrets_locked` serializes one
CLOUDBENCH_BROWSER_PROVIDER value, and all three guest paths pass that same
value as both role expectations. Thus heterogeneous defaults would still be
misrepresented at boot.

Archive searches `production backend worker browser provider drift` and
`browser provider per-session environment default` found the backend/worker
neutral-hydration and CDP-state-transfer cases. Their solutions and feedback
emphasize preserving the producer/consumer contract, not treating one process's
configuration as another's behavior. They do not prove this incident or justify
bypassing the guard.

## Solution

The source repair based on exact33b9c256 keeps the active/backend provider in
CLOUDBENCH_BROWSER_PROVIDER (including capacity selection), introduces a
separate CLOUDBENCH_WORKER_BROWSER_PROVIDER staging pin, and preserves both in
the manifest/three guest validations. Each local role must still equal its own
production role. Known provider names and the backend Tilion key remain
required. An absent worker pin supports only the legacy equal-role contract;
an explicit empty pin remains invalid. Missing pins cannot admit the captured
heterogeneous local pair. No env hash, namespace, task/copy/stop, provider cap,
or runtime browser behavior changes.

Five offline controls execute the actual validator, actual staging function
with inert service seams, and each actual guest validation call. The baseline
fails at the exact cross-role and guest-scalar boundaries; the candidate passes,
including wrong-role/key/unknown negatives and byte-identical env serialization.
This is transport/configuration proof only. It neither authorizes staging nor
proves a new live session. Fresh independent review I35-PROVIDER-ROLE-V1
found the exact seven-path patch
`9d2d67cd77f208ccbfd2ed0aec7eb1097f0b8a6c996a506396de08c37d71d6b5`
GROUNDED for this source admission contract. The seven applied files match its
reviewed output hashes. The case remains open for the separate operational
prerequisites and unchanged real-task outcome; source repair is not launch or
staging authorization.

Post-apply validation on the actual checkout: the full cloudbench-env suite
and five registered causal controls passed; archive validation and diff checks
passed. Earlier author collateral validation: staged-boot ran 29
controls with six existing platform skips, campaign-env passed ten, five shell
syntax checks passed, and provider-capacity passed sixteen in the complete
temporary fixture. The reviewer independently passed the five causal controls,
staged-boot and campaign-env; their broader capacity run had eleven passes and
five missing-source/fixture failures, not a clean independent capacity result.
An additional optional bootstrap run was interrupted after its temporary Git
fixture lacked package.json; it is not counted as a passing gate.

The separate real prerequisite remains: production-aligned backend env and
current staged env provenance must be produced through the normal authorized
staging path, keeping worker=kernel/backend=tilion if those remain the verified
role values. No such operation was performed here. The ordinary20-copy batch
and stop1 remain unchanged; any concurrency16 plan is a separate owner decision
and untested by this RCA. No provider/API/DB/model/browser/image call, deploy,
key mutation or paid launch was made. Tokens UNMETERED.

## Human feedback

Parent prohibited interpreting the different defaults as automatically wrong,
forcing both values to Tilion, deleting the guard alone, or executing staging.
The candidate preserves independent role truth and reports the legitimate
local-backend/staged-hash mismatch separately. No launch approval is inferred.

## Reusable lesson

A process's fallback default is not the active session's provider. Preserve
role-specific provenance through serialization instead of collapsing it into
an equality that the execution protocol does not require.
