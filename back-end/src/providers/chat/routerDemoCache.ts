/**
 * Router DEMO cache read.
 *
 *   exact content key ── valid hit ──────────────────────────────> CACHE
 *          │
 *          └─ miss / invalid ─┬─ opening turn + recorded decision ─> CACHE (drift replay)
 *                             └─ otherwise ────────────────────────> MISS → live router
 *
 * The content key hashes the router system prompt and response schema, so any
 * edit to either re-keys every recorded decision. The drift lookup is started
 * alongside the exact read so a miss costs one round trip, not two.
 */

import { cacheGet, cacheGetPosition } from '../demoCacheStore';
import { goalHash } from '../demoCacheNormalizeCore';
import { createLogger } from '../logger';
import type { CacheLookupResult } from './delayedCacheStreamHedge';
import { isValidRouterCacheJson } from './routerDecision';

const log = createLogger('RouterLLM');

export interface RouterDemoCacheDeps {
  cacheGet: typeof cacheGet;
  cacheGetPosition: typeof cacheGetPosition;
}

const defaultDeps: RouterDemoCacheDeps = { cacheGet, cacheGetPosition };

export function isOpeningRouterTurn(messages: ReadonlyArray<{ role: string }>): boolean {
  const conversation = messages.filter((message) => message.role !== 'system');
  return conversation.length === 1 && conversation[0].role === 'user';
}

function recordedJson(value: unknown): unknown {
  return (value as { json?: unknown } | null)?.json;
}

/**
 * `driftGoal` must be null unless this is the conversation's opening turn: the
 * position lookup ignores the request fingerprint and returns the goal's oldest
 * router row, which is the opening decision every conversation for that goal
 * starts with. Follow-up turns would replay another conversation state.
 */
export async function readRouterDemoCache(
  params: { agentId: string; cacheKey: string; driftGoal: string | null },
  deps: RouterDemoCacheDeps = defaultDeps
): Promise<CacheLookupResult<string>> {
  const { agentId, cacheKey } = params;
  const drift =
    params.driftGoal === null
      ? Promise.resolve(null)
      : deps.cacheGetPosition({ goalHash: goalHash(params.driftGoal), callSite: 'chat_router' });
  void drift.catch(() => undefined);

  const hit = await deps.cacheGet(cacheKey);
  const json = hit.hit ? recordedJson(hit.value) : undefined;
  if (typeof json === 'string' && json.length > 0) {
    if (isValidRouterCacheJson(json)) {
      log.info('demo_cache.chat_router_hit', { agentId, key: cacheKey });
      return { hit: true, value: json };
    }
    log.warn('demo_cache.chat_router_invalid', { agentId, key: cacheKey });
  }

  const recorded = await drift;
  if (recorded !== null && recorded.hit && recorded.key !== null) {
    const replay = recordedJson(recorded.value);
    if (isValidRouterCacheJson(replay)) {
      log.info('demo_cache.chat_router_drift_hit', {
        agentId,
        key: cacheKey,
        replayKey: recorded.key,
      });
      return { hit: true, value: replay };
    }
  }
  log.info('demo_cache.chat_router_miss', { agentId, key: cacheKey });
  return { hit: false };
}
