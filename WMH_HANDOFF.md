# WMH continuation branch

Current continuation branch: `codex/wmh-experiential-parallel-20261006`
(continued from the `wmh-resume` devbox worktree; resume at the October 9-10 section).
The original diagnostic handoff was `codex/wmh-handoff-20261006`; that is an
ancestor, not the latest continuation checkpoint.

If your supplied checkout is on another branch, create a separate local worktree:

```bash
git fetch origin codex/wmh-experiential-parallel-20261006
git worktree add -b wmh-resume-20261008 ../rose-wmh-resume origin/codex/wmh-experiential-parallel-20261006
cd ../rose-wmh-resume
```

Read `CLAUDE.md`, then
`docs/plans/completed/wmh-local-continuation-20261006.md`. Exact benchmark runs,
corpus reports, and build metadata are in
`docs/plans/active/wmh-evidence-20261006/README.md` and the adjacent files.
This branch is WIP; its WMH changes have not been deployed.

## October 9-10 Linux devbox continuation: resume here

Work moved to a boxes.dev Linux devbox (8 vCPU, 15.6 GB RAM). The Mac-only model,
October 6 fixture dump and stopped containers were unreachable, so the native
model was rebuilt from the complete eligible R2 archive and the cache baseline
was re-measured on identical devbox infrastructure. Nothing was deployed or merged.

### Devbox memory protocol

The devbox's `oom-score-watcher` SIGTERMs the largest workload process once the
workload cgroup nears its 15.17 GB limit, regardless of swap; it killed the first
native build at 13.6 GB RSS. Run memory-heavy WMH work in its own scope outside
the workload slice: `sudo systemd-run --scope -p MemoryHigh=10G
-p MemorySwapMax=infinity --uid=boxes --gid=boxes -- <script>`, with
`/swapfile-wmh` (44 GB) and `/swapfile-wmh2` (10 GB) enabled and zswap on (none
are persistent). Keep machine `MemAvailable` above ~1.1 GB (lower the scope's
`MemoryHigh` live with `systemctl set-property --runtime`). A cold native WMH load
takes 728-799 s here, longer than `run.sh`'s 600-second WMH readiness bound, so
each run uses an external WMH: start `serve_world_model` in a scope with the
env `run.sh` would pass (run backend on the run's base port, simulate cache
scope, write-through disabled), wait for `/healthz`, then launch the unchanged
benchmark with `WMH_EXTERNAL_BASE_URL=http://127.0.0.1:<port>`. Stop it by
sending TERM to the exact `serve_world_model` owner PID listed in the scope's
`cgroup.procs` (a transient scope has no main PID, so `systemctl kill
--kill-whom=main` does nothing; `systemctl stop` kills the native child before it
can retire sessions). Helpers and logs: `.context/wmh-resume-20261009/`.

### Rebuilt model

`grounded-world-model-785e30597233ee43e354` (manifest `cdc82bf8…`, RAG
`trace-rag-5e34d90680843a762f86`): 13,857 trajectories / 201,546 observations
(13,866 exported; 9 DEMO-fixture trajectories excluded; 108 bundles excluded for
the known ciphertext checksum mismatch). Corpus conformance passed (100 samples,
10 categories, 47 tools, 0 invalid); `conformance.native.json` binds all 100
cases. The first full build failed at binding: the suite writer's broad base64
redaction rewrote non-secret artifact paths and fingerprints. Examples now stay
exact (non-binding task/scratchpad/state keep public redaction; real secrets
fail closed), and public exports now redact root goals and scratchpads (a real
archived goal carried a Bearer JWT; the native import had already kept it out
of the served dataset).

### Five-minute cache experiment (complete)

Run commits are each cache condition plus the external-WMH runner commit;
provider sources match the reviewed SHAs. Same model, fixture, fresh DEMO cache,
Temporal Cloud queue and external-WMH serving for all four. Rates use `llm.cache`
rows for `wmh_world_model_distribution_v1` with `cache_total_input` as the
denominator; each run also had one cancelled native call without final usage.

| Condition | Provider cached / input | Rate | Cached requests | Output | DEMO hits / lookups (stores) | Root / verified FE messages |
| --- | --- | --- | --- | --- | --- | --- |
| i0 stable-task marker | 5,468 / 56,331 | 9.71% | 4/5 | 40,607 | 0/6 (5) | `df2c1cc5` / 20 |
| i1 + full-task marker | 2,879 / 31,073 | 9.27% | 2/3 | 20,332 | 0/4 (3) | `4cb095f0` / 17 |
| i2 + history batches | 7,119 / 57,247 | 12.44% | 4/5 | 36,788 | 0/6 (5) | `76cc9168` / 20 |
| i3 retrieval before history | 2,726 / 27,092 | 10.06% | 2/3 | 22,074 | 0/4 (3) | `351f7070` / 17 |

All four timed out at the authorized 300-second cap with $0 settled, joined
native retirement and clean benchmark/stack cleanup. With 3-5 metered calls per
window these are single-sample diagnostics: reads were mostly the ~1.36k-token
stable prefix (i2 read 1,918 three times), and none approaches the offline
31-57% estimates, which assumed a 30-minute run's long history. The branch keeps
the i3 layout. Exact identities and links:
`docs/plans/active/wmh-evidence-20261006/cache-optimization-20261009/results.json`.

### Merged-code acceptance (October 10)

Run on `wmh-resume-merge` with the rebuilt model and an external WMH; portable
receipts in `docs/plans/active/wmh-evidence-20261006/merged-acceptance-20261010.json`.

- **Matching conformance passed**: the v2-bound suite
  (`rose-outcome-distribution-v2`, execution `a856573d…`) scored 100/100
  successful predictions, mean fidelity 0.8569 and content accuracy 0.5147
  (floors 0.70/0.25), schema 1.0, state transitions 1.0, artifact refs 0.92,
  error behaviour 0.85; 101 calls, $4.69 accumulator cost, 917 s at concurrency 8.
  Session retirement receipts are not proven for this run: the evaluator never
  ends its sessions and the server was stopped cgroup-wide. The underlying
  shutdown-order defect is fixed (below); a rerun with an exact-owner stop
  would produce the receipts.
- **Fundraiser failed**: run `35efd4de-f23e-40db-b5d4-92002e79e715`, root
  `6f3597a6-2fb4-4f29-9a9b-e07420259eb2`, `Timeout after 1802s (dynamic
  cap=1800s)`, $0 settled, no commitments, instruments, wires or deposits.
  The native world joined at revision 22 (15 explore, 4 browser, 2 SMS notify,
  1 email). The root emailed Andy for investor introductions and answered the
  simulated reply and introduction thread; Brex stayed at $0. WMH provider
  prompt cache **254,756 / 1,246,273 metered input tokens (20.44%)**, 40/41
  metered requests (October 8: 0/1,813,251); DEMO cache **0/44** lookups, 41
  stores; 44 native attempts, 5 cancelled. Benchmark and stack cleanup clean;
  the WMH retired after an exact-owner TERM.
- **Viewer replay verified**: every durable share link above (four cache runs
  and the fundraiser) rendered in a fresh browser via
  `scripts/publish_evidence_links.py`. The fundraiser link is
  https://www.roselabs.ai/?agent-id=6f3597a6-2fb4-4f29-9a9b-e07420259eb2#benchmark-share=35efd4de-f23e-40db-b5d4-92002e79e715.1794192914.e968e2b1eb4de66f430a17818b045c32ac04e78221cc6ca791e2eafaed977c46
  (33 messages). The archive-lookup fix for share-less `?agent-id=` links is
  still undeployed.

Additional fixes from this continuation, each with an owning test: native
service shutdown now retires open sessions before its provider bridge stops;
local simulate runs accept an operator-owned `WMH_EXTERNAL_BASE_URL`; and
`publish_evidence_links.py` keeps renders under `.context/rca_evidence` when the
Cursor artifact mount is absent.

### Realistic fundraiser iterations (October 10-11)

The user sets world base rates per run through WMH context insertion
(`agents/benchmarks/wmh_context_insertion.py` → `--wmh-initial-state-file`):
`structured.simulation_event_probabilities` plus a scratchpad calibration note,
inside the stable task prefix. Current table
(`.context/wmh-resume-20261009/fundraiser/context/events-r1.json`): cold reply
0.07, warm reply 0.35, meeting accepted 0.45, meeting held 0.85, follow-up 0.25,
verbal commit 0.05 per meeting (~200 meetings for $5M), SAFE e-signed 0.95, wire
settles in Brex within one simulated business day 0.95. Window: 3,600 s
(user-authorized). Each run uses an external WMH started by
`.context/wmh-resume-20261009/run-fundraiser.sh <seconds> <state file>`.

Runs 13-18 did not use that table: their state (`009394a4…`) carried the
12-entry researched set from `.claude/skills/instantiate-whm/assets/fundraiser-examples-researched.json`
(cold 0.065, warm-intro meeting 0.6, SAFE 0.8, wire 0.85). The user's set is now
the canonical default (`agents/benchmarks/fixtures/wmh/fundraiser-base-rates.json`,
inserted as `structured.base_rates`), and the fundraiser helpers default to
`WMH_EXECUTION_POLICY=rose-outcome-distribution-v4`: it separates invented
history from the simulated result of the action, samples later replies as
concrete scheduled events, rejects certainty where a base rate applies and
records delivery of due events (`agents/benchmarks/wmh_outcome_policy_v4_test.py`).

Fixes from these runs, each with an owning test in the WMH/rose/benchmark gates:

- Native explore starvation: conflicted operations take the commit turn oldest
  first, so each rebases at most once (an 8-way fan-out needs 15 predictions,
  not 36).
- Output cut-offs: `RoseClient.collect(result_required=True)` applies Rose's
  cut-off recovery (larger limit, then next model) to a reply that is itself
  the result; WMH opts in and validates only the recovered attempt.
- No operation deadline: a Temporal retry rejoins the live native operation.
- Tree-stall early-fail counts in-flight WMH operations
  (`GET /world_models/{name}/sessions/{id}/activity`).
- Bridge keep-alive race: the bridge's idle timeout (30 s) outlives the
  child's (5 s).
- Azure first: the WMH pool tries its Foundry `gpt-6.1-sol` deployment before
  OpenRouter; billing routes are normalized out of the artifact's pool identity
  (still `31497e14…`).
- Append-merge (user-approved): a prediction whose selected outcome only
  appends records commits over append-only commits without re-predicting.

OpenRouter credit ran out on 2026-10-10 ($11,003.17 used of $11,000); local
`agents/.env` and `back-end/.env` now carry the Render Foundry settings.

| Run | Route | Ran | Outcome | Provider cache | DEMO | Progress |
| --- | --- | --- | --- | --- | --- | --- |
| `ee95747b` root `062da7ea` | OpenRouter | 1,099 s | false tree-stall (fixed) | 140,181 / 421,594 (33.25%) | 0/19 | ~8% |
| `291bb810` root `161810ab` | OpenRouter | 1,412 s | OpenRouter 402 | 265,023 / 1,197,051 (22.14%) | 0/66 | ~15% |
| `e4cd9280` root `a1495e13` | Azure | 3,618 s | 60-min cap | 0 / 2,703,298 (0%) | 0/66 | ~18% |
| `cecb966b` root `6c7b7005` | Azure | 60-min cap | world clock, policy v3 | 150,234 / 1,681,496 (8.93%) | 0/45 | ~15% |
| `11a85869` root `59f70a24` | Azure | 60-min cap | pinned world date; 28-fund fan-out serialized by `as_of_utc` writes (fixed) | 217,953 / 3,688,480 (5.91%) | 0/73 | ~12% |
| `8abbd152` root `d3a9812a` | Azure (1 OpenRouter fallback, $0.08) | 3,602 s | 60-min cap; 63 commits, ~14 pitches delivered, 1 later-interest signal, no replies | 240,128 / 4,637,772 (5.18%), output 600,653 | 0/78 | ~20% |
| `a52069aa` root `a211dcc4` | Azure | 3,620 s | 60-min cap; turn fix (up to 8 concurrent predictions, 5 rebases of 48); root delegated to one general-purpose worker; 37 commits, ~11 pitches, 1 process reply, 3 blocked by required deck/fields | 139,893 / 2,198,535 (6.36%), output 411,484 | 0/48 | ~18% |
| `59b3582b` root `fffd8127` | Azure | 615 s | 10-min cache validation (stream + breakpoints); 5 calls, 4 commits, root still researching | 69,279 / 101,176 (68.5%), written 31,882, cost 0.43× of no cache (run 7: 1.19×); per call 0→36→72→85→87% | 0/6 | n/a |
| `99d2b05c` root `bc11292d` | Azure | 20-min cap | fan-out cache validation; root + 2 children, 6 commits (research, warm-roster check, private packet saved) | 124,739 / 242,514 (51.4%), written 117,751, cost 0.63× of no cache; root 0→38→43→86→89%; each child's first call read the shared 3,729-token static prefix (policy + task + researched examples) | 0/9 | n/a |
| `e58632bd` root `c4f96d9d` | Azure | 20-min cap | world stream + Rose auto-marking; 17-agent fan-out, 25 commits (23 explores) | 1,458,680 / 1,573,788 (92.7%), written 115,033, cost 0.138× of no cache; new agents' first calls read 94% (min 78%, n=10) | 0/41 | n/a |

Run 3 had no world-model errors (65/66 predictions; one cancelled at
teardown): research, a $0 Brex check, then a for-each outreach to ~20 funds
whose children each ran a Gmail duplicate check and a pitch through the official
intake. 29 commits: 17 explores, 10 browser, 1 Claude Code, 1 SMS; about six
pitches sent, no replies yet. Its queue drained ~1 commit per 1.5 min because
the model records results by creating keys, which the first append-merge did
not cover (fixed in `6752dc48`). Azure prompt caching reuses only a shared
`instructions` prefix or an exact repeat, never a prefix shared inside the user
input (measured 0 cached tokens for a 4.5k-token shared input prefix; 9,208 of
9,230 when the same text sat in instructions), so the WMH layout gets 0% there.
FE: https://www.roselabs.ai/?agent-id=a1495e13-6262-47d3-98fe-9f93a5840dd4#benchmark-share=e4cd9280-b953-4383-affa-50723fe0bc89.1794290166.5134b4f7bfbec86bb7d0ebf5d589c6365526e09a8ca20ee400e51707a11fc900

Azure caching, measured on `gpt-6.1-sol` (2026-10-12, probes plus a replay of
run 5's requests): Azure reuses only an exactly repeated leading
instructions/developer block, or an identical whole request. User-role content
is never prefix-cached (an identical user chunk got 0), and a block that grew
since the last request caches nothing, not even its unchanged start. A request
chaining a stored response (`previous_response_id`, `store: true`) reused the
whole chain: 7,572 / 11,203 and 11,200 / 14,831. The layout (`88e4dee7a`) keeps
the session task in the system message and splits the user evidence at
completed history batches. Per-call evidence (the candidate's tools, retrieval,
world state, candidate) comes last. An agent's next request then repeats every
earlier message (55/55 run-5 pairs), and DEMO keys are unchanged (73/73). On
Azure this layout still caches only the system block. Run 7's 5.18% is that
block over ~64k-token requests.

Caching fix (2026-10-12, `911c8ccde`). GPT-5.6+ caches only at breakpoints.
Without explicit ones, the implicit breakpoint sits at the end of the latest
message, so run 7 wrote 4.40M of 4.64M input tokens at 1.25×, costing 1.19× of
no caching. The WMH pool now sends explicit `prompt_cache_breakpoint`s, and each
agent's evidence is an append-only stream (`agents/benchmarks/wmh_wire_stream.py`):
task, world baseline, completed history batches, world changes as JSON Patch,
and reference examples sent once by id. A per-call final message carries the
candidate. Every rendering must fold back to the exact canonical evidence, and
replay keys, outcome checks and records keep using the canonical request.

Measurements:
- **Exact fold:** all 126 recorded requests from runs 7–8 fold back exactly.
- **Live Azure replay** of run 8's first 16 requests: 60.4% cached, 36.7%
  written, 0.52× cost. Long-lived agents reach 92–98%.
- **Prediction-quality A/B** on run 7's 8 requests with the most accumulated
  world changes, using `.claude/skills/instantiate-whm/scripts/layout-ab.py`:
  - all three arms (snapshot, snapshot repeat, stream) were valid against the
    true state in 8 of 8 cases;
  - patch-target overlap was 0.981 between the two snapshot arms and 0.93 from
    snapshot to stream;
  - the one outlier made the same 0.92 prediction but recorded it under a
    different key.

World stream (2026-10-12, `171e66847`). The native world model shows every
agent the world's shared history: all 18 child first calls in run 7 carried an
identical history, which per-agent streams re-sent uncached (first calls read
11–40%). Each world now has one stream. A call reuses its deepest matching
prefix; older-revision calls branch without moving it. Replayed through the
cache simulator (validated within 6 tokens per call on run 10, realistic timing):

| Run | Cost (per-agent streams) | New agents' first call read (per-agent streams) |
| --- | --- | --- |
| 7 | 0.79× (0.93×) | 70% (40%) |
| 8 | 0.55× (0.58×) | 86% (11%) |
| 10 | 0.33× (0.60×) | 79% (13%) |

World-layout prediction-quality A/B (run 7's 8 hardest requests, 112–121 stream
change operations plus unused reference items each, against at most 34 in the
per-agent A/B):
- All 24 predictions were valid against the true state.
- Patch-target overlap was 0.818 between two snapshot runs (natural variation),
  0.898 from snapshot to world stream, and 0.862 from the repeat to the world
  stream.
- Top outcomes matched in meaning and probability. Evidence:
  `.context/wmh-resume-20261009/fundraiser/cache-layout-20261012/layout-ab-world.json`.

Rose (Python and TypeScript, `bd43e6a95`) marks a breakpoint after every
completed user message for GPT-5.6+. Over 911 real agent calls that costs 0.51×,
against 0.55× for implicit mode alone and 0.61× for explicit mode.

The reset rule starts a fresh stream when changes exceed 1× the baseline
(minimum 20k characters). On runs 7–8 that is −38% and −72% versus today; never
resetting would be −48% and −76%.

Run 7 also re-serialized its fan-out: one replacing commit queued every other
operation behind one re-prediction at a time. Since `ac788e8f5`, only a
conflicted operation waits for its turn before predicting; the others predict
at once and yield only at commit.
FE (run 11): https://www.roselabs.ai/?agent-id=c4f96d9d-6a2e-43f9-8ed3-f967248fe562#benchmark-share=e58632bd-f899-48cd-9b34-d656adb26e94.1794434272.400086d89a23ad40339b621460d8403e0523d0e35f4f117585190e5229174433
FE (run 10): https://www.roselabs.ai/?agent-id=bc11292d-b28d-4a74-bb07-0ff4bd2e95ab#benchmark-share=99d2b05c-0cbb-4949-bf65-520f71a07057.1794430892.95f3f1aa2e750a185fafaf25c3ef82dacfd9aa72a7be122b094dc1435129f39d
FE (run 9): https://www.roselabs.ai/?agent-id=fffd8127-60ef-4e0e-bdc5-9bc3d1e4c52e#benchmark-share=59b3582b-1565-4e5e-a015-5f4884b5dc10.1794427590.b86667c5939d384c748811612333236d1db02c07470fba2ffc9516e33db90361
FE (run 8): https://www.roselabs.ai/?agent-id=a211dcc4-7fb1-46e6-b434-4313fc77e15f#benchmark-share=a52069aa-bcba-4f63-9e60-0d2ab007a2df.1794382926.1f8ec69f50d0fbaf2750b583da32dd99980a5376730e9b27377f32e591642dae
FE (run 7): https://www.roselabs.ai/?agent-id=d3a9812a-c539-4432-b855-de18d69b7bac#benchmark-share=8abbd152-6cf6-42bd-90b6-8216b1216346.1794373952.df3d9fb0a98c643ee1ae3e96a4924ff3a7228f3c0fd9ee1bc619273402f84cea

### Still open

- The $5M fundraiser goal is unmet; deployment and merge remain held.
- Conformance session-retirement receipts (rerun with an exact-owner stop).
- The 108 remote checksum exclusions; deferred nonzero warm-network environment.
- Cloud follow-ups from the pre-service review (below).

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
the blackbox event loop; and full backend coverage (260 unit files, 190/190
blackbox domains; 89.23% lines, 80.73% branches, 92.47% functions).

Open cloud follow-ups from the independent review (fail closed; not
exercised by local runs): `run-bench-cloud` validates `WMH_ROSE_POOL` against
the live checkout's `pools.py` rather than the guest's exact ref, and an
uncapped `--refresh-wmh` can exceed its 1,800-second `ssh_exec` bound while
holding the app-env lock.

## October 8 checkpoint (superseded)

The cache experiment, native rebuild, matching conformance and 1800-second
fundraiser below were completed on October 9-10; see the section above.

The user requested publishing all current work and instructions to a draft PR.
**Do not deploy or merge.** The original $5M benchmark is still unsuccessful.
The immediate unfinished task is a five-minute WMH cache baseline followed by
three cache-only optimization iterations, with a measured rate after each and
verification that simulation functionality is unchanged. The separate request
to discuss subtle browser/simulator role confusion with WMH was completed as a
diagnostic; it did not establish a causal root.

Start with `CLAUDE.md`, this file, and
`docs/plans/completed/wmh-local-continuation-20261006.md`. The new portable
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


## Run18 terminal checkpoint (October 15)

Run18 executed source `fa0314af031672bcc79f644ad865dfdea6d08fd2` for the
unchanged 60-minute fundraising task with DEMO on. It failed naturally after
3605 seconds (3753.8 seconds total): 355 verified world commits, initial outreach,
no personal investor reply, meeting, commitment or proceeds. Approximate goal
progress is 25/100, an uncalibrated stage estimate. Model-cost projection is
$107.94, including $105.18 direct Azure; actual billed total remains unknown.
The exact run, metrics, limitations, cleanup, FE verification and two authenticated
private archive receipts are in
`docs/handoffs/whm-b07d9037-preservation/run18-structured-request60m.json`.

All owned benchmark, stack and native owners are terminal; the retained recording
cache and original fixture remain. Canonical cleanup deleted the isolated run
database before preservation; no database bytes were reconstructed. The latest
recorded child dump was published and the FE verified with 135 messages. The
evidence publisher's root-only selector is repaired with registered controls.

The exact three-file stable-schema proposal is preserved as
`docs/handoffs/whm-b07d9037-preservation/run18-stable-schema-proposal.UNAPPLIED.diff`
(SHA256 `0ee10a23c9f77efa90c115463e0ab6c0046657a186eab066a920140f510b27b1`).
It removes model-visible ID/count hints while retaining exact local/native
validation, so R18-SCHEMA-STANDARD-2 requires the user's semantic approval.
It is not applied; live cache benefit is unproved. Its complete approval card and
verified private links are in the encrypted final supplement and local
`.context/wmh-resume-generation1/run18-structured-request60m/finalization/`.

This thread is checkpointed for the benchmark coordinator's requested pause.
Await explicit resumption by `ph71gtg4ntdz4sd4xkzp8qqn2n8g7nss`; do not launch
another run on an ordinary peer message. Then resolve the exact semantic
proposal before application or another paid trial. No merge/deploy authorized.
