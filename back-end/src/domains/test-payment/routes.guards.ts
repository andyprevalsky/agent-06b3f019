/**
 * Shared route guard and error responder for the test-payment surface. Lives in its own module
 * because both the main router and the hosted-checkout router need them, and duplicating the
 * enabled/production-benchmark rule or the failure-logging rule risks the two drifting apart.
 */

import type { Response } from 'express';
import { isProductionEnv, TEST_PAYMENT_ENABLED } from './config';
import { TestPaymentError } from './errors';
import { classifyLifecycleError } from './lifecycle-errors';
import { createLogger } from '../../providers/logger';

const log = createLogger('TestPayment');

export function rejectWhenDisabled(
  res: Response,
  options: { allowProductionBenchmark?: boolean } = {}
): boolean {
  if (TEST_PAYMENT_ENABLED || (options.allowProductionBenchmark === true && isProductionEnv())) {
    return false;
  }
  res.status(404).json({ error: 'Not found' });
  return true;
}

function upstreamCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

function upstreamStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

/**
 * Single exit for every test-payment route failure.
 *
 * A `TestPaymentError` is a deliberate, already-explained outcome, so it answers with its own status
 * and message. Anything else is an UNEXPECTED failure — most often an upstream Stripe or AgentCard
 * error — and used to collapse into a bare 500 whose cause appeared in NO log at all, which made a
 * repeatedly failing benchmark effectively undiagnosable from the backend log (the recorded
 * occurrences on 2026-07-11 and 2026-07-14 were never root-caused for exactly that reason). Such
 * errors are now
 * logged with their message, upstream status/code and stack before the opaque body is returned, so
 * the response stays client-safe (no upstream detail leaks) while the cause is always recoverable.
 */
export function respondTestPaymentError(
  res: Response,
  error: unknown,
  fallbackMessage: string,
  context: Record<string, unknown> = {}
): void {
  if (error instanceof TestPaymentError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  log.error(fallbackMessage, {
    ...context,
    error: error instanceof Error ? error.message : String(error),
    error_name: error instanceof Error ? error.name : typeof error,
    upstream_status: upstreamStatus(error),
    upstream_code: upstreamCode(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  // An upstream refusal is not our 500. The AgentCard Organization MCP enforces
  // an org-wide request cap and answers with an absolute retryAfter; reporting
  // that as a generic 500 made every caller retry straight back into the same
  // closed window, which is how a terminal-clean lifecycle got reported as
  // "cleanup did not complete". An outage likewise keeps its own 502/504.
  const classified = classifyLifecycleError(error, fallbackMessage);
  if (classified.status !== 500) {
    if (classified.retryAfterSeconds !== null) {
      res.setHeader('Retry-After', String(classified.retryAfterSeconds));
    }
    res.status(classified.status).json(classified.body);
    return;
  }
  res.status(500).json({ error: fallbackMessage });
}
