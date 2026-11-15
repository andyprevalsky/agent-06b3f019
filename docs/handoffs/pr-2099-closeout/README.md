# Verifier completion repair: deployment and recovery records

The repair is merged in [PR2099](https://github.com/Rose-Ai-Labs/rose/pull/2099), commit `e158477bc23a0527df4500c3adf209b74ae1b7fd`. The corrected [RCA case](../../rca/cases/2026-11-14-verifier-counted-completion-transport-as-forbidden-task-action.md) explains the producer channel merge, lost/mislabeled execution evidence and mandatory-completion contract conflict. No actual prohibited task action is excused. The original paused agent and its real bug-report violations remain unchanged.

All17 selected gates passed on validated source `c41b933b246b8c7f9ced14bfff97c38fcb6657f7`. Eleven quarantined units passed natively; none failed. One earlier FLAKY has evidence-backed NOT_INTRODUCED attribution and its existing repair owner received the post-merge packet. Current smoke passed11/11; all12 task/canary release lifecycles were verified. The exact four primary runtime files and four owning regressions match the actual merge. Twenty concurrent main paths differ, so this does not assert whole-tree validation equivalence.

All applicable production lanes passed on the exact merge. Original Fly workflow43662238673 failed on HTTP408. Its same durable deployment job was resumed toSUCCEEDED, target surface `36c8f4ae94d7`; native monitor verification reported cooperative_drain_complete. Old-queue open=? remains a qualification; the managed predecessor retirement certificate is the native proof. No replacement job, rollback, forced migration or timed release was used. The workflow-migration matrix passed45/45 with synthetic fixture cleanup. [Production semantics43665767816](https://github.com/Rose-Ai-Labs/rose/actions/runs/43665767816) passed all5jobs on attempt1. The initial read-quota and local missing-token failures remain archived.

## Recover private evidence

The individual receipts in `archives/` bind immutable encrypted R2 objects and their native full-readback and independent restore checks. `validation-and-recovery.json` gives bounded validation/recovery facts; the final archive index and deletion manifest bind the completed union. Raw member names, environment values, session bodies, provider context and SQL/global roles stay encrypted.

Use the existing unchanged `docs/handoffs/whm-b07d9037-preservation/private_archive.py` (SHA256 `2e35e736660660bb6118a939d51b0dd008abe5efaa6387cf252d5d0536b75cf4`) with a selected receipt and a fresh empty independent restore destination. Never restore over the original HOME or machine identity. Bootstrap requires an independently delivered authorized Render API credential and service identity; the receipts alone do not grant access. The proven configuration source is official Navi service `srv-d3jga77diees73cgrvk0`. Read its archive/R2 configuration in memory through `back-end/scripts/render-env.ts --json --show`, never print/persist values. The verified encryption-key fingerprint is `e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730`. The configuration-only adapters are inside the encrypted evidence; their crypto/framing/restore implementation remains the pinned helper. This was exercised with actual separate empty restores; no bootstrap-from-nothing claim is made.

For an independently provisioned checkout, run the following with separately delivered `RENDER_API_KEY` and `RENDER_SERVICE_ID` in the process environment. Choose an existing public receipt and a never-used restore destination. This is the same configuration-only adaptation exercised by the independent restores; it leaves the pinned cipher/framing implementation unchanged.

```python
import base64, hashlib, importlib.util, json, os, subprocess
from pathlib import Path
from types import SimpleNamespace
root = Path.cwd()
receipt = root / 'docs/handoffs/pr-2099-closeout/archives/final.json'
destination = Path('/private/recovery/pr2099-final')
assert os.environ['RENDER_SERVICE_ID'] == 'srv-d3jga77diees73cgrvk0'
reply = subprocess.run(
    ['npx', 'tsx', 'scripts/render-env.ts', '--json', '--show'],
    cwd=root / 'back-end', env=dict(os.environ), capture_output=True,
    text=True, timeout=90, check=True)
remote = json.loads(reply.stdout)  # never print or persist the values
required = ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
            'R2_BUCKET_TRACE_ARCHIVE', 'TRACE_ARCHIVE_ENCRYPTION_KEY_B64')
assert all(remote.get(name) for name in required)
assert hashlib.sha256(base64.b64decode(
    remote['TRACE_ARCHIVE_ENCRYPTION_KEY_B64'], validate=True)).hexdigest() == \
    'e351c7cc5b01303e579fe6d1df833940fdaadf325ca47314414ba10735fc7730'
path = root / 'docs/handoffs/whm-b07d9037-preservation/private_archive.py'
assert hashlib.sha256(path.read_bytes()).hexdigest() == \
    '2e35e736660660bb6118a939d51b0dd008abe5efaa6387cf252d5d0536b75cf4'
spec = importlib.util.spec_from_file_location('native_archive', path)
archive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive)
archive.dotenv_values = lambda path: remote if path == '/home/boxes/rose/agents/.env' else {}
archive.restore(SimpleNamespace(receipt=str(receipt), destination=str(destination)))
```

The helper emits aggregate restore results and verifies the encrypted manifest. Keep the decrypted member names and payload private. The provisioned checkout needs its pinned Python and backend dependencies; the bootstrap credential and dependency setup are independent prerequisites, not claimed as a new-machine bootstrap test.

For each carrier verify complete authenticated stream hashes and every member against its encrypted `MIGRATION_MANIFEST.json`. Use the encrypted logical HOME path-to-staged-member map and original mode/owner/link metadata. Native coherent SQLite online backups are the operational representations; raw DB/WAL/SHM captures are audit bytes and must not be combined with unrelated backups. HOME captures are finite per-file prefixes with per-database cutoffs, not one atomic browser/machine image.

The latest captured PostgreSQL16 dump and globals restored into an owned clean Unix-socket-only cluster:104tables read,411indexes,1RLStable, no invalid indexes or unvalidated constraints. Proof databases and clusters were cleaned. Restore globals only into a fresh private cluster with a distinct bootstrap administrator; never apply archived globals to a live source cluster. This is logical recovery, not physical/WAL or historical row-identity proof.

Git recovery uses the verified historical bundles plus captured incremental bundles. Independently reconstruct the declared remote prerequisite graph with separately authorized GitHub access, then import the recovered bundles into an independent repository without original object stores, hardlinks or alternates. The actual fifth-bundle import resolved21,978capturedrefs and21,179roots, traversed305,162objects without missing objects, and passed strict fsck. Final records commits are additionally durable through the linked reviewed records PR. Five already-pruned historical reflog objects and vanished ephemeral temporary bytes remain UNKNOWN. Reference-tree bytes were rehashed against the authenticated baseline; current namespace metadata and no-writer boundaries are retained.

Freedom and protected instructions were untouched. Preserve their content, modes and literal links during recovery; never disable or bypass them. These Linux records do not claim capture of remote Mac apps/services or transferable managed authentication.

## Retained qualifications

CodeRabbit review on the validated runtime source was skipped for confirmed spending cap: the primary PR disclosed merged unreviewed. Anthropic credential health retained an exhausted-credit warning. Quarantined treasury credential skips do not establish genuine full-run stability. Historical PR1699 abandonment remains omitted without retry: current execution/financial state UNVERIFIED and $43.96sandbox liability receives no release/refund credit. The native benchmark aggregate renderer still reports an incomplete/queued release projection; direct lifecycle/provider receipts are the release evidence. The RECOVERED_KEY carry diagnostic had no qualifying failed required gate attributable to it and remains informational; no duplicate repair goal was dispatched.

## Native readiness

The committed deletion manifest binds archived records, verified recoverable material and explicitly reproducible build outputs. The native `deletion-readiness.json` is written by `scripts/deploy deletion-check`, not hand-authored. Rerun that command against this manifest after merging the records PR and require its terminal READY result; the checker deliberately keeps its committed receipt stable across that final verification. The linked records PR and final scorecard identify its actual merge SHA. No branch or devbox is deleted by these records.
