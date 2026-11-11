/**
 * Live Cerebras /models catalog read for the cerebras blackbox domain.
 *
 *   GET /models ──ok──────────────────────────> ids (caller's inventory assertions stay blocking)
 *       │
 *       ├─408/429/5xx (transient provider)──> backoff 1/2/4/8 s ──> GET /models
 *       │                                      (bounded: 5 attempts, as the sibling chat probe)
 *       └─other non-OK, or still transient after the last attempt
 *              ──> AssertionError "Cerebras /models must be reachable for the live probe: HTTP <status> cf-ray=<id> <body>"
 *
 * One transient non-OK /models response from a shared deploy-gate VM used to
 * fail the whole domain (RCA ef18929c); a persistent outage still fails it.
 */
import assert from 'node:assert/strict';

import { retryWithBackoff } from '../../providers/retry';

const MODELS_MAX_ATTEMPTS = 5;

interface ModelsRead {
  ok: boolean;
  status: number;
  cfRay: string | null;
  text: string;
}

function isTransientModelsStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function fetchLiveCerebrasModelIds(url: string, key: string): Promise<Set<string>> {
  const read = await retryWithBackoff<ModelsRead>(
    async () => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      return {
        ok: response.ok,
        status: response.status,
        cfRay: response.headers.get('cf-ray'),
        text: await response.text(),
      };
    },
    {
      maxRetries: MODELS_MAX_ATTEMPTS,
      initialBackoffMs: 1_000,
      shouldRetryResult: (result) => !result.ok && isTransientModelsStatus(result.status),
      component: 'cerebras-models-probe',
    }
  );
  assert.equal(
    read.ok,
    true,
    `Cerebras /models must be reachable for the live probe: HTTP ${read.status} cf-ray=${read.cfRay ?? '-'} ${read.text.slice(0, 200)}`
  );
  const catalog = JSON.parse(read.text) as { data?: Array<{ id?: string }> };
  return new Set(
    (catalog.data ?? []).map((row) => row.id).filter((id): id is string => Boolean(id))
  );
}
