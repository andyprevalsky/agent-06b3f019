# Benchmark Infra hub source checkpoint

Old devbox: `c5f40427-00e7-4554-b3a8-ef48bd5f0222`. Original Claude main session: `17b2573b-417f-49ba-bf6d-0f84dbb474f8`.
Original thread: https://boxes.dev/thread/thr_84717e4212794a3a86aa223ee1b5413f.
Migration helper: https://boxes.dev/thread/thr_7e9329c66e584e97ae23303e758d110c.

Hub group-commit implementation, upload reconciliation, unit/blackbox controls and RCA. Native subagent a9aabdaddc8336ff4 stopped during development. Preserve staged and unstaged edits together; benchmarkHubStore.base.ts is the original local comparison file. agents/venv is a regenerable symlink to the root installation and is excluded from source.

This draft preserves the actual old filesystem source at its existing branch, including any tracked deletions. It is a WIP checkpoint. Normal hooks remain enabled. No new tests or deployment were performed by the migration helper. Historical tests must be read with their exact source/evidence bindings; interrupted or incomplete gates remain pending.

The main goal is five consecutive qualifying LIVE runs of fifty distinct eligible DAILY tasks, with uncached image builds, 1,200-second execution windows and the original 5,400-second image-through-full-release clock. Current accepted streak is 0/5. Normal CLI defaults, task content and grading remain intact. The latest user asks for QUEUED/IN_PROGRESS/COMPLETED reporting with stage times and says continue.

Central migration handoff is in PR1478, branch `fix/cloudbench-donor-snapshot-refresh`, `docs/handoffs/swap-harness-c5f40427-00e7-4554-b3a8-ef48bd5f0222.md`. All linked source checkpoints must be saved before continuation. Preserve Freedom, protected instructions, all original evidence and exact resource ownership. Migration grants no merge/deploy or production-env writes; existing task approval boundaries remain effective. Do not launch new paid work before reconciling the two unresolved owners documented centrally.

## Original source inventory

```json
[
  {
    "path": "agents/benchmarks/hub_upload.py",
    "sha256": "020a593d62a21ba28aa2ab6529ea310fd31932cd4ceea57637495c9ec748094f",
    "deleted": false
  },
  {
    "path": "agents/tests/blackbox/benchmark.blackbox.py",
    "sha256": "94ed97e14c891bcfe8559b08404c98ad6b35a50d1df17976986a71f6d440959c",
    "deleted": false
  },
  {
    "path": "back-end/src/providers/benchmarkHubRunBundles.ts",
    "sha256": "250ad66ed4c97a074babf5c11d5d92096bbe8db069ba9f66411fc2698b6341c0",
    "deleted": false
  },
  {
    "path": "back-end/src/providers/benchmarkHubStore.base.ts",
    "sha256": "a4a6089d5a26d8b2379ca96b4d51b387507ad333d233e27d429335313495efe5",
    "deleted": false
  },
  {
    "path": "back-end/src/providers/benchmarkHubStore.ts",
    "sha256": "8518458fa9960b66e67bd6590e9c71bcc0fbaf6e6ad978cc0148ca3b83836148",
    "deleted": false
  },
  {
    "path": "back-end/src/tests/blackbox/benchmark-hub-burst.cases.ts",
    "sha256": "ac5de3078c0e60598a41c2c7f8e038ea8e8370f5dbdb2676b0361d668babb6f3",
    "deleted": false
  },
  {
    "path": "back-end/src/tests/blackbox/benchmark-hub-index-read.blackbox.ts",
    "sha256": "2fdf971e91c37682d4eba299fe2092321c1deb3dbf7b4c97f2b8912ae9af61b8",
    "deleted": false
  },
  {
    "path": "back-end/src/tests/structural/interactive-transaction-policy.ts",
    "sha256": "7808130441f08c5047318a33fe23638d2a4dcadb6d144efd5a9c18aa95127289",
    "deleted": false
  },
  {
    "path": "back-end/src/tests/unit/benchmark-hub-admission.test.ts",
    "sha256": "84d50d7e7baf14f47d2548ab9a93973d2b9bddce751c259ccc1701c8b7852bf8",
    "deleted": false
  },
  {
    "path": "docs/rca/cases/2026-10-06-hub-final-upload-starved-by-queued-live-snapshots.md",
    "sha256": "efc38f4b244d8660c435c233bcddd879925737f07e00a4e6218c8d3662f91bb6",
    "deleted": false
  },
  {
    "path": "scripts/tests/campaign-hub-grouping.test.ts",
    "sha256": "cc3716c2b566ba345ad58fd01753ff6711ade92257e350b8cd19dff4138c0f34",
    "deleted": false
  }
]
```
