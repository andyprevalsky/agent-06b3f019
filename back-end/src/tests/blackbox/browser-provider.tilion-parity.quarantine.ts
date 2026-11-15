import { quarantine } from '../helpers/quarantine';
import { runLiveTilionProviderParity } from './browser-provider.tilion-live.support';

const tilionParity = {
  name: 'browser-provider',
  run: quarantine(
    {
      since: '2026-11-15',
      repair: 'https://boxes.dev/thread/thr_b5c1359b7cac4edc8341b4a8dd614b17',
      error:
        'FAIL live Tilion provider parity: /init 500: {"error":"AgentPhone agent creation is uncertain; reconciliation failed: AgentPhone reconciliation exceeded the 10000-agent scan bound"}',
      evidence:
        'PR #1990 live-probes round 2 on 2897e06746: browser-provider FLAKY 4418c14313bc4d9d81e98ca09490aa3f (rerun passed); same signature on PR #2023; prod AgentPhone at 50/50 numbers',
    },
    runLiveTilionProviderParity,
    { unit: 'browser-provider' }
  ),
};

/**
 * Quarantined live Tilion provider parity case of the browser-provider domain. FLAKY occurrence
 * 4418c14313bc4d9d81e98ca09490aa3f (PR #1990, NOT_INTRODUCED; same signature on PR #2023): the
 * live-probes gate uses the prod AgentPhone key, the prod account is at its 50 of 50 number cap,
 * and parity /init could not reconcile the uncertain agent within the 10000-agent scan bound. The
 * case still runs and reports; the repair thread owns the number cap and the reconcile scan bound,
 * and the marker is released after five consecutive passes. It lives in its own file because the
 * deploy attribution requires every matching marker in a file to name the same repair owner.
 */
export const runQuarantinedLiveTilionProviderParity = tilionParity.run;
