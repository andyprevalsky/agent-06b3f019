import type { BrowserProviderName } from './types';

export interface KernelCaptchaTelemetryConfig {
  enabled: boolean;
  browser: { captcha: { enabled: boolean } };
}

export interface CaptchaTerminalOutcome {
  status: string;
  captchaType: string | null;
  durationMs: number | null;
  errorCode: string | null;
  websiteHost: string | null;
  timestampMicros: number | null;
}

export interface BrowserCaptchaTelemetry {
  provider: BrowserProviderName;
  telemetryEnabled: boolean;
  isSolving: boolean | null;
  activeTaskCount: number | null;
  pages: Array<{
    hostname: string;
    isSolving: boolean;
    taskCount: number;
    created: number | null;
    lastUpdated: number | null;
  }>;
  latestOutcome: CaptchaTerminalOutcome | null;
}

interface KernelCaptchaEventLike {
  seq?: number;
  event?: {
    category?: string;
    type?: string;
    ts?: number;
    source?: unknown;
    data?: {
      status?: string;
      captcha_type?: string;
      duration_ms?: number;
      error_code?: string;
      website_host?: string;
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isKernelCaptchaEventLike(value: unknown): value is KernelCaptchaEventLike {
  if (!isRecord(value) || !isRecord(value.event)) return false;
  return value.event.category === 'captcha' && value.event.type === 'captcha_solve_result';
}

function telemetryHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

interface SteelCaptchaStatusLike {
  isSolvingCaptcha: boolean;
  pageId: string;
  tasks: unknown[];
  url: string;
  created?: number;
  lastUpdated?: number;
}

const STEEL_SUCCESS_STATUSES = new Set(['solved']);
const STEEL_FAILURE_STATUSES = new Set([
  'failed_to_solve',
  'validation_failed',
  'failed_to_detect',
]);

/** Map Steel task status → Kernel-aligned terminal status (success|failure). */
function normalizeSteelTaskStatus(status: string): 'success' | 'failure' | null {
  const normalized = status.toLowerCase();
  if (STEEL_SUCCESS_STATUSES.has(normalized)) return 'success';
  if (STEEL_FAILURE_STATUSES.has(normalized)) return 'failure';
  return null;
}

function steelTaskTimestampMs(task: Record<string, unknown>, pageLastUpdated?: number): number {
  for (const key of ['solveTime', 'failureTime', 'lastUpdated', 'created'] as const) {
    const value = task[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return typeof pageLastUpdated === 'number' && Number.isFinite(pageLastUpdated)
    ? pageLastUpdated
    : 0;
}

/** Latest terminal Steel task across pages, normalized into CaptchaTerminalOutcome. */
export function extractSteelLatestOutcome(
  statuses: SteelCaptchaStatusLike[]
): CaptchaTerminalOutcome | null {
  let best: CaptchaTerminalOutcome | null = null;
  let bestTs = -1;
  for (const status of statuses) {
    const host = telemetryHostname(status.url);
    for (const raw of status.tasks) {
      if (!isRecord(raw)) continue;
      const taskStatus = typeof raw.status === 'string' ? raw.status : '';
      const normalized = normalizeSteelTaskStatus(taskStatus);
      if (normalized === null) continue;
      const tsMs = steelTaskTimestampMs(raw, status.lastUpdated);
      if (tsMs < bestTs) continue;
      bestTs = tsMs;
      best = {
        status: normalized,
        captchaType: typeof raw.type === 'string' ? raw.type : null,
        durationMs: typeof raw.totalDuration === 'number' ? raw.totalDuration : null,
        errorCode: typeof raw.error === 'string' ? raw.error : null,
        websiteHost: host.length > 0 ? host : null,
        // Steel timestamps are ms; Kernel uses micros — normalize to micros.
        timestampMicros: tsMs > 0 ? tsMs * 1000 : null,
      };
    }
  }
  return best;
}

/** Kernel only records CAPTCHA outcomes when browser telemetry is explicit. */
export function kernelCaptchaTelemetryConfig(): KernelCaptchaTelemetryConfig {
  return { enabled: true, browser: { captcha: { enabled: true } } };
}

export function summarizeKernelCaptchaEvents(events: unknown[]): BrowserCaptchaTelemetry {
  const latest = [...events]
    .filter(isKernelCaptchaEventLike)
    .sort((left, right) => (right.seq ?? 0) - (left.seq ?? 0))[0]?.event;
  const data = latest?.data;

  return {
    provider: 'kernel',
    telemetryEnabled: true,
    // Kernel emits terminal outcomes, not an in-flight status endpoint.
    isSolving: null,
    activeTaskCount: null,
    pages: [],
    latestOutcome: latest
      ? {
          status: data?.status ?? 'unknown',
          captchaType: data?.captcha_type ?? null,
          durationMs: data?.duration_ms ?? null,
          errorCode: data?.error_code ?? null,
          websiteHost: data?.website_host ?? null,
          timestampMicros: latest.ts ?? null,
        }
      : null,
  };
}

export function summarizeSteelCaptchaStatus(
  statuses: SteelCaptchaStatusLike[]
): BrowserCaptchaTelemetry {
  const pages = statuses.map((status) => ({
    // Never persist Steel page IDs or URL paths: both can contain account IDs,
    // reset tokens, or other user-specific material. Hostname is sufficient to
    // correlate solver state with the challenged site.
    hostname: telemetryHostname(status.url),
    isSolving: status.isSolvingCaptcha,
    taskCount: status.tasks.length,
    created: status.created ?? null,
    lastUpdated: status.lastUpdated ?? null,
  }));

  return {
    provider: 'steel',
    telemetryEnabled: true,
    isSolving: pages.some((page) => page.isSolving),
    activeTaskCount: pages.reduce(
      (count, page) => count + (page.isSolving ? page.taskCount : 0),
      0
    ),
    pages,
    latestOutcome: extractSteelLatestOutcome(statuses),
  };
}
