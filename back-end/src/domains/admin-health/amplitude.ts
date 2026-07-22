import { createLogger } from '../../providers/logger';
import { retryWithBackoff } from '../../providers/retry';
import { AMPLITUDE_API_BASE_URL, AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY } from './config';

const log = createLogger('AdminHealth');

export type AmplitudeFunnelStepId =
  | 'landing_page_viewed'
  | 'querybox_clicked'
  | 'content_typed'
  | 'goal_submitted'
  | 'phone_entered'
  | 'otp_code_submitted';

interface FunnelEvent {
  id: AmplitudeFunnelStepId;
  eventType: string;
  filters?: Array<{
    subprop_type: 'event';
    subprop_key: string;
    subprop_op: 'is';
    subprop_value: string[];
  }>;
}

export interface AmplitudeFunnelResult {
  counts: Record<AmplitudeFunnelStepId, number | null>;
  detail: string;
}

const FUNNEL_EVENTS: FunnelEvent[] = [
  {
    id: 'landing_page_viewed',
    eventType: '[Amplitude] Page Viewed',
    filters: [
      {
        subprop_type: 'event',
        subprop_key: '[Amplitude] Page Path',
        subprop_op: 'is',
        subprop_value: ['/'],
      },
    ],
  },
  { id: 'querybox_clicked', eventType: 'querybox_clicked' },
  { id: 'content_typed', eventType: 'goal_typed' },
  { id: 'goal_submitted', eventType: 'goal_submitted' },
  { id: 'phone_entered', eventType: 'phone_entered' },
  { id: 'otp_code_submitted', eventType: 'otp_code_submitted' },
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const FUNNEL_QUERY_COST_PER_DAY = FUNNEL_EVENTS.length * 2;
const MAX_FUNNEL_QUERY_COST_PER_FIVE_MINUTES = 1000;
const AMPLITUDE_CONCURRENCY_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const funnelCache = new Map<string, { expiresAt: number; value: AmplitudeFunnelResult }>();
let knownEventsCache: { expiresAt: number; value: Set<string> } | null = null;
let knownEventsRequest: Promise<Set<string>> | null = null;
let activeRequests = 0;
const requestWaiters: Array<() => void> = [];

class AmplitudeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string
  ) {
    super(`Amplitude ${status}: ${detail}`);
  }
}

function emptyCounts(value: number | null): Record<AmplitudeFunnelStepId, number | null> {
  return Object.fromEntries(FUNNEL_EVENTS.map((event) => [event.id, value])) as Record<
    AmplitudeFunnelStepId,
    number | null
  >;
}

export function unavailableAmplitudeFunnel(detail: string): AmplitudeFunnelResult {
  return { counts: emptyCounts(null), detail };
}

function authHeader(): string {
  return `Basic ${Buffer.from(`${AMPLITUDE_API_KEY}:${AMPLITUDE_SECRET_KEY}`).toString('base64')}`;
}

async function withRequestSlot<T>(request: () => Promise<T>): Promise<T> {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => requestWaiters.push(resolve));
  }
  activeRequests += 1;
  try {
    return await request();
  } finally {
    activeRequests -= 1;
    requestWaiters.shift()?.();
  }
}

async function amplitudeGet<T>(path: string, query?: URLSearchParams): Promise<T> {
  const url = new URL(path, AMPLITUDE_API_BASE_URL);
  if (query !== undefined) url.search = query.toString();
  return withRequestSlot(() =>
    retryWithBackoff(
      async () => {
        const response = await fetch(url, { headers: { Authorization: authHeader() } });
        if (!response.ok) {
          const detail = (await response.text()).slice(0, 500);
          throw new AmplitudeHttpError(response.status, detail);
        }
        return (await response.json()) as T;
      },
      {
        maxRetries: AMPLITUDE_CONCURRENCY_RETRY_DELAYS_MS.length + 1,
        fixedDelays: AMPLITUDE_CONCURRENCY_RETRY_DELAYS_MS,
        isRetryable: isRetryableAmplitudeError,
        component: 'Amplitude',
      }
    )
  );
}

export function isRetryableAmplitudeError(error: unknown): boolean {
  return (
    error instanceof AmplitudeHttpError &&
    error.status === 429 &&
    /exceeded concurrent limit/i.test(error.detail)
  );
}

async function fetchKnownEvents(): Promise<Set<string>> {
  if (knownEventsCache !== null && knownEventsCache.expiresAt > Date.now()) {
    return knownEventsCache.value;
  }
  if (knownEventsRequest !== null) return knownEventsRequest;
  knownEventsRequest = amplitudeGet<{ data?: Array<{ value?: string }> }>(
    '/api/2/events/list'
  ).then((body) => {
    const value = new Set(
      body.data?.flatMap((event) =>
        event.value === undefined || event.value === '' ? [] : [event.value]
      ) ?? []
    );
    knownEventsCache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
    return value;
  });
  try {
    return await knownEventsRequest;
  } finally {
    knownEventsRequest = null;
  }
}

function formatDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');
}

export function amplitudeFunnelQueryCost(start: Date, end: Date): number {
  const dayCount = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / DAY_MS));
  return dayCount * FUNNEL_QUERY_COST_PER_DAY;
}

export function isAmplitudeFunnelQueryWithinBudget(start: Date, end: Date): boolean {
  return amplitudeFunnelQueryCost(start, end) <= MAX_FUNNEL_QUERY_COST_PER_FIVE_MINUTES;
}

function eventQuery(event: FunnelEvent): { event_type: string; filters: FunnelEvent['filters'] } {
  // These are raw event types returned by /events/list. Amplitude's `ce:` prefix is only for
  // dashboard-defined Custom Events (composite definitions), not ordinary instrumented events.
  return { event_type: event.eventType, filters: event.filters ?? [] };
}

async function fetchOrderedFunnel(
  start: Date,
  end: Date
): Promise<AmplitudeFunnelResult['counts']> {
  const query = new URLSearchParams({
    start: formatDate(start),
    end: formatDate(new Date(end.getTime() - 1)),
    mode: 'ordered',
    n: 'active',
    cs: String(24 * 60 * 60),
  });
  for (const event of FUNNEL_EVENTS) query.append('e', JSON.stringify(eventQuery(event)));
  const body = await amplitudeGet<{
    data?: Array<{ cumulativeRaw?: number[] }>;
  }>('/api/2/funnels', query);
  if (body.data?.length === 0) return emptyCounts(0);
  return orderedFunnelCounts(body.data?.[0]?.cumulativeRaw);
}

export function orderedFunnelCounts(
  cumulativeRaw: number[] | undefined
): AmplitudeFunnelResult['counts'] {
  if (cumulativeRaw === undefined || cumulativeRaw.length !== FUNNEL_EVENTS.length) {
    throw new Error('Amplitude funnel response did not include every configured step');
  }
  for (let index = 0; index < cumulativeRaw.length; index += 1) {
    const count = cumulativeRaw[index];
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`Amplitude funnel step ${index} returned an invalid count`);
    }
    if (index > 0 && count > cumulativeRaw[index - 1]) {
      throw new Error('Amplitude ordered funnel counts must be non-increasing');
    }
  }
  return Object.fromEntries(
    FUNNEL_EVENTS.map((event, index) => [event.id, cumulativeRaw[index]])
  ) as AmplitudeFunnelResult['counts'];
}

export async function fetchAmplitudeFunnel(start: Date, end: Date): Promise<AmplitudeFunnelResult> {
  const unavailableDetail = 'Amplitude funnel data is unavailable for this period.';
  if (AMPLITUDE_API_KEY === '' || AMPLITUDE_SECRET_KEY === '') {
    return { counts: emptyCounts(null), detail: 'Amplitude credentials are not configured.' };
  }
  const cacheKey = `${start.toISOString()}:${end.toISOString()}`;
  const cached = funnelCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value;
  try {
    const effectiveEnd = new Date(Math.min(end.getTime(), Date.now()));
    if (!isAmplitudeFunnelQueryWithinBudget(start, effectiveEnd)) {
      return {
        counts: emptyCounts(null),
        detail:
          'Amplitude funnel data is unavailable because this period exceeds the query budget.',
      };
    }
    const knownEvents = await fetchKnownEvents();
    const missingEvents = FUNNEL_EVENTS.filter((event) => !knownEvents.has(event.eventType));
    if (missingEvents.length > 0) {
      return {
        counts: emptyCounts(null),
        detail: `Amplitude is missing required events: ${missingEvents.map((event) => event.eventType).join(', ')}.`,
      };
    }
    const counts = await fetchOrderedFunnel(start, effectiveEnd);
    const value = {
      counts,
      detail: 'Ordered unique users who completed each prior website step within 24 hours.',
    };
    funnelCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch (error) {
    log.error('Amplitude funnel fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { counts: emptyCounts(null), detail: unavailableDetail };
  }
}
