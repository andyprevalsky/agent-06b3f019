/**
 * Live Cerebras /models catalog read for the cerebras blackbox domain.
 *
 *   GET /models ──ok──────────────────────────> ids (caller's inventory assertions stay blocking)
 *       │
 *       ├─408/429/5xx (transient provider)──> wait Retry-After (≤30 s, when sent)
 *       │                                      + backoff 1/2/4/8/16/32 s ──> GET /models
 *       │                                      (bounded: 7 attempts)
 *       └─other non-OK, or still transient after the last attempt
 *              ──> AssertionError "Cerebras /models must be reachable for the live probe:
 *                  HTTP <status> after <n> attempt(s) cf-ray=<id> retry-after=<v> cf-error=<code> <body>"
 *
 * Deploy-gate VMs share egress IPs, and the Cloudflare edge in front of
 * api.cerebras.ai answers their reads with a 429 HTML page that can persist
 * for longer than 15 s (RCA ef18929c). Transient statuses are waited out within
 * this bound; any other status, or a limit that outlasts it, still fails.
 */
import assert from 'node:assert/strict';

import { retryWithBackoff } from '../../providers/retry';

const MODELS_MAX_ATTEMPTS = 7;
const MODELS_RETRY_AFTER_CAP_MS = 30_000;

interface ModelsRead {
  ok: boolean;
  status: number;
  cfRay: string | null;
  retryAfter: string | null;
  text: string;
}

function isTransientModelsStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Retry-After as delta-seconds or an HTTP date, capped; null when absent or unparseable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MODELS_RETRY_AFTER_CAP_MS) : null;
}

function cloudflareErrorCode(body: string): string {
  return /error(?: code)?:?\s*(\d{4})/i.exec(body)?.[1] ?? '-';
}

export async function fetchLiveCerebrasModelIds(url: string, key: string): Promise<Set<string>> {
  let attempts = 0;
  const read = await retryWithBackoff<ModelsRead>(
    async () => {
      attempts += 1;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      return {
        ok: response.ok,
        status: response.status,
        cfRay: response.headers.get('cf-ray'),
        retryAfter: response.headers.get('retry-after'),
        text: await response.text(),
      };
    },
    {
      maxRetries: MODELS_MAX_ATTEMPTS,
      initialBackoffMs: 1_000,
      shouldRetryResult: (result) => !result.ok && isTransientModelsStatus(result.status),
      beforeRetryResult: async (result) => {
        const wait = retryAfterMs(result.retryAfter);
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      },
      component: 'cerebras-models-probe',
    }
  );
  assert.equal(
    read.ok,
    true,
    `Cerebras /models must be reachable for the live probe: HTTP ${read.status} after ${attempts} attempt(s) ` +
      `cf-ray=${read.cfRay ?? '-'} retry-after=${read.retryAfter ?? '-'} ` +
      `cf-error=${cloudflareErrorCode(read.text)} ${read.text.replaceAll(key, '[REDACTED]').slice(0, 200)}`
  );
  const catalog = JSON.parse(read.text) as { data?: Array<{ id?: string }> };
  return new Set(
    (catalog.data ?? []).map((row) => row.id).filter((id): id is string => Boolean(id))
  );
}
