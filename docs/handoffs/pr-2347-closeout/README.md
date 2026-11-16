# PR #2347 closeout

PR #2347 repairs false loss of connected iPhone capability after FIFO lease promotion. Admission now commits the successor lease and its borrower custody together; standalone capability discovery reads the device and lease from a consistent read-only snapshot. Generation and queued-command rejection remain enforced.

The original RCA read actual active bug work before editing. Upstream capped-child lease cleanup remains owned by PR #2349; verifier history truncation and user handback are separate. No live phone actions were performed and the original DoorDash sign-in is not claimed complete.

The phone symptom was reproduced using real local HTTP handlers and PostgreSQL. Unchanged command `bash /tmp/phone-fifo-registered.sh` exited 1 before the writer repair and 0 after it. The sibling concurrent-reader reproduction `bash /tmp/phone-fifo-blocking.sh` exited 1 with the writer-only change and 0 after the snapshot repair. Five final unchanged repetitions passed. The dedicated non-quarantined regression is in the normal backend coverage lane and passed in the final full gate.

Original repair PR: https://github.com/Rose-Ai-Labs/rose/pull/2347
Merge: 26a6deac6accc2f7b82420926ff0d4e739b5153c
Final tested source: c470ba27145ce59f3574532e79efadb653d179c1

All 17 selected gates passed. Seven final cloud smoke tasks passed, with native exit 0, complete/cleanup complete and full release proof. Ten existing quarantined units ran and passed; their exact marker retirements remain with existing repair owners. The new iPhone regression has no quarantine. The initial main sleep-ratchet failure was retained, repaired in merged PR #2342, and the entire structural registry passed on the integrated source. No gate or assertion was weakened.

CodeRabbit reached its organization spending cap. The native review ledger records the quota skip and verified sync inheritance. This release merged unreviewed by CodeRabbit; two independent read-only reviews found no blocking issue.

Production: PASS. Render and semantic lanes verified by strict descendants containing the merge; all 16 backend probes passed with a clean Render log scan.

The first Render verification expired after 905 seconds while auto-deploys repeatedly superseded each other. A later native attempt verified a live strict descendant containing the merge and passed all 16 backend probes with no error log lines. Its semantic dispatch was rejected before execution by GitHub primary-user REST quota exhaustion (403, core 0/5000). Both native failures remain preserved. No run or pass was invented.

Private preservation uses existing authenticated encrypted archives, with exact original-path/hash catalogs. Raw trajectories, logs, decrypted setup snapshots and credentials are never committed here. See the sanitized archive summaries, exact private recovery receipts and recovery instructions. Restore each object separately into a new empty private directory; choose required versions by catalog origin and hash rather than overwriting older versions automatically.

Final evidence capture is complete: 5,404 final archive members were independently restored and hashed, with all 36,233 original source postchecks unchanged. The late proof supplement has 32 restored members, also hash-verified. Deletion readiness requires the supported checker and durable publication of these records; its canonical generated receipt is deletion-readiness.json. Nothing in this handoff authorizes deletion of branches, protected Freedom configuration or the devbox.

A reviewed operational transport sent one official same-primary REST POST with the native workflow inputs after the CLI metadata GET failed. GitHub accepted HTTP200 with run43836518429, and the unchanged native runner discovered that exact dispatch ID. Both request/response and the content-bound transport review remain private archive evidence. No pool identity performed a write, no test/timeout changed, and no receipt was manually marked passed. Different GET/POST quota observations are retained without claiming their cause. That workflow43836518429 passed all five jobs. While closing the native aggregate, the parent incorrectly expected completed-result reuse and started one unnecessary second full semantic run43837969497. That run also passed all five jobs. Both runs and the extra elapsed time remain recorded; neither failure history nor task coverage was reset.

The native production aggregate passed and native deploy finish completed on the original 20261116-062645-660536 clock. All encrypted preservation and independent restore checks are complete. Native deletion-readiness verification and durable publication/merge of these records are the final closeout conditions.

A clock discontinuity interrupted coordination between November16 09:34 and 21:32 UTC. Its cause was not established and the interval is reported as waiting with reason unrecorded. It does not extend any recorded active verification interval or change the immutable production results. The preservation worker stopped only its exact owned redundant slow verifier after an explicit task amendment. Its shell exited143 and the two original processes are absent. This duplicate is recorded CANCELLED; the completed optimized verification remains PASS. Updated handoff/cancellation metadata is committed separately from the earlier private late-proof snapshot.
