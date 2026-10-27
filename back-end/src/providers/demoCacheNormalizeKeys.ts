import {
  BROWSER_SELECTOR_PREFIX_RE,
  BROWSER_STEP_CALLSITE_RE,
  CACHE_KEY_VERSION,
  REQUEST_PARTITION_HEADERS,
  worldModelCacheScope,
  type CacheKind,
} from './demoCacheNormalizeConstants';
import { canonicalMessages, goalHash, normalizeUrl, sha256 } from './demoCacheNormalizeCore';

export function buildKey(kind: CacheKind, goal: string, detail: string): string {
  return `fastmode:${CACHE_KEY_VERSION}:${worldModelCacheScope()}${kind}:${goalHash(goal)}:${detail}`;
}

export function buildGlobalKey(kind: CacheKind, detail: string): string {
  return `fastmode:${CACHE_KEY_VERSION}:${worldModelCacheScope()}${kind}:global:${detail}`;
}

export function normalizeCallSite(callSite: string): string {
  if (BROWSER_STEP_CALLSITE_RE.test(callSite)) return 'browser_use_step';
  return callSite;
}

export function llmKey(goal: string, callSite: string, request: unknown): string {
  return contentKey(goal, callSite, request);
}

export function contentKey(goal: string, callSite: string, request: unknown): string {
  return buildKey(
    'llm',
    goal,
    `${normalizeCallSite(callSite)}:c:${sha256(canonicalMessages(request)).slice(0, 32)}`
  );
}

export function browserUseKey(goal: string, request: unknown): string {
  return buildKey(
    'browser_use',
    goal,
    `c:${sha256(canonicalMessages(canonicalBrowserUseRequest(request))).slice(0, 32)}`
  );
}

export function browserHttpKey(
  goal: string,
  method: string,
  url: string,
  headers?: Record<string, unknown>,
  body?: unknown
): string {
  void goal;
  const authParts: Array<[string, string]> = [];
  if (headers !== undefined && headers !== null) {
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (REQUEST_PARTITION_HEADERS.has(lower) && value) {
        authParts.push([lower, String(value)]);
      }
    }
  }
  authParts.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  const authScope =
    authParts.length === 0 ? 'public' : `auth:${sha256(canonicalMessages(authParts)).slice(0, 16)}`;
  const upperMethod = method.toUpperCase();
  void body;
  if (upperMethod === 'GET' || upperMethod === 'HEAD') {
    return buildGlobalKey(
      'browser_http',
      `${upperMethod}:${sha256(normalizeUrl(url)).slice(0, 24)}:${authScope}:no-body`
    );
  }
  return buildKey(
    'browser_http',
    goal,
    `${upperMethod}:${sha256(normalizeUrl(url)).slice(0, 24)}:${authScope}:body:any`
  );
}

export function canonicalBrowserUseRequest(request: unknown): unknown {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return request;
  const record = request as Record<string, unknown>;
  function cleanActionEntry(entry: unknown): unknown {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const actionEntry = entry as Record<string, unknown>;
    const action = actionEntry.action ?? actionEntry.type ?? actionEntry.name;
    const params =
      actionEntry.params !== null &&
      typeof actionEntry.params === 'object' &&
      !Array.isArray(actionEntry.params)
        ? (actionEntry.params as Record<string, unknown>)
        : actionEntry;
    const stableParams: Record<string, unknown> = {};
    for (const key of [
      'url',
      'text',
      'key',
      'time_ms',
      'direction',
      'amount',
      'tab_id',
      'filename',
      'files',
      'option',
      'value',
      'clear',
    ]) {
      if (!(key in params)) continue;
      const value = params[key];
      stableParams[key] = key === 'url' && typeof value === 'string' ? normalizeUrl(value) : value;
    }
    const out: Record<string, unknown> = {};
    if (action) out.action = action;
    if (Object.keys(stableParams).length > 0) out.params = stableParams;
    const description =
      actionEntry.element_description ?? actionEntry.target ?? actionEntry.description;
    if (typeof description === 'string' && description.trim()) {
      out.element = description.trim().replace(/\s+/g, ' ').replace(BROWSER_SELECTOR_PREFIX_RE, '');
    }
    if (actionEntry.status) out.status = actionEntry.status;
    return out;
  }
  const browserState =
    record.browser_state !== null &&
    typeof record.browser_state === 'object' &&
    !Array.isArray(record.browser_state)
      ? (record.browser_state as Record<string, unknown>)
      : {};
  const stableState: Record<string, unknown> = {};
  if (typeof browserState.url === 'string' && browserState.url) {
    stableState.url = normalizeUrl(browserState.url);
  }
  if (browserState.title) stableState.title = browserState.title;
  if (browserState._extra_user_messages) {
    stableState._extra_user_messages = browserState._extra_user_messages;
  }
  return {
    task: record.task,
    dynamic_system_context: record.dynamic_system_context,
    turn_message_count: Array.isArray(record.turn_messages) ? record.turn_messages.length : 0,
    browser_state: stableState,
    action_entries: Array.isArray(record.action_entries)
      ? record.action_entries.map(cleanActionEntry)
      : [],
    config: record.config,
  };
}

export function webSearchKey(goal: string, query: string, maxResults: number): string {
  const norm = query.trim().toLowerCase().replace(/\s+/g, ' ');
  void goal;
  return buildGlobalKey('web_search', `${maxResults}:${sha256(norm).slice(0, 24)}`);
}

export function webFetchKey(goal: string, url: string): string {
  void goal;
  return buildGlobalKey('web_fetch', sha256(normalizeUrl(url)).slice(0, 24));
}

export function fileKey(goal: string, url: string): string {
  return buildKey('file', goal, sha256(normalizeUrl(url)).slice(0, 24));
}

export function anthropicKey(goal: string, request: unknown): string {
  return buildKey('anthropic', goal, `c:${sha256(canonicalMessages(request)).slice(0, 32)}`);
}

/**
 * Code-agent variant: the tee-proxy already knows the goalHash (injected into the
 * ANTHROPIC_BASE_URL path) and hashes the canonical Anthropic request body.
 */
export function anthropicKeyFromHash(goalHashValue: string, request: unknown): string {
  return `fastmode:${CACHE_KEY_VERSION}:${worldModelCacheScope()}anthropic:${goalHashValue}:c:${sha256(canonicalMessages(request)).slice(0, 32)}`;
}

export function codexKeyFromHash(goalHashValue: string, request: unknown): string {
  return `fastmode:${CACHE_KEY_VERSION}:${worldModelCacheScope()}codex:${goalHashValue}:c:${sha256(canonicalMessages(request)).slice(0, 32)}`;
}
