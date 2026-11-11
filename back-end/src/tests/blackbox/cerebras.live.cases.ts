/**
 * Live Cerebras /models catalog read for the cerebras blackbox domain.
 *
 *   fetch /models ──ok──> ids (the caller's inventory assertions stay blocking)
 *                 └─not ok─> QUARANTINED_FAIL row, null (the caller reports the skipped inventory)
 */
import assert from 'node:assert/strict';

import { quarantine } from '../helpers/quarantine';

export async function fetchLiveCerebrasModelIds(
  url: string,
  key: string
): Promise<Set<string> | null> {
  let ids: Set<string> | null = null;
  // Quarantined (FLAKY ef18929c: the gate VM read a non-OK live /models response, rerun passed).
  const reachabilityDomain = 'cerebras';
  await quarantine(
    {
      since: '2026-11-11',
      repair: 'https://boxes.dev/thread/thr_c74a9268e4b94114a727adf1dded8ed5',
      error:
        'AssertionError [ERR_ASSERTION]: Cerebras /models must be reachable for the live probe',
      evidence: '.context/rca-cerebras/ef18929c/findings.json',
    },
    async () => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      assert.equal(response.ok, true, 'Cerebras /models must be reachable for the live probe');
      const catalog = (await response.json()) as { data?: Array<{ id?: string }> };
      ids = new Set(
        (catalog.data ?? []).map((row) => row.id).filter((id): id is string => Boolean(id))
      );
    },
    { unit: `${reachabilityDomain}::models-reachable` }
  )();
  return ids;
}
