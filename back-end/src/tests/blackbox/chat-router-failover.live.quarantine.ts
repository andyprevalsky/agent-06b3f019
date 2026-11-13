/**
 * Quarantine for the live chat-router-failover blackbox case (FLAKY 6a3ec2af, PR #1972 deploy):
 * the live re-plan goal omitted the goal anchor once (goalAnchorFailure) and passed on rerun.
 * NOT_INTRODUCED; the repair is handed off after merge.
 *
 *   live case --pass--> PASS row
 *             --fail--> QUARANTINED_FAIL row (non-blocking, reported)
 */
import { quarantine } from '../helpers/quarantine';

export const liveFailoverCase = (run: () => Promise<void>, unit = 'chat-router-failover') =>
  quarantine(
    {
      since: '2026-11-13',
      repair: 'pending-handoff:6a3ec2af295d4367864df3f052dc4985',
      error: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
      evidence:
        'PR #1972 deploy f93b9ad17f live-probes: goalAnchorFailure at chat-router-failover.live.support.ts:373 on attempt 1, rerun PASS; NOT_INTRODUCED (portrait-only diff)',
    },
    run,
    { unit }
  );
