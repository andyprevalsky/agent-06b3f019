import {
  RoseAuthError,
  RoseInvalidRequest,
  RosePaymentRequiredError,
  RoseRateLimitError,
  RoseRefusalError,
  RoseServerError,
} from './errors';

/** Map a Responses-API stream `error` payload to the Rose error the router fails over on. */
export function responsesErrorToException(errorPayload: unknown, requestId: string): Error {
  const payload =
    typeof errorPayload === 'object' && errorPayload !== null
      ? (errorPayload as Record<string, unknown>)
      : {};
  const code = String(payload.code ?? payload.type ?? '').toLowerCase();
  const message = String(payload.message ?? JSON.stringify(errorPayload ?? {}));
  const details = `Responses stream failed (request_id=${requestId}, code=${code || 'unknown'}): ${message.substring(0, 1000)}`;
  if (
    /^(insufficient_quota|credit_balance_exhausted|organization_(usage|spend)_limit_exceeded|project_spend_limit_exceeded)$/.test(
      code
    ) ||
    String(payload.type ?? '').toLowerCase() === 'insufficient_quota'
  )
    return new RosePaymentRequiredError(details);
  if (['invalid_request_error', 'context_length_exceeded', 'bad_request'].includes(code)) {
    return new RoseInvalidRequest(details);
  }
  if (
    ['refusal', 'safety_refusal', 'content_policy_violation', 'policy_violation'].includes(code)
  ) {
    return new RoseRefusalError(details);
  }
  if (['rate_limit_exceeded', 'rate_limit_error', 'too_many_requests'].includes(code)) {
    return new RoseRateLimitError(details);
  }
  if (['authentication_error', 'permission_error', 'unauthorized', 'forbidden'].includes(code)) {
    return new RoseAuthError(details);
  }
  return new RoseServerError(details);
}
