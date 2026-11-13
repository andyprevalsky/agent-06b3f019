/**
 * Live chat-router-failover blackbox case. It was quarantined after FLAKY 6a3ec2af (PR #1972
 * deploy: the live re-plan goal omitted the goal anchor once and passed on rerun, NOT_INTRODUCED).
 * The marker was released on 2026-11-13 (PR #2014) after five consecutive passes; the case blocks again.
 *
 *   live case --pass--> PASS row
 *             --fail--> FAIL row (blocking)
 */
export const liveFailoverCase = (run: () => Promise<void>) => run;
