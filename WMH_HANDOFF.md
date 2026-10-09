# WMH continuation branch

Current continuation branch: `codex/wmh-experiential-parallel-20261006`.
The original diagnostic handoff was `codex/wmh-handoff-20261006`; that is an
ancestor, not the latest continuation checkpoint.

If your supplied checkout is on another branch, create a separate local worktree:

```bash
git fetch origin codex/wmh-experiential-parallel-20261006
git worktree add -b wmh-resume-20261008 ../rose-wmh-resume origin/codex/wmh-experiential-parallel-20261006
cd ../rose-wmh-resume
```

Read `CLAUDE.md`, then
`docs/plans/active/wmh-local-continuation-20261006.md`. Exact benchmark runs,
corpus reports, and build metadata are in
`docs/plans/active/wmh-evidence-20261006/README.md` and the adjacent files.
This branch is WIP; its WMH changes have not been deployed.

## October 9 Linux devbox continuation

Work moved to a boxes.dev Linux devbox (8 vCPU, 15 GB RAM). The Mac-only model
artifact, October 6 fixture dump and stopped containers are not reachable
there, so the user chose a 44 GB swapfile (`/swapfile-wmh`, not persistent)
and a fresh native rebuild from the complete eligible R2 archive. The
cache baseline must therefore be re-measured on this infrastructure.

Cache conditions are exact commits on `wmh-resume` (each passed the registered
WMH blackbox, native 37 / provider 89 or 100):

| Condition | Commit | Provider source SHA-256 |
| --- | --- | --- |
| i0 stable-task marker only | `dceea3f14` | `9186ce17…` |
| i1 + full-task marker | `cd6292196` | `f4f37226…` (reviewed) |
| i2 completed history batches | `58b889713` | `9cb78043…` (reviewed) |
| i3 retrieval before history | `44f60d04e` | `424415aa…` (reviewed) |

The original Mac baseline source (`6996f338…`) is not recoverable from Git;
i0 differs from i1 only by the full-task marker. The unchanged history-prefix
reproduction failed 2/5 on i1 and passes 5/5 on i2/i3; its 11 guards are now
in `wmh_rose_provider_test.py`. Every run uses one frozen fixture source
(canonical PG16 base `fc9dc500…-pg16-victoria-prod-sync-v1-whatsapp-v2` plus a
read-only prod sync of Tamy's account rows, dump SHA-256 `d84ce812…`), a fresh
per-run DEMO cache in the run's own `victoria_bench_<run>` database (the
canonical base has zero cache rows), Temporal Cloud with a per-run queue, and
`.context/wmh-resume-20261009/{launch.sh,measure.py}`.

### Current main integration (`wmh-resume-merge`)

`origin/main` `470925c93` (214 main-only commits) is merged on
`wmh-resume-merge`. The cache conditions above stay pre-merge. Conflict
resolutions keep main's implementations where both sides solved the same
problem (controller dispatcher, structural gate wrapper, registry reaper
helper) and port only the branch's WMH-specific contracts (read-only
`pools.py` controller mount, `--init`, native retirement gate selectors,
`ssl.SSLError` pre-output classification). Integration defects fixed with
owning tests:

- `run-bench-cloud` and `run_world_model_conformance` rejected the reviewed
  `rose-outcome-distribution-v2` policy; both now admit every registered
  policy, and the conformance CLI derives its choices from the registry.
- `providers/fast_cache/normalize.py` imported benchmark modules into the
  Temporal workflow replay surface (pre-existing on the branch; failed the
  `agent-surface-hash` gate). It now uses a static policy-identity table with
  a registry parity test; cache keys are byte-identical.
- Main's pool invariants now record the pinned `rose-wmh-gpt61` runner's
  intentional direct-auth skip; `openai/gpt-6.1-sol` (OpenRouter modalities:
  file/image/text) joined `VISION_MODELS`.
- Branch fields pushed `back-end/src/domains/data/types.ts` over `max-lines`;
  they moved to `GrepPageCharBounds`. Unread post-child settle variables were
  removed from `run-bench-fleet`.
- Pre-service source `1cd26ad7…` is registered after an independent review.

Merge verification so far: backend tsc, 260 unit files and 9 affected
blackbox domains; frontend tsc, lint and all 150 vitest files; 17 affected
agents blackbox domains including WMH; `benchmark-live-results` (505 passed);
`cloudbench-env`; every structural deploy gate (with `lsof` installed); and
full agents coverage (109/109 blackbox domains, 82% against the 80% floor)
after converting one branch cleanup control to `async_case` so it runs inside
the blackbox event loop. Backend coverage is still pending.

Open cloud follow-ups from the independent review (fail closed; not
exercised by local runs): `run-bench-cloud` validates `WMH_ROSE_POOL` against
the live checkout's `pools.py` rather than the guest's exact ref, and an
uncapped `--refresh-wmh` can exceed its 1,800-second `ssh_exec` bound while
holding the app-env lock.

## October 8 checkpoint: resume here

The user requested publishing all current work and instructions to a draft PR.
**Do not deploy or merge.** The original $5M benchmark is still unsuccessful.
The immediate unfinished task is a five-minute WMH cache baseline followed by
three cache-only optimization iterations, with a measured rate after each and
verification that simulation functionality is unchanged. The separate request
to discuss subtle browser/simulator role confusion with WMH was completed as a
diagnostic; it did not establish a causal root.

Start with `CLAUDE.md`, this file, and
`docs/plans/active/wmh-local-continuation-20261006.md`. The new portable
checkpoint is
`docs/plans/active/wmh-evidence-20261006/cache-optimization-20261008/`.
Its `handoff.json` distinguishes completed work from planned or interrupted work.
The existing RCA files retain all earlier prompt/model experiments and their
probability tables; do not repeat them from memory or claim their single samples
establish calibration.

### Exact current code and results

The native concurrent Experiential engine, model-generated outcome
distributions, validation of every branch before cache writes and after replay,
and sampling once per invocation are already on this branch. The local v2
execution policy is `rose-outcome-distribution-v2`. It grants approvals during
simulation and explicitly permits newly discovered public evidence. Its SHA is
`23feae1291f883f0a2280d6f7295e7391dbc7bd82dc1a9c1ca7caea52354fbb0`;
the effective system SHA is
`d76abcd5f096d65ea92e5f1e1aa538b5bae3643b4ea8618ba7e3a54eed24b470`.
WMH uses `rose-wmh-gpt61` / `openai/gpt-6.1-sol`, effort `xhigh`, maximum
16,384 output tokens. Root/general-purpose agent pools retain their defaults.

The current adapter includes stable session affinity and explicit shared-task
cache blocks. **Iteration 1's additional full-task marker is currently applied
to source, but its five-minute benchmark never started.** This source passed the
registered WMH blackbox (89 provider checks and 37 native checks). Iterations 2
and 3 are reviewed proposals saved as patches, not active runtime changes.

The completed five-minute baseline ran the exact fundraiser task with the
authorized `--timeout-seconds 300` override:

- Run `6b09942d-67f4-4896-8adc-cad4fdb0474b`; root
  `f2936bd3-fe89-4c8f-b397-79807abbdb8e`; native session
  `5a07f48a97af4254ba6c841b4fdb5637`.
- Provider prompt cache: **1,367 / 16,341 metered input tokens = 8.365461%**;
  output 10,978; cached-input requests 1/2. Four native attempts included two
  cancelled calls without final usage. Do not present the metered totals as
  complete billing for those cancelled calls.
- DEMO response cache: **0/4 lookups**, two stores. Distinct full requests are
  expected to miss; never remove call IDs, state, policy, or model from keys to
  manufacture replay hits.
- Timeout observed after 303 seconds; duration including fixture/cleanup 311.1
  seconds. Two predictions committed; $0 settled proceeds. This is a cache
  diagnostic, not a passing fundraiser acceptance run.
- Exact native scope joined and froze revision 2. Both benchmark and stack
  cleanup receipts are clean. FE replay verified in a fresh browser: 20 messages.
  The exact durable link is in `baseline.json` / `handoff.json`.

The previous 30-minute run remains
`bbbdb300-bde5-4386-8463-cbef0cba9319`, root
`f8065e19-2fc5-4557-82a8-62dfadde5382`, with $0 settled proceeds, no investor-form
submission, prompt cache 0/1,813,251 metered input tokens and DEMO cache 0/75.
See the existing `wmh-fundraiser-distribution-20261008.json` for the full result
and verified viewing link. The link was opened on the user's Mac.

### Resume the cache experiment

1. Preserve the model, policy, task, corpus, retrieval, validation, sampling,
   approvals, budgets, and declared tool schemas across all four conditions.
   Only JSON key order, text-block boundaries and cache markers may change.
   Compare stochastic execution rates honestly; a few completed calls are not a
   calibrated performance estimate. Keep parallel tool handling intact.
2. Complete iteration 1 with a fresh DEMO cache and a 300-second task cap using
   the canonical local runner. Run the owning blackbox before launch. The prior
   attempt `wmh-cache-20261008-i1-1791494260` stopped during WMH loading, before
   `services.json` or a benchmark/root allocation. Its original ownership files
   are retained; there is no final rate or clean receipt to claim.
3. From the repository root, apply the saved patch with
   `git apply --unidiff-zero docs/plans/active/wmh-evidence-20261006/cache-optimization-20261008/iteration-2.patch`.
   It moves growing history before changing state and marks the last two
   **complete assistant/tool batches**, retaining the prior exact boundary when
   another batch is appended. Individual-entry markers were ineffective offline.
   Promote `history_cache_tests.py` into `wmh_rose_provider_test.py`, execute the
   unchanged history-prefix reproduction, and require it plus the owning suite
   to pass. The original reproduction had two failures and three passing
   preservation controls; additional malformed/parallel controls were prepared.
4. Run another fresh-cache five-minute task and report its rate. Then apply
   `iteration-3.patch` with the same `git apply --unidiff-zero` command, which
   puts exact retrieved context before history and
   replaces the full-task marker with a retrieval marker. Retain stable-task and
   both complete-batch markers, with at most four markers on the real Rose wire.
   Recheck every input value, cache key, unknown field, tool ID, history array and
   model/system settings; run the owning suite, then the third five-minute run.
5. Report each iteration's provider cached/total input, output tokens, metered
   requests, cancelled/unmetered requests, DEMO hits/lookups/stores and task
   outcome. Use `llm.cache` rows filtered to
   `call_site=wmh_world_model_distribution_v1`, with `cache_total_input` as the
   denominator. The current WMH usage accumulator may report only the uncached
   tail (e.g. 3 tokens); do not use that value for this report. Cache writes are
   not cached reads. Publish and verify every completed run's durable FE link.

Offline audits preserve all 75 original native request JSONs, system text, and
canonical DEMO keys for each layout, with at most four real-wire markers. The
estimated reusable-token opportunities were 4.88% baseline, 5.34% iteration 1,
31.45% iteration 2 and 57.11% iteration 3. **These are not live hit rates.**
Malformed declarations, duplicate/unexpected/unhashable result IDs remain
unmarked without losing their text; valid out-of-order parallel results work.

### Local infrastructure and retained artifacts

The original worktree is
`/Users/andyprevalsky/Developer/rose-wmh-experiential-parallel`; its ignored
`.context/wmh-cache-optimization-20261008/` retains full source snapshots,
launcher logs, paid-run inputs, measurements, and reproducible helpers.
Canonical benchmark artifacts are under `.context/benchmarks/` and
`agents/benchmarks/runs/`. Raw credentials, private runtime dumps, SQLite stores,
model binaries, and database dumps are not Git files.

The tested model remains at
`.context/world-model-fundraiser-gpt61-20261008`, with 179,150 observations in
12,510 trajectories, serving RAG `trace-rag-71aa4160d086e717b2dd` / SHA
`deb2b744ab5f92fae991910e8d9a90d2e4948bb17a4103bd3bfbd59a72178a0e`.
The original full serving inputs are saved under
`native-predictions/3c034a09bf4848c2b40fb569fbc2ea6e`. Reuse local build outputs
only when metadata matches; otherwise rebuild with the native Experiential
instructions in the active plan and `agents/benchmarks/README.md`. The binary
exceeds 1 GB. Do not silently substitute the older legacy rebuild recipe.

When a rebuild is required, use a new output directory with the native engine
explicitly selected, after the complete repo setup and env loading:

```bash
cd agents
source venv/bin/activate
WMH_ENGINE=experiential WMH_ROSE_POOL=rose-wmh-gpt61 \
WMH_EXECUTION_POLICY=rose-outcome-distribution-v2 \
WMH_BUILD_DIR="$PWD/../.context/world-model-native-resume" \
WMH_MODEL_NAME=rose-archive WMH_GEPA_BUDGET=0 \
WMH_MAX_BUNDLES=0 WMH_MAX_STEPS=0 WMH_MAX_STEPS_PER_BUNDLE=0 \
WMH_CONFORMANCE_EXAMPLES=100 WMH_REQUIRE_CONFORMANCE=1 \
  python -c 'from benchmarks.world_model_harness import update_world_model_for_simulation as build; print(build())'
```

Serve and evaluate its matching `conformance.native.json`, rather than the
legacy suite. A changed corpus/model requires a fresh cache baseline for a fair
comparison; the pending iterations should reuse the exact existing artifact
when it remains available and its metadata matches.

The baseline's shared production cache DB and Temporal Cloud connection were
unreachable locally. Its account fixture also could not refresh from production.
The successful baseline used the standard runner with a fresh isolated local
cache DB, a real local Temporal dev server, and the unchanged fixture's existing
`SEED_REMOTE_DATABASE_URL` override pointing to a local restore of the October 6
production-derived dump. All four planned conditions must use identical
infrastructure. If that exact snapshot is unavailable, rerun the baseline for
the new fixture; do not fake fixture success or compare inconsistent sources.

The saved dump is
`/Users/andyprevalsky/Developer/rose-wmh-continuation/.context/benchmarks/seed-cache/fc9dc50073ffa9bbd26b245774dfdbd8f7d9e121-20261006.dump`,
SHA `8543fa9c2af45cb4bfe89021fa5b5fa82d59fdf83e992b8fef45a844c65909f2`.
Restore through `scripts/restore-seed-dump.sh` (the image's PostgreSQL 16 client;
the upgraded host client emits an unsupported `transaction_timeout`). Tamy's
auth identity is in `User.userId`, not `User.id`.

At handoff the iteration-1 and fixture-source Docker containers are **stopped**;
their volumes and recovery metadata are retained. Original Temporal/controller
and WMH processes are absent. Do not signal a recycled PID. Exact IDs and ports
are in `handoff.json`. To reproduce the baseline locally, restart or recreate the
owned fixture source at port 28535, the real dev Temporal server at
127.0.0.1:28533 with namespace `rose-labs-us-east-1.tch2n`, and set
`SEED_REMOTE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:28535/victoria`.
For every isolated run set `FAST_MODE_CACHE_DATABASE_URL` explicitly to its
allocated local DB port; `FAST_MODE_CACHE_USE_LOCAL=1` alone is removed by the
`fast_cache:on` task path. Use repo setup and complete local envs, never example
secrets. Preserve Freedom and all protected agent instructions.

### Probability diagnosis and remaining original acceptance

`role-confusion-diagnostic.json` contains two real GPT-6.1 Sol xhigh dialogues,
exact original browser goals and public answers, with validated quotations.
Diagnostic-only usage: 92,041 input / 13,394 output, 0 cached input, DEMO disabled.
The model did not establish literal actor/simulator identity confusion. Its
public explanations more directly support overconditioning on repeated prior
failed searches, and transferring Andy-specific approval failures to another
browser session. Subtle instruction leakage remains possible: “actor must verify
before using a route” may become “simulator may only predict already verified
routes.” The retrospective diagnostic itself clarified roles and cannot prove
or disprove that original cause. It already predicts new email routes and public
docs, so a blanket refusal to generate new information is contradicted by the
outputs. No runtime prompt changes were made for this diagnostic. The latest
30-minute trace's two actual browser invocations were read-only, not investor
intake submissions; do not interpret no submission as a failed submit call.

After the cache experiment, resume the original complete-corpus/conformance,
fundraiser, and viewer-visible replay acceptance checks from the active plan.
Current main was fetched as `b1e8a47e3`; before this checkpoint it had 209 commits
not on this WIP branch, while this branch had 30 not on main. **Current main has
not been merged in this handoff.** Integrate carefully in a new worktree, preserve
WMH parallelism and immutable policy identities, rebuild when needed, and rerun
the matching conformance and unchanged 1800-second fundraiser. Do not claim the
$5M goal fixed from synthetic controls or a short cache run. Deployment remains
held until the user explicitly resumes it.

## Deferred environment follow-up (October 7)

Update the WMH benchmark environment so warm connection paths are nonzero.
The user requested this as a note for later; the environment has not been changed.

## WMH run reporting requirement (October 7)

After every WMH run, report its final WMH cache hit rate, including cache hits
and total cache lookups. If caching was disabled or counters are unavailable,
state that explicitly rather than presenting an unmeasured hit rate.
