import { getQueryParams } from './url';

interface CapturedBenchmarkShare {
  agentId: string;
  token: string;
}

const SHARE_HISTORY_KEY = '__roseBenchmarkShare';

/** Strip the bearer query before analytics starts, retaining it for this history entry. */
export function captureBenchmarkShareToken(): void {
  const params = getQueryParams();
  const agentId = params.get('agent-id');
  const token = params.get('benchmark-share');
  if (!agentId || !token) return;

  const capturedShare: CapturedBenchmarkShare = { agentId, token };
  const url = new URL(window.location.href);
  url.searchParams.delete('benchmark-share');
  const priorState: unknown = window.history.state;
  const state =
    priorState && typeof priorState === 'object' && !Array.isArray(priorState)
      ? (priorState as Record<string, unknown>)
      : {};
  window.history.replaceState(
    { ...state, [SHARE_HISTORY_KEY]: capturedShare },
    '',
    `${url.pathname}${url.search}${url.hash}`,
  );
}

/** Bearer capability carried by a shared, read-only benchmark URL. */
export function benchmarkShareToken(): string | null {
  const params = getQueryParams();
  const agentId = params.get('agent-id');
  if (!agentId) return null;
  const queryToken = params.get('benchmark-share');
  if (queryToken) return queryToken;
  const state: unknown = window.history.state;
  const entry =
    state && typeof state === 'object'
      ? (state as Record<string, unknown>)[SHARE_HISTORY_KEY]
      : null;
  if (!entry || typeof entry !== 'object') return null;
  const share = entry as Partial<CapturedBenchmarkShare>;
  return share.agentId === agentId && typeof share.token === 'string' ? share.token : null;
}

export function isBenchmarkSharedView(): boolean {
  return Boolean(benchmarkShareToken());
}
