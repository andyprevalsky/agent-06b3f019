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
benchmark with `WMH_EXTERNAL_BASE_URL=http://127.0.0.1:<port>`. Stop it with
`systemctl kill --kill-whom=main --signal=SIGTERM <scope>` (owner only), never a
cgroup-wide stop. Helpers and logs: `.context/wmh-resume-20261009/`.

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
