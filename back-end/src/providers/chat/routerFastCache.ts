import { cacheGet } from '../fastCacheStore';
import { contentKey } from '../fastCacheNormalizeKeys';
import { isOaiDemoGoal } from '../fastCacheNormalizeOaiDemo';
import { isValidRouterCacheJson, parseRouterDecisionJson } from './routerDecision';

type CacheEntry = { hit: boolean; value: unknown };

export interface RouterFastCacheResult {
  hit: boolean;
  json?: string;
  key?: string;
  invalid?: boolean;
}

/**
 * The July mass-agent demo is a read-only replay. A router temperature change
 * changes its content key even when every prompt byte is the same. Reuse only
 * that exact prior-temperature decision, and never bill a live router on a miss.
 */
export async function readRouterFastCache(params: {
  goal: string;
  request: Record<string, unknown>;
  get?: (key: string) => Promise<CacheEntry>;
}): Promise<RouterFastCacheResult> {
  const key = contentKey(params.goal, 'chat_router', params.request);
  const get = params.get ?? cacheGet;
  const hit = await get(key);
  const json = hit.hit ? (hit.value as { json?: unknown } | null)?.json : undefined;
  if (isValidRouterCacheJson(json)) return { hit: true, json, key };
  const invalid = typeof json === 'string' && json.length > 0;
  if (!isOaiDemoGoal(params.goal)) return { hit: false, key, invalid };

  // The legacy key differs only in router temperature. All other request
  // fields, including the system prompt, user text, schema and provider route,
  // still participate in the hash; broader position fallback is unsafe here.
  if (params.request.temperature === 0) {
    const legacyKey = contentKey(params.goal, 'chat_router', {
      ...params.request,
      temperature: 0.3,
    });
    const legacy = await get(legacyKey);
    const legacyJson = legacy.hit ? (legacy.value as { json?: unknown } | null)?.json : undefined;
    if (
      isValidRouterCacheJson(legacyJson) &&
      parseRouterDecisionJson(legacyJson).action === 'start_superintelligence'
    ) {
      return { hit: true, json: legacyJson, key: legacyKey };
    }
  }
  throw new Error(`Fast Mode demo router cache miss for ${key}; live routing is disabled`);
}
