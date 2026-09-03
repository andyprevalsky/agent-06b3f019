// Transport-resilient fetch for the credential-health probes.
//
// The integration-health gate answers exactly one question: "does this
// credential still authenticate?". That verdict only ever arrives as an HTTP
// response — and `fetch` RESOLVES for every status, including 401/402/403. Such
// a response is handed straight back to the caller, so a rejected credential
// still hard-fails on its first attempt and cannot be papered over here.
//
// A transport-level abort REJECTS instead, and carries no verdict at all: the
// provider never answered, so treating it as "credential broken" is a false
// negative that blocks a deploy on a network hiccup. Those — and only those —
// are retried. The Supabase probe is why this exists: it is Cloudflare-fronted
// and steadily ~2s from the deploy hosts, leaving little headroom in a 5s
// window. On 2026-09-03 it aborted at 5001ms and failed the gate while the very
// same credential answered 200 in 2106ms moments later on an idle box.

import { retryWithBackoff } from '../../providers/retry';

/** Attempts per probe: the initial call plus one transport-only retry. */
export const CREDENTIAL_PROBE_ATTEMPTS = 2;

/** Per-attempt budget for a credential probe that is only proving auth. */
export const CREDENTIAL_PROBE_TIMEOUT_MS = 5000;

/** Short pause before the retry — this gate is latency-sensitive, not a queue. */
const CREDENTIAL_PROBE_RETRY_DELAY_MS = 250;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Fetch a credential probe with a per-attempt timeout, retrying only when the
 * transport fails outright. Returns the first response received, whatever its
 * status; throws the last transport error when every attempt aborts.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = CREDENTIAL_PROBE_TIMEOUT_MS,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  return retryWithBackoff(
    async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        return await fetchImpl(url, { ...init, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
    },
    {
      maxRetries: CREDENTIAL_PROBE_ATTEMPTS,
      initialBackoffMs: CREDENTIAL_PROBE_RETRY_DELAY_MS,
      // Anything that throws out of the operation above is a transport failure.
      // No `shouldRetryResult` is supplied, so a resolved Response — including
      // an auth rejection — is returned without a second attempt.
      isRetryable: () => true,
      component: 'CredentialProbe',
    }
  );
}
