# PR2411 delivery and preservation record

PR [#2411](https://github.com/Rose-Ai-Labs/rose/pull/2411) delivered coding
conversation breadcrumbs and provider-correct fresh Codex allocation, plus
the independently diagnosed import-boundary, catalog metadata and launch
custody repairs. Product merge: `562cc8c49008708918d15ee9844ab1c8c333062c`.

All17 selected native product gates passed at exact source
`4a9d224abd5bf5ab1770237f2a8097762938a876`, digest
`882008a4bc15beb817e758c96fd6fcabb8c9fddfcfd52454d9877be30fab17c0`.
The real fresh Codex E2B task and restricted-command native handoff passed in
that backend gate. CodeRabbit review was **SKIPPED for the organization usage
cap**, not PASS; the product merged without a substantive CodeRabbit review.
Independent repair reviews are separate evidence.

Production verification completed2026-11-16T20:48:30Z; native finish exited0
at20:49:05Z. Render and Vercel verified exact product562cc8; backend probes
passed; Mac run43946926015 released v1.1.355. Semantic run
[43951508861](https://github.com/Rose-Ai-Labs/rose/actions/runs/43951508861)
passed all five jobs with **PASS-verified-by-descendant**: target562cc8,
effective live frontend/tested specification source
`1ec28940191764ecf435ffc38b345006269bc95b`, workflow execution head
`6e2496487add55f3416737566873573528474fd3`. This is not an exact562cc8
semantic PASS. Fly, WMH, workflow migration and AgentCard were
SKIPPED-not-applicable, not executed passes.

The first semantic dispatch at20:22:58Z failed HTTP401 before creating a run.
Its failed receipt and no-run identity remain alongside successful retry
evidence. The distinct operational credential-precedence repair was delivered
as6e249 via `/push`, with91 owning tests and five unchanged focused R1 passes.
Initial review found inherited-token redaction incomplete; its one-line
follow-up and integration regression received independent PASS on final bytes.
This operational validation does not replace product4a9's full17-gate proof.

## Incident boundaries retained

The six [RCA cases](../../rca/cases/) retain each original failure and exact
red/green evidence. Fixed status applies to each repaired source boundary.
The dd14af83 occurrence joins the existing Codex image case: session created
20:09:39, ENOENT/-2 at20:10:05 and20:11:42, before backend562cc8 became live
at20:16:55. Both incidents have exact Claude-snapshot lineage and zero turns.
Both original paused sessions remain preserved and **NOT recovered**. The fix
applies to fresh allocation; default resolution can reuse a paused session.
A fresh-allocation check must use a truly fresh owner/session.

Catalog/strict-reader and launch-custody fixes do not fix webdecoy runtime
COST or timeout failures. Their owners remain OPEN:
`ph7dks458a5md98rqzhab8wafn8jaypb` and `ph77fvbp3fna54x71mn0523e2d8jaxc1`.
The counter audit remains OPEN/evidence-only; disproved raw-streak release
readiness authorizes no marker removal. A mistaken independent repair
assignment was revoked and its goal paused cleanly without source edits,
tests, provider operations or deployment. That is neither a repair nor waiver.
Original failed/unverified outcomes remain; launch-custody reconciliation
provides no test-execution or financial-cleanup credit.

## Native history

The existing writer appended seven joined native attempts exactly once and
two uncached durations exactly once. Five cached measurements remain in
attempt history but are excluded from timeout training. Preserve recorded
ACTIVE chat status alongside a passed outcome; do not normalize chat state.
Inputs and source hashes are joined in the history receipt. Generic Hub
backfill added0 because Hub code was null, not proof of complete history.

## Receipt publication and remaining preservation

The parent owns JSON publication. These repository-relative records are
expected publication targets; this README does not assert that an absent
target already exists. Final review must check their presence, hashes and scope
once the parent copies them:

- [Production lanes](production-lanes.json) and [production verification](production-verification.json): final native outcomes, initial failure and source bindings.
- [Source validation](source-validation.json) and [operational CLI repair](operational-cli-repair.json): separate product17 and operations91 evidence and review qualifications.
- [History write receipt](history-write-receipt.json): seven attempts, two durations and exact-once source joins.
- [Private archive receipt](private-archive-receipt.json): earlier verified private archive objects and exact covered bytes.
- [Terminal archive receipt](terminal-archive-receipt.json), [closeout manifest](closeout-manifest.json), and [deletion readiness](deletion-readiness.json): final terminal delta, restore/read-back proofs and native readiness.

Final terminal-delta preservation and readiness remain pending until those
native proofs complete. Earlier private objects do not cover later mutable
files, new history, this records commit or its review. No READY or whole-box
deletion claim is made. Private object keys, ciphertext/manifest hashes and
recovery instructions belong in the receipts. Raw private transcripts,
credentials and public signed URLs do not belong in this record.

## Recovery commands

Use existing authorized archive configuration and the pinned helper. From the
repository root, activate the existing environment and use the published receipt:

```bash
. agents/venv/bin/activate
python3 docs/handoffs/whm-b07d9037-preservation/private_archive.py verify --receipt docs/handoffs/pr-2411-closeout/private-archive-receipt.json
python3 docs/handoffs/whm-b07d9037-preservation/private_archive.py restore --receipt docs/handoffs/pr-2411-closeout/private-archive-receipt.json --destination /tmp/pr2411-private-restore
```

If the receipt is a composite index, pass each helper-compatible member receipt
named in it instead of the index itself. Repeat verify/restore for published
terminal data/control member receipts, using distinct new empty destinations.
Compare restored manifests and hashes. Verify a restored Git bundle with
`git bundle verify` in an isolated recovery repository; preserve archived
ref/stash ordering and never automatically apply it to a live checkout.
Restore metadata and symlinks only on a new recovery tree. These are recovery
instructions, not operations performed during this records application.
