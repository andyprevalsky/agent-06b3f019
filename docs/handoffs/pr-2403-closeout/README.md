# PR #2403 closeout

The outbound-call language repair shipped in [PR #2403](https://github.com/Rose-Ai-Labs/rose/pull/2403), merge `770611c7c2e3ad3e066c2ee703e87c28f0e50d4f`. Render, endpoint probes and production semantics passed. The reviewed source is `0e65e3c0747c71c6dc742994285771eda1462f45`; no stabilization source or benchmark-history rows changed afterward, so its clean exact-head review remained applicable.

The same RCA case includes the later agent `9ad789f4-a710-4f48-9da5-0619992e3b65` incident after provider-object matching and ownership reconciliation. No duplicate fix or deployment was made. Controlled audio proves Spanish opening/continuation/goodbye and an English control; the second incident's question was spoken in Spanish. Real recipient responses, completed reservation/identity checks, native Castilian accent, arbitrary voice quality and deterministic future script fidelity remain unverified.

## Validation

| Step | Result | Evidence |
| --- | --- | --- |
| Owning reproduction | Before exit 1; five post-fix exit 0 runs | `bash back-end/scripts/run-blackbox-tests.sh vapi`; greeting assertion unchanged, negative controls added after original failure |
| Focused static/structural | PASS | TypeScript, ESLint, outbound structural 10/10, archive validator |
| Stability | PASS | Five unchanged local runs and Blacksmith stability gate; independent flakiness review |
| Deploy gates | Satisfied, not every test passed | 16 gates pass; backend coverage retains 285 passing checks and one evidenced NOT_INTRODUCED failed domain |
| Fleet smoke | PASS | Seven primary tasks and two prerequisite canaries; terminal publication, supervisor quiescence and native cleanup verified |
| Review/approvals | Clean exact-head CodeRabbit review; no approval-gated hunks | Three native guards clear; no user override or external-provider waiver |
| Production | PASS | `production-proof.json`, exact merge, 16/16 endpoint probes and clean log scan |
| Post-merge repair | Delivered | `repair-handoff.json`; independent Bugs devbox, high effort/standard speed, no parent dependency |
| Preservation | Verified | Four encrypted carriers; native full readback, separate verification, restore and exact source guards |
| Deletion readiness | Native checker owns verdict | `deletion-readiness.json`; generated after the manifest is committed, then merged in this records PR |

Tests skipped (quarantined): 8 — 0 failed (non-blocking), 8 passed. Existing quarantine markers and the indefinitely quarantined mass-agent task were not changed by this phone repair.

The schema-generation failure remains an original FAIL, not a fabricated pass: selected `population` does not match declared `tokyo_population`; exact captured transport replays fail on both base and changed source. The independent repair owns that existing test through its own deployment.

## Preservation and recovery

`deletion-manifest.json` binds 72 inherited local-only branch tips and one stash to verified private Git custody and maps needed ignored paths to the composite private archive. `PRESERVATION.md`, `RECOVERY.md`, receipts and source guards describe exact coverage. Raw prompts, logs, recordings, environment values and private filenames stay encrypted. Configuration is preserved from complete local files; rotating controller credentials refresh through managed setup. Source branches, stash, Freedom and protected instructions were not removed or weakened.

All seven controlled voice replays ended; the overlapping incident's independent replay also ended. Native fleet teardown verified nine machines destroyed. Nine detached volumes remained `pending_destroy` in the last provider audit: provider-side asynchronous removal and final storage charges remain unverified, and no DELETE was resent. Exact retained IDs are in `provider-retention.json`.

Use the same activated shell environment for native gate and merge commands (`source agents/venv/bin/activate`). An initial unactivated merge invocation correctly failed environment identity; activation restored the tested environment and verification passed without bypass.

Project-wide thread evidence covered active Bugs and other Bug Report work. Folder-specific read visibility on an ordinary devbox is an existing boxes.dev limitation already reported by another agent; it did not authorize guessing ownership from titles.
