# Application and closeout validation

Application source: c96a48ac5832b9e14bb126caa5b6185de3b77a31.
Application merge: 6c56e81201867ab155d370b6e49c8bf733aed95d.
The records-only follow-up preserves these historical results; it does not run
another application deployment.

| Step                              | Native status                 | Evidence and limit                                                                                                                                                     |
| --------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original production failure       | ERROR / exit1 / passedfalse   | Native hash6406e12a… preserved; holdfalse/transfertrue; never rerun                                                                                                    |
| Admission/API/producer regression | Before FAIL, after PASS       | Same-byte native blackboxes; all-live and generic/sandbox controls; five consecutive passes                                                                            |
| Browser storage stop              | Before2PASS/1FAIL, after3PASS | Same-byte native suite; connected Chromium persistence/redelivery control also passes; single-cancel control fails20s                                                  |
| Inspection fixture isolation      | Before FAIL, after7PASS       | Same seven assertion bodies and seeded local shared cooldown                                                                                                           |
| Selected source gates             | READY round33                 | All16 selected gates satisfied, including complete identical FULL proof reuse; no pending post-merge packets                                                           |
| Backend full gate                 | 251PASS                       | Treasury original FAIL warning and exact Tilion DNS exception excluded, never PASS                                                                                     |
| Final smoke                       | 13PASS                        | All13 resource teardowns verified, controllers absent; separate infra canary2PASS; two protected cases custody-only                                                    |
| Production Render                 | PASS                          | Exact application merge live                                                                                                                                           |
| Production backend probes         | PASS                          | 15/15 checks healthy; error-pattern log matches0                                                                                                                       |
| Production Fly                    | PASS                          | Exact merge, run42492892021 attempt1, durable jobSUCCEEDED and monitor--verify0                                                                                        |
| Production workflow migration     | PASS                          | Every native matrix row passes on the same deployment token                                                                                                            |
| Production semantics              | PASS                          | Run42493989106 attempt1, exact source/head merge, all five jobs successful                                                                                             |
| Production AgentCard              | SKIPPED-elected               | Explicit user no-rerun/no-mint instruction; original ERROR and three financial duties unchanged                                                                        |
| Application CodeRabbit            | SKIPPED usage-cap             | Exact final HEAD; neutral check and commit-naming comment retained; merged unreviewed                                                                                  |
| Private refs and causal evidence  | Verified                      | Encrypted full readback and independent empty restore                                                                                                                  |
| Private workspace archive         | Recovered and verified        | Initial single-stream readback FAILED; unchanged complete object range-read, all199GCM frames authenticated, unchanged verifier and independent39897-file restore pass |
| Terminal delta                    | Verified                      | Full readback, independent48-file empty restore; original18-member packet hash16593a77… retained                                                                       |
| Financial recovery                | UNVERIFIED                    | None claimed for any of the three original allocations                                                                                                                 |

The admission defect was NOT_INTRODUCED by PR1770 against its first parent.
Why user107 became test-mode remains OPEN. Existing assertions, task definitions,
timeouts, concurrency, coverage thresholds and protected instructions were not
relaxed to obtain these results.

The checked-in recovery helper independently restored the48-file terminal delta
through its range-download transport and unchanged native crypto/file validators.
The first closeout review attempt was path-filtered; the requested full review
was temporarily rate-limited. Neither result is a substantive review or a quota
exception. The exact closeout directory is explicitly included for its next
review. The generated deletion-readiness record is committed with this packet.
