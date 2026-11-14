import { AgentCardV2Error } from '../../providers/agentcard/api-v2';
import { AgentCardOrgRuntimeError } from '../../providers/agentcard/org-runtime';
import { createLogger } from '../../providers/logger';
import { TestPaymentError } from './errors';

const log = createLogger('TestPayment');

export interface LifecycleErrorResponse {
  status: number;
  body: Record<string, unknown>;
  /** Seconds the caller should wait before retrying, when the upstream said so. */
  retryAfterSeconds: number | null;
}

/**
 * Recognize an upstream rate-limit refusal and recover its retry deadline.
 *
 * The AgentCard Organization MCP enforces an org-wide request cap and answers
 * with a `Rate limit exceeded` payload carrying an absolute `retryAfter` epoch.
 * That arrives as an opaque transport error, so without this it reads as our own
 * 500 and every caller retries immediately back into the same closed window.
 *
 * Returns `undefined` when the error is not a rate limit, and `null` when it is
 * one that carried no deadline.
 */
function upstreamRateLimitRetryMs(error: unknown): number | null | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/rate limit exceeded/i.test(message)) return undefined;
  const match = /"retryAfter"\s*:\s*(\d+)/.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * Classify a lifecycle-route failure into the response the caller should get.
 *
 * Framework-agnostic by design (structural express-leak invariant): the route
 * adapter applies this to `res`. Every unclassified error is logged with its
 * message before the generic 500 — silently swallowing it left this whole
 * failure class undiagnosable, so a transient upstream blip was
 * indistinguishable from a real lifecycle bug.
 */
export function classifyLifecycleError(
  error: unknown,
  fallbackMessage: string
): LifecycleErrorResponse {
  if (error instanceof TestPaymentError) {
    return {
      status: error.statusCode,
      body: { error: error.message },
      retryAfterSeconds: null,
    };
  }

  const retryAfterMs = upstreamRateLimitRetryMs(error);
  if (retryAfterMs !== undefined) {
    const retryAfterSeconds =
      retryAfterMs !== null ? Math.max(1, Math.ceil((retryAfterMs - Date.now()) / 1000)) : null;
    log.warn(fallbackMessage, {
      error: error instanceof Error ? error.message : String(error),
      code: 'agentcard_org_mcp_rate_limited',
      retryAfterSeconds,
      upstream: 'agentcard_org_mcp',
    });
    return {
      status: 429,
      body: {
        error: 'AgentCard Organization MCP rate limit exceeded',
        code: 'agentcard_org_mcp_rate_limited',
        retryAfterSeconds,
      },
      retryAfterSeconds,
    };
  }

  if (error instanceof AgentCardV2Error) {
    log.error(fallbackMessage, {
      error: error.message,
      code: error.code,
      status: error.status,
      upstream: 'agentcard_v2',
    });
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
      retryAfterSeconds: null,
    };
  }

  // An upstream outage is a 502/504 owned by the upstream, not a bare 500 from
  // us — reporting it as our own error made a provider blip look like a
  // lifecycle defect.
  if (error instanceof AgentCardOrgRuntimeError) {
    log.error(fallbackMessage, {
      error: error.message,
      code: error.code,
      status: error.status,
      upstream: 'agentcard_org_mcp',
    });
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
      retryAfterSeconds: null,
    };
  }

  log.error(fallbackMessage, {
    error: error instanceof Error ? error.message : String(error),
  });
  return {
    status: 500,
    body: { error: fallbackMessage },
    retryAfterSeconds: null,
  };
}
