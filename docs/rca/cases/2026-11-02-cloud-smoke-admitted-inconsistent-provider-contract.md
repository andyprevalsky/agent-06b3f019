---
id: 2026-11-02-cloud-smoke-admitted-inconsistent-provider-contract
date: 2026-11-02
title: Mandatory cloud smoke admitted an inconsistent injected provider contract
surface: infra
component: cloudbench-provider-contract
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The preflight equated independent backend session-default and worker fallback authorities, then passed one backend marker to both guest checks
symptoms:
  - "FATAL: benchmark worker env does not match production: local=kernel prod=tilion"
  - "FATAL: production browser provider drift: backend=tilion worker=kernel"
  - "infra canary preflight FAILED (exit=1)"
tags:
  - cloudbench
  - smoke
  - environment
  - provider-parity
sources:
  - PR #1662
  - commit bf92cbd98ab436af20f9a8d647c32e748c67e93a
  - commit c13dc65fa03083ac6c4490f0c572ae21c439f8da
  - fleet run 20261102-223815-205225
  - task c4e854294a2a469a8b86566800350e2c
repro: /var/tmp/pr1662-c13-provider-env-rca/validator-proof.json and base-head-authority-control.json
status: open
---

## Problem

The c13 focused smoke request e9b5ca1b6f094b909065f3f3645f5038 selected all17 original checks. Native campaign cd414120063b1646c24f9674044b4d06557f8417a52dc513afeb6329de0eeb4b completed PG15 seed preflight and one dependency refresh;15 sibling controllers explicitly reused its verified snapshot. The new failure was j0005's native N2 infrastructure canary, run20261102-223815-205225. Both canary guests verified checkout c13 and injected env digests (agents892f4393e0e2, backendf93cd450921b), then failed worker kernel versus expected marker tilion before stack or task execution. Both exited1 with cleanup_ack1. Campaign stopped on one confirmed infra job of original17 at22:47:18.091466Z;15 started siblings received TERM143 and the seventeenth never started. Every original smoke outcome remains UNVERIFIED.

## Diagnosis

The original native canary checks checkout c13 and injected digests, then passes CLOUDBENCH_BROWSER_PROVIDER twice into cloudbench_validate_browser_provider_contract. Its prod=tilion text names one injected backend expectation marker, not an independent worker authority. The controller validator also required prod_backend == prod_worker. Both checks conflate separate production roles.

Runtime source proves why the distinct values are valid: agents/domains/spawn_browser_agent_v3/repo.py init_browser_session sends user/agent/start/task fields to backend without a provider override; the backend chooses its configured default, returns provider metadata, and worker browser logic consumes that per-session provider rather than choosing the provider from the worker fallback. The inspected normal route needs the Tilion vendor key in backend, not workers. Production Render tilion and Fly kernel fallback therefore do not establish an inconsistent session-selection contract. The previous production-drift diagnosis and all-tilion operational proposal are withdrawn; original measured values and reports remain preserved as evidence of distinct roles.

Native read at22:51:52Z returned Render tilion and production Fly config kernel, both exit0 without fallback. One parent-authorized exact started production worker811d190a176358 printed effective kernel at22:57:00Z. These observations are retained with their timing/single-worker limits; they are not a reason to mutate production. A later names-only app listing found BROWSER_PROVIDER present and TILION_API_KEY absent; this is only the inspected secret-name listing, not an audit of every effective worker environment, and does not establish a missing runtime key on the backend-owned vendor-key path.

The five native route/helper sources are byte-identical bf92->c13. The invalid equality check was already present. Gate: NOT_INTRODUCED for the native equality and double-backend-marker defect, established by identical before-source code and the same valid distinct-surface reproduction failing on bf92 and c13. Gate: INTRODUCED remains scoped to the newly mandatory cloud integration exposing this unprepared contract boundary: bf92 documented a local smoke default while PR1662's template forces cloud and its binding. No claim is made that PR1662 changed production values or created the historical equality assertion. Independent attribution review retains that distinction.

Identical new owning regressions execute the actual helper and native --refresh-secrets CLI against private, captured-shape authority fixtures with no live network. On c13, the correct Tilion/backend and Kernel/worker pair is rejected before staging. The private candidate accepts that same pair, stages distinct markers, preserves full blob digests and guest Temporal isolation, updates only stopped warm/declared stopped pool targets, and skips active pool targets. Wrong backend, wrong worker, missing/invalid authority, absent marker and absent backend Tilion key remain refused. Production authorization failure now fails closed instead of allowing a local backend file to become its own authority. The backend/session marker remains Tilion and capacity code is unchanged. No original task definition, evaluator, per-task assertion, timeout, concurrency or threshold changes.

Cleanup remains the original measured outcome: one infra-canary failure,15 started sibling cancellations and one unstarted row; all17 smoke UNVERIFIED. All16 controller PIDs are absent in recorded local inspection. Native N2 sealed teardown records both created machine pairs and the failed-attempt volume as destroyed-provider-retained, not exact absence; both guests acknowledged cleanup, and the viewer remains retained-exact-owner-transfer-required. Original cleanup_completefalse and lingering_grouptrue are not rewritten.

Archive searches used the literal worker-env error and cloud provider environment secret parity preflight. PATH preparation and shared-preflight ordering cases are relatives, not causal substitutes. Golden reference: not applicable (no approval-gated runtime/prompt/schema hunk proposed).

## Solution

OPEN pending deployed execution: private candidate supplies independently verified backend-default and worker-fallback markers through explicit staging, required secret names, manifest fields and all three guest contract calls. Each local env is compared to its own production role, while valid provider enumeration, wrong-value refusal, backend Tilion-key enforcement and source-authority independence remain strict. It removes the false cross-role equality without weakening per-surface parity. The old marker remains the backend/session selection and capacity marker; no production configuration flip is needed.

The parent integrates the reviewed private patch and runs unchanged explicit --refresh-secrets under the existing controller/app-env locks at a safe terminal/stopped-warm boundary. Native transaction still stages full blobs/digests/GitHub token/guest namespace, activates stopped owned targets with --skip-start, and allocates nothing. The added marker must be present before any subsequent run. Native N2 and all17 original smoke tasks remain execution-required on the final frozen source; private diagnostics are not task passes or waivers. No live staging, source edits in the parent, provider sessions, production writes or retries were executed by this investigator.

## Human feedback

The user retains source/deployment ownership in the parent, requires Freedom preservation, and prohibits independent full gates or assertion/budget waivers. The parent prohibited shared/global env changes, production writes, provider retries and allocations in this investigation, and requested exact native cleanup plus a private repair/preparation packet. After source review, the parent withdrew the unnecessary production-flip question and explicitly requested separate per-surface parity markers with no original task/assertion/budget changes.

## Reusable lesson

Compare each environment value to the production surface that owns its meaning, and carry independent authorities independently through staging and guest validation.


## 2026-11-11 runtime-authority follow-up — private, not integrated

This follow-up preserves the dated Nov2 Kernel runtime observation and original
17-check native failures above. A later observation does not rewrite either.
The AgentCard parent currently requires Tilion and owns integration/deployment;
this investigator made no production configuration change or benchmark launch.

The sealed Nov10 read-only counterexample, packet SHA256
`907ba1f69b323b404a67ffe49afef1e622374f76b2cb7efc3cfde339048f892c`,
found Machine `8dd736ae056578` instance `01M71VTT9N7N7Z9Y72FYP8C9GG`
with config.env Kernel but worker PID596 initial-exec Tilion. Native birth was
`df0bb2de-ea37-4f0a-80de-acc4792c1f60:596:40`. Installed worker/config source
uses non-overwriting dotenv; app-secret NAME BROWSER_PROVIDER exists. The secret
value was never read. Only one of eight started workers was sampled then; no
claim was made about the other seven or 25 stopped workers.

The first bad owned boundary is `resolve_prod_worker_browser_provider` in
`scripts/run-bench-cloud`: it projects Machine config.env as runtime authority.
App-secret overlay and running-process initial environment can disagree with
that projection. Two archive searches covered effective environment/process
birth/config authority and Tilion/provider parity. This existing open case and
`2026-07-20-worker-reads-backend-api-url-not-backend-url` were read before repair.

The unchanged permanent native-CLI regression in existing
`scripts/tests/cloudbench-provider-contract.test.py` injects config Kernel,
verified same-Machine/PID native Tilion observations and local Tilion. Against
the old actual resolver it exits1 before staging with
`benchmark worker env does not match production: local=tilion prod=kernel`.
The same registered test passes five consecutive times on the private candidate.
The full owning suite passes15 tests, including actual probe execution against
injected psutil/proc/source boundaries, secret redaction and negative identity,
provider, source-contract and lifecycle cases. Existing worker-pool-cutover
regressions pass40 tests. Bash syntax, Python compile and whitespace/apply checks
pass. Commands, native counts and original failures are retained in
`final-commands.json` and logs under the private investigation directory.

The proposed three-file patch is SHA256
`7da85eb1ea92eec99cc7e9daa341052effae60b4b9f62d15be419a66d0324abe`.
It delegates only the worker-authority resolver to the existing runtime helper.
That helper lists the production fleet, probes only already-started Machines
using bounded native exec, binds native Machine ID/version and worker
boot/PID/start ticks/provider/source before and after, and rechecks the exact
active Machine identity set. It requires one canonical /app worker per active
Machine and one unanimous supported provider. Missing, invalid, mixed,
unreachable, foreign, ambiguous or drifting evidence refuses admission. Stopped
or suspended Machine config is not a live observation and is never probed or
woken. Backend Render authority and all existing per-role parity checks remain.
No local/TOML/secret-name fallback, fixed-Tilion override, new task definition,
evaluator, timeout or financial/provider behavior is introduced.

The authority is kernel initial-exec BROWSER_PROVIDER plus installed
non-overwriting source contract, not Python heap/current code-object identity
or proof against arbitrary later mutation in every imported module. Installed
source layout/contract incompatibility fails closed. This explicit current-active
scope is not a claim about dormant workers, fleet readiness or E2E outcomes.

Independent reviewer accepted CODE_ONLY at exact patch/hash, receipt
`independent-review-7da85eb1ea92eec9.json` SHA256
`c4bd4966a10e8313357ffda353cbc73849c9110635d54829465931b10c6675fa`.
The patch remains private during focused native source freeze. Shared-source
application, public owning validation and a successful actual current-active
observation remain parent-owned integration prerequisites.

A separately authorized ONE read-only invocation of this exact private resolver
was attempted00:05:54.879Z on Nov11. It failed closed in0.166s/exit1 at the first
native `flyctl machines list` command. There were zero execs and no Machine
observations, wakes, starts, stops or updates. The scoped error is ValueError;
raw native stderr was not retained, so the finer cause is unclassified. No retry
or credential/setup change was attempted. The original failure and unchanged
candidate hashes are retained under
`live-readonly-20261111_000502-b0506322/receipt.json`. This attempt gives no
current provider/fleet/cloud readiness or native-task PASS credit.

Status remains OPEN: local causal false-preflight behavior is reproduced and a
private candidate passes its owning regressions; actual current production
observation/integration and original unchanged cloud outcomes remain unverified.


### One canonical credential-context correction, then stop

The parent established that the first standalone invocation omitted the native
launcher's credential selection: parent FLY_API_TOKEN and eligible benchmark
token were absent, while canonical last-resort agents/.env FLY_API_TOKEN existed.
A separately authorized ONE corrected invocation loaded only that canonical
selected token into the child environment, without output, hashing, persistence
or global/environment-file change. The first0exec failure remains unchanged.

The corrected invocation at00:08:44.159Z took1.520s and failed closed. Native
listing succeeded and returned8started/25inactive Machines. The first read-only
exec CLI exited0 and printed a complete bound observation for Machine
`d8d5440b6063d8`, instance `01M71VTKQ0HKVGK1A85GY7SSDH`: workerPID596,
birth `0851b829-bbcc-4bc9-8ca3-0dad097cb86a:596:33`, initial-exec providerTilion,
matching before/after, installed workerSHA60efdf3b4f295c379c860bb5c54b98558d1b2400985e4967f59fb072f8e6fc46
and configSHAd224647a54747e970109927f31a4636bbdecda30b1b543164f7cec87c754845d.
The worker/config non-overwriting source checks succeeded.

A NEW private candidate caller-compatibility gap was exposed: although the CLI
process exited0 and returned complete observationJSON, looking up the API-style
`exit_code` key in its decoded response returnedNone. The sealed helper's strict
required exit_code:int0 guard therefore rejects this CLI result. Its injected
fixture had always supplied exit_code0. The sanitized recorder's provisional
REMOTE_PROBE_ERROR category was computed fromNone!=0; it is not proof of a
provider, remote command or authentication failure. Exact raw envelope keys and
absent-versus-null distinction were not captured; the finer CLI status contract
must be established before normalizing it. No null-as-success assumption or
weakened identity/source/complete-payload guard is approved by this observation.

Seven workers and final Machine-identity inventory remain unverified, so this
attempt gives no all8/runtime authority/cloud admission or native task PASS
credit. It made1list and1readonlyexec, no starts/wakes/stops/updates or other
services. All three7da85 candidate hashes remain unchanged. No further live call,
credential fallback, setup loop or source modification was performed. Evidence
and separate category adjudication are retained under
`live-canonical-readonly-20261111_000818-57e4978f/`. Root owns any next scope.


### Private source-backed CLI-envelope correction

Installed flyctl0.4.115 commit a1cf49a52b36fba66a2bf0907617bd5aadb8a727
uses fly-go0.11.3. Primary pinned exec.go94-113 returns JSON serialization
without propagating guest command status to the CLI process. The SDK response
at machine_types.go1107-1110 serializes int32 exit_code with omitempty and has no
exit_signal field. Therefore CLI exit0 is not guest completion proof, and omitted
zero status cannot safely be normalized by treating missing/null as success.
Official Machines OpenAPI defines raw integer exit_code and exit_signal plus the
direct command-array request; source URLs, hashes and JSON pointers are in the
private correction receipt. No real production call was made during repair.

The existing permanent native-CLI test now includes the source-backed successful
CLI JSON with its zero exit code omitted. The unchanged test fails on7da before
any staging and passes five consecutive times on the corrected candidate. That
candidate bypasses CLI response reserialization only for exec, reusing existing
retained_agent_machine.Fly.request and requiring explicit int exit_code0 AND int
exit_signal0 along with all prior complete payload/identity/provider/source proof.
Inventory remains nativeCLI; per-role Render authority and no-wake rules remain.
A backward-compatible keyword timeout with existing30second default bounds the
resolver's raw API request by its remaining120second observation deadline.

Four-file candidate SHA2564ce7f8698aebd8b19dcaf2a4c74cfd9597ec3a6ebc036115147104d765a4d023
is private and awaits independent review and root integration. The full owning
suite passes17 tests, including explicit missing/null/noninteger/nonzero exit,
missing/null/nonzero signal, malformed payload, HTTP503 and existing lifecycle
identity refusal controls. Existing worker-pool40 and native-client33 suites pass;
syntax/compile/whitespace checks pass. The first33suite invocation lacked a
private-copy Dockerfile dependency; that original failure was retained and the
unchanged dependency copied before the same suite passed. No skip/criteria change.

Original7da bytes/review and both live-attempt failures remain immutable evidence.
A fresh authorized current-active raw-API observation is still required; no all8
readiness, successful cloud admission, native task PASS or complete RCA claim is
made from these injected tests. Case status remains OPEN.


### Authorized current-active raw-API observation — 2026-11-11

After independent final CODE_ONLY review f20d89f878ed2c8d5b3e527cc5f28ff9fc14545f0c2951a94622d8884f2bed0c
of exact4ce7f8698aebd8b19dcaf2a4c74cfd9597ec3a6ebc036115147104d765a4d023,
the parent authorized ONE read-only invocation with canonical child-only
agents/.env Fly credentials. It ran00:23:28.063Z–00:23:32.441Z,4.378seconds,
exit0/providerTilion. It made two inventories and eight raw Machines API exec
calls. Each returned HTTP200, explicit integer exit_code0 and exit_signal0,
complete matching before/after native Machine/process/provider/source proof.
The final ID-bound active Machine records and configuration digests matched
the initial records; native inventory row order varied and was not treated as
an ownership invariant. Counts remained8started/25stopped. Stopped Machines
were not probed, woken or used as live-provider authority.

Sanitized per-worker evidence is retained in
`live-raw-api-readonly-20261111_002123-80af6f67/current-active-authority-summary.json`,
SHA256ea6c3d685afdebabb698787c9c0a861df10341ef27ede09389bf9d68ec82b3cd.
The receipt SHA256 is58769975595632f0dd7a3fa1fb1dccee58bbe445ec84dc685e55326331ab1a6a;
the native observation audit SHA256 isb4d7d8586a8583217abcdd6f894a7cd08354256a0f090116c8cadebe250e4f32.
No raw Machine configuration, credential value/hash or other environment value
was persisted. The recorder was pass-through and added zero native probes.
All four sealed candidate file hashes remained unchanged. Both prior failed
observations and the original7da seal/review remain preserved.

The eight currently active canonical workers all had initial-exec Tilion,
verified with their installed non-overwriting source contract. This proves
current-active worker provider authority at that observation time; it does not
prove Python heap/current loaded code object identity, arbitrary later imported
mutations, dormant-worker configuration, browser vendor readiness or any cloud
benchmark/E2E outcome. No provider flip was needed or performed. Resource effects
were eight finite read-only observers with explicit normal completion, zero
Machine wakes/starts/stops/updates/config/secret/lease writes, and no financial,
model, browser or benchmark operation. The parent still owns source release,
shared application/public checks and unchanged original cloud/native validation.
The canonical case remains OPEN for that integration/outcome work.

Reference-locator correction: the saved pinned fly-go source definition is at
lines1206–1209; earlier web-normalized line1107 was not the saved source line
number. Source content/hash and the omission/signal diagnosis are unchanged.

Parent integration on November11 applied the exact independently reviewed
4ce7f869 patch after the five native focused runs released their source freeze.
Public checks against the shared checkout passed: all17 registered provider
contract tests,40 worker-pool regressions and33 retained-machine client tests.
The archive validator also passed1692cases. These are actual shared-source
results, separate from the earlier private checks and successful read-only
eight-worker observation. Original native cloud outcomes remain pending;
no local managed or production provider setting was changed.

The parent also found that earlier "registered" meant unittest discovery,
not recurring deployment invocation. The reviewed94a054 patch adds the three
existing mocked suites to the existing structural-gate registry, with exact
command ownership and real dependency-selection regressions. Shared checks
passed10 registry tests,66 selector checks and actual dispatch of all three
new entries (17/40/33 tests). This strengthens recurrence without changing
provider, application, native benchmark or concurrency behavior.
