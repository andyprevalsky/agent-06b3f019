# PR1831 deployment and custody record

Application PR [1831](https://github.com/Rose-Ai-Labs/rose/pull/1831) merged as
`6c56e81201867ab155d370b6e49c8bf733aed95d`. The native staged cycle validated
`c96a48ac5832b9e14bb126caa5b6185de3b77a31`, reached READY at round33, and recorded
zero pending post-merge packets. Production Render, Fly, endpoint probes,
workflow migration and semantics passed on that exact merge. AgentCard production
verification was explicitly `SKIPPED-elected`; the forbidden original task was
never dispatched.

The fix exposes authoritative Stripe mode through credits usage, requires literal
true before production root creation, and refuses an invalid persisted purchase
mode before Stripe or card work. Fresh rejected approvals permit a valid public
retry; existing financial states retain their custody. Deployment stabilization
also quiesces an owned browser storage writer and isolates a shared-cooldown test
fixture. These records do not change service behavior or deploy another release.

## Verification

The three permanent admission/API/producer blackboxes have unchanged-byte local
fail/pass proofs, all-live controls and five consecutive passes. Missing and
malformed mode fail closed, while generic and sandbox tasks remain admissible.
The full backend gate recorded251 passes with two recorded exclusions. Agents,
frontend, controller, structural and semantic gates passed. Final smoke recorded
13 native passes and13 verified resource teardowns; its separate2-task infra
canary passed and released. Two protected sandbox cases remained source-bound
NO_RETRY_CUSTODY entries rather than passes.

The browser regression failed before the repair and passed afterward. Additional
connected Chromium coverage verifies cancellation redelivery and actual cookie
and localStorage persistence at provider transport retirement. The precise inner
race of the original failed guest is not captured. Existing assertions, deadlines,
concurrency and coverage thresholds remain intact.

CodeRabbit's exact final application HEAD was usage-capped, so the application
PR merged unreviewed under the standing policy. Treasury's original native FAIL
remains a warning under its standing policy; the exact hosted Tilion DNS failure
retains its external-provider qualification. Neither exception applies to the
original mixed-mode payment ERROR.

## Preserved unresolved duties

The original production run remains ERROR/native exit1/passedfalse, with native
SHA256 `6406e12ac2cb0454d12354d5b123e3a917dfe5fb081f9a6fae4ef79daddf3019`.
Its explicit test Stripe hold and live AgentCard transfer are preserved. The
NOT_INTRODUCED attribution for PR1770 against its first parent is unchanged.
Why user107 became test-mode remains OPEN: no Subscription/provisioning audit
identifies the writer.

All three original financial duties remain current UNVERIFIED: the100c mixed-mode
production allocation and both4396c historical sandbox allocations. Canonical
identities and original snapshots are private. Agent deletion, test success,
resource teardown and these records establish no refund or financial recovery.
No rerun, mint or reissue of those allocations is authorized by this record.
Any separately authorized remediation requires canonical recovery and identity
proof and remains separate from test execution and source repair.

## Private preservation and recovery

[The preservation index](preservation-index.json) binds the actual encrypted
objects, verified receipts, original member counts and independent empty restores.
The inherited Git bundle preserves exact local-only branch/stash tips; intended
application source is also merged and published. No branch or protected
instruction was deleted. Freedom and its protected instructions were unchanged.

The large workspace object's first native single-stream readback failed with
`Truncated archive`. Its complete unchanged object was retrieved with managed
range reads. Every frame authenticated; unchanged native crypto/tar/file checks
matched the original snapshot filelist before an explicitly recovered receipt was
issued. A separate empty restore verified every member. The initial failure is
retained; its precise undersized-HTTP-read cause remains OPEN. This is a recovered
observation, not an original uploader receipt or financial proof.

Use [the recovery procedure](RECOVERY.md). Private snapshots are forensic data;
never overlay their source/cycle/environment/owner registries or historical
PASS/READY claims into a live workspace. The parent1869-file custody package and
96-file V2 closure were independently restored before dispatch and admitted as
immutable evidence only. The parent's final core receipt and independent restore
proof are retained; this box did not restore the entire12GB core.
