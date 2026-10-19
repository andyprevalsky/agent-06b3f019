# Benchmark Infra capture source checkpoint

Old devbox: `c5f40427-00e7-4554-b3a8-ef48bd5f0222`. Original Claude main session: `17b2573b-417f-49ba-bf6d-0f84dbb474f8`.
Original thread: https://boxes.dev/thread/thr_84717e4212794a3a86aa223ee1b5413f.
Migration helper: https://boxes.dev/thread/thr_7e9329c66e584e97ae23303e758d110c.

Exact original-volume capture helper and owning regressions. In-progress work from native subagent a7830b125d38b83de; no final acceptance or deployment is claimed.

This draft preserves the actual old filesystem source at its existing branch, including any tracked deletions. It is a WIP checkpoint. Normal hooks remain enabled. No new tests or deployment were performed by the migration helper. Historical tests must be read with their exact source/evidence bindings; interrupted or incomplete gates remain pending.

The main goal is five consecutive qualifying LIVE runs of fifty distinct eligible DAILY tasks, with uncached image builds, 1,200-second execution windows and the original 5,400-second image-through-full-release clock. Current accepted streak is 0/5. Normal CLI defaults, task content and grading remain intact. The latest user asks for QUEUED/IN_PROGRESS/COMPLETED reporting with stage times and says continue.

Central migration handoff is in PR1478, branch `fix/cloudbench-donor-snapshot-refresh`, `docs/handoffs/swap-harness-c5f40427-00e7-4554-b3a8-ef48bd5f0222.md`. All linked source checkpoints must be saved before continuation. Preserve Freedom, protected instructions, all original evidence and exact resource ownership. Migration grants no merge/deploy or production-env writes; existing task approval boundaries remain effective. Do not launch new paid work before reconciling the two unresolved owners documented centrally.

## Original source inventory

```json
[
  {
    "path": "agents/benchmarks/README.md",
    "sha256": "8ca8b458f78f261f90007bf3015e2622922ca2649546eb75e901861ba27ed22e",
    "deleted": false
  },
  {
    "path": "agents/benchmarks/cloudbench_dependency_sync_test.py",
    "sha256": "415984c54e706d5aa9d9f07e40e7872ae8045b019c2fc0f8536347b5b1322fc7",
    "deleted": false
  },
  {
    "path": "agents/benchmarks/cloudbench_runtime_retention_test.py",
    "sha256": "d8c150fd6248de0ed8005310b5d2ff3267f6ede8d6bcbac95429e573c046533b",
    "deleted": false
  },
  {
    "path": "scripts/cloudbench-machine-readiness.py",
    "sha256": "395c0af0167aee641c619112ccbbedb2998d5933488f1264c5c14be8d9a1e709",
    "deleted": false
  },
  {
    "path": "scripts/cloudbench-original-volume-capture.py",
    "sha256": "365b6a3394db1463cf62d5faf0fc1f913c1d1d1549ed5b325808b32888a436f5",
    "deleted": false
  },
  {
    "path": "scripts/cloudbench-startup-failure-archive.py",
    "sha256": "4106e656cac48d20d34c7e7b2ff433901443e8c166efd3bc2cab52dafdfb94eb",
    "deleted": false
  },
  {
    "path": "scripts/run-bench-fleet",
    "sha256": "3a239a68c3376fe803739c2480201921e0098a1bb3e54e9e8d070fe9d0918858",
    "deleted": false
  }
]
```
