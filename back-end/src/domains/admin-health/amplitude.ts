import { createLogger } from '../../providers/logger';
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
const funnelCache = new Map<string, { expiresAt: number; value: AmplitudeFunnelResult }>();
let knownEventsCache: { expiresAt: number; value: Set<string> } | null = null;
let knownEventsRequest: Promise<Set<string>> | null = null;
let activeRequests = 0;
const requestWaiters: Array<() => void> = [];

function emptyCounts(value: number | null): Record<AmplitudeFunnelStepId, number | null> {
  return Object.fromEntries(FUNNEL_EVENTS.map((event) => [event.id, value])) as Record<
    AmplitudeFunnelStepId,
    number | null
  >;
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
  return withRequestSlot(async () => {
    const response = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!response.ok) throw new Error(`Amplitude ${response.status}`);
    return (await response.json()) as T;
  });
}

async function fetchKnownEvents(): Promise<Set<string>> {
  if (knownEventsCache !== null && knownEventsCache.expiresAt > Date.now()) {
    return knownEventsCache.value;
  }
  if (knownEventsRequest !== null) return knownEventsRequest;
  knownEventsRequest = amplitudeGet<{ data?: Array<{ name?: string }> }>('/api/2/events/list').then(
    (body) => {
      const value = new Set(
        body.data?.flatMap((event) =>
          event.name === undefined || event.name === '' ? [] : [event.name]
        ) ?? []
      );
      knownEventsCache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
      return value;
    }
  );
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

async function fetchEventPair(
  events: FunnelEvent[],
  start: Date,
  end: Date
): Promise<Array<{ id: AmplitudeFunnelStepId; count: number }>> {
  const query = new URLSearchParams({
    e: JSON.stringify({ event_type: events[0].eventType, filters: events[0].filters ?? [] }),
    m: 'uniques',
    start: formatDate(start),
    end: formatDate(new Date(end.getTime() - 1)),
  });
  if (events[1] !== undefined) {
    query.set(
      'e2',
      JSON.stringify({ event_type: events[1].eventType, filters: events[1].filters ?? [] })
    );
  }
  const body = await amplitudeGet<{
    data?: { seriesCollapsed?: Array<Array<{ value?: number }>> };
  }>('/api/2/events/segmentation', query);
  return events.map((event, index) => ({
    id: event.id,
    count: body.data?.seriesCollapsed?.[index]?.[0]?.value ?? 0,
  }));
}

function pairs<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 2) result.push(items.slice(index, index + 2));
  return result;
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
    const knownEvents = await fetchKnownEvents();
    const counts = emptyCounts(null);
    const trackedEvents = FUNNEL_EVENTS.filter((event) => knownEvents.has(event.eventType));
    for (const eventPair of pairs(trackedEvents)) {
      const results = await fetchEventPair(eventPair, start, effectiveEnd);
      for (const result of results) counts[result.id] = result.count;
    }
    const value = {
      counts,
      detail: 'Unique users recorded by Amplitude in the selected period.',
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
