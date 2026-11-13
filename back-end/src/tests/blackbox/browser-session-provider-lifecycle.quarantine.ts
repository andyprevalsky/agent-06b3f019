import { quarantine } from '../helpers/quarantine';
import { runBrowserProviderLifecycleCases } from './browser-session-provider-lifecycle.cases';

const providerLifecycle = {
  name: 'browser-session',
  run: quarantine(
    {
      since: '2026-11-11',
      repair: 'https://boxes.dev/thread/thr_b1845257eacc4d5f971d93f96e7faf64',
      error:
        'Error: worker failed before ready: PrismaClientInitializationError: Too many database connections opened: FATAL: sorry, too many clients already',
      evidence:
        'PR #1928 backend-coverage-blackbox final round 7 on cfa06656 (blackbox:browser-session FLAKY, rerun passed 35/35)',
    },
    runBrowserProviderLifecycleCases,
    { unit: 'browser-session' }
  ),
};

/**
 * Quarantined provider-lifecycle section of the browser-session domain. FLAKY occurrence
 * 2d9047dbcd51485cbefa5d3d6dae614a (PR #1928, NOT_INTRODUCED): a lifecycle fixture worker failed
 * before ready when the coverage Postgres refused connections; the domain passed its rerun. The
 * section still runs and reports; its post-merge repair owns the connection budget, and the marker
 * is released after five consecutive passes.
 */
export const runQuarantinedProviderLifecycleCases = providerLifecycle.run;
