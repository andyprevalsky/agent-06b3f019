import { quarantine } from '../helpers/quarantine';
import { runLiveTilionProviderParity } from './browser-provider.tilion-live.support';

const tilionParity = {
  name: 'browser-provider',
  run: quarantine(
    {
      since: '2026-11-16',
      repair: 'pending-handoff:2666eabf9f154d02964e00114eac39ad',
      error:
        'FAIL live Tilion provider parity: /resume 500: {"error":"page.goto: net::ERR_CONNECTION_CLOSED at https://example.com/',
      evidence:
        'PR #2312 live-probes on 185e099d8c: browser-provider FLAKY 2666eabf9f154d02964e00114eac39ad (rerun passed); .context/deploy-pipeline attempt 2 live-probes remote-artifact browser-provider.log',
    },
    runLiveTilionProviderParity,
    { unit: 'browser-provider' }
  ),
};

/**
 * Quarantined live Tilion provider parity case of the browser-provider domain. FLAKY occurrence
 * 2666eabf9f154d02964e00114eac39ad (PR #2312, NOT_INTRODUCED: a test-only diff): the Tilion
 * session's /resume navigation to example.com failed with net::ERR_CONNECTION_CLOSED and the
 * rerun passed. The case still runs and reports; the post-merge repair owns the Tilion egress
 * failure, and the marker is released after five consecutive passes. It lives in its own file
 * because the deploy attribution requires every matching marker in a file to name the same
 * repair owner.
 */
export const runQuarantinedLiveTilionProviderParity = tilionParity.run;
