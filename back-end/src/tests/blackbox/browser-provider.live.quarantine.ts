/**
 * Quarantine for the live Kernel/Steel provider parity step of the browser-provider blackbox
 * domain (FLAKY e4fe5524, PR #2245 deploy): /rotate-proxy returned 500 once because the Kernel
 * proxy's page.goto to api.ipify.org timed out at 30 s, and the rerun passed. NOT_INTRODUCED
 * (that diff touches no back-end file); the repair is handed off after merge.
 *
 *   live parity --pass--> QUARANTINED_PASS row
 *               --fail--> QUARANTINED_FAIL row (non-blocking, reported with its detail)
 */
import { quarantine } from '../helpers/quarantine';
import { runSteelAwareParity } from './browser-provider.steel-persistence-outage.support';

/** Runs the live parity step under its marker; resolves whether Steel persistence was skipped. */
export async function quarantinedLiveParity(run: () => Promise<void>, unit = 'browser-provider') {
  let skipped = false;
  await quarantine(
    {
      since: '2026-11-15',
      repair: 'pending-handoff:e4fe55241c3b4907b91a4c0a90f6226a',
      error:
        'FAIL live Kernel provider parity: /rotate-proxy 500: {"error":"page.goto: Timeout 30000ms exceeded.',
      evidence:
        'PR #2245 deploy b8f8a2945a live-probes attempt 1: Kernel /rotate-proxy page.goto api.ipify.org timeout (test-runs/1794778753-7097-1459/browser-provider.log:1054), rerun PASS; NOT_INTRODUCED (agents-only diff)',
    },
    async () => {
      const parity = await runSteelAwareParity(run, true);
      skipped = parity.skipped;
      if (parity.failed) throw new Error(`live provider parity failed ${parity.failed} case(s)`);
    },
    { unit }
  )();
  return skipped;
}
