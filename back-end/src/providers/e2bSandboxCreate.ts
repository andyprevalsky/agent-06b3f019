import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { RateLimitError, Sandbox, ServiceBusyError } from 'e2b';
import { alertError } from './errorAlert';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';

const log = createLogger('E2B');
const SANDBOX_CREATE_ATTEMPTS = 3;
const SANDBOX_CREATE_BASE_BACKOFF_MS = 500;

/**
 * Raised when we cannot determine whether a prior create attempt already left a
 * sandbox behind. It is deliberately retryable: retrying re-runs the lookup,
 * whereas creating would risk a duplicate, untracked, billed sandbox.
 */
export class SandboxOrphanLookupError extends Error {
  readonly isSandboxOrphanLookupError = true;
  constructor(
    createRequestId: string,
    readonly cause: unknown
  ) {
    super(
      `Could not determine whether create ${createRequestId} already produced a sandbox; ` +
        'refusing to create a possible duplicate'
    );
    this.name = 'SandboxOrphanLookupError';
  }
}

/**
 * Classify a transport failure reaching the E2B control plane, as opposed to a rejection by it.
 * Fetch hides the socket reason in `.cause`, so inspect the bounded cause chain as well.
 */
export function isTransientSandboxCreateError(error: unknown): boolean {
  // An inconclusive orphan lookup must keep the retry loop alive so the lookup
  // can settle; it must never fall through to a second create.
  if (error instanceof SandboxOrphanLookupError) return true;
  // A busy 503 is an E2B blip, not our plan limit; retry it here because the
  // SDK's own retry loop is off (see SANDBOX_CREATE_SDK_RETRIES).
  if (error instanceof ServiceBusyError) return true;
  const parts: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor !== null && cursor !== undefined; depth += 1) {
    if (cursor instanceof Error) {
      parts.push(cursor.message);
      const code = (cursor as NodeJS.ErrnoException).code;
      if (typeof code === 'string') parts.push(code);
      cursor = (cursor as { cause?: unknown }).cause;
      continue;
    }
    parts.push(String(cursor));
    break;
  }
  const haystack = parts.join(' | ');
  if (/\b(401|403|404|invalid api key|unauthorized|forbidden|quota|not found)\b/i.test(haystack)) {
    return false;
  }
  // Abort/timeout: E2B SDK defaults requestTimeoutMs to 60s. A wedged keep-alive
  // socket (cuda-kernel k=3 r29, 2026-09-05) hung until AbortSignal.timeout fired
  // with "The operation was aborted due to timeout" / empty TimeoutError — those
  // must retry instead of hard-failing the code-agent spawn.
  if (
    cursorMatchesTimeoutName(error) ||
    /aborted due to timeout|operation was aborted|TimeoutError|request handshake timed out|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(
      haystack
    )
  ) {
    return true;
  }
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EADDRNOTAVAIL|EAI_AGAIN|ENOTFOUND|EPIPE|ENETUNREACH|socket hang up|UND_ERR|terminated/i.test(
    haystack
  );
}

function cursorMatchesTimeoutName(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor !== null && cursor !== undefined; depth += 1) {
    if (cursor instanceof Error) {
      // Only TimeoutError / AbortError — never treat SecurityError,
      // QuotaExceededError, or other DOMExceptions as sandbox timeouts.
      if (cursor.name === 'TimeoutError' || cursor.name === 'AbortError') {
        return true;
      }
      cursor = (cursor as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return false;
}

/**
 * True when sandbox create failed specifically on control-plane abort/timeout
 * (not billing/auth). Used by same-host local Claude Code fallback.
 */
export function isSandboxCreateTimeoutOrAbortError(error: unknown): boolean {
  if (cursorMatchesTimeoutName(error)) return true;
  const parts: string[] = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor !== null && cursor !== undefined; depth += 1) {
    if (cursor instanceof Error) {
      parts.push(cursor.message);
      // Nested transport timeouts often carry only errno / undici codes
      // (no TimeoutError name) — still treat them as create timeouts so the
      // local Claude Code fallback can engage.
      const code = (cursor as NodeJS.ErrnoException).code;
      if (typeof code === 'string') parts.push(code);
      cursor = (cursor as { cause?: unknown }).cause;
      continue;
    }
    parts.push(String(cursor));
    break;
  }
  return /aborted due to timeout|operation was aborted|TimeoutError|request handshake timed out|ETIMEDOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/i.test(
    parts.join(' | ')
  );
}

/**
 * Create an E2B sandbox with transport retries and client-side idempotency.
 *
 * E2B has no create idempotency key. A transport error is therefore ambiguous: the sandbox may
 * be running even though its response was lost. All attempts carry one metadata tag, and each
 * retry plus the terminal failure path adopts a sandbox already created for that logical request.
 */
/**
 * The e2b SDK retries a 429 that carries Retry-After for up to the request
 * timeout before surfacing RateLimitError. That is a hidden wait on the
 * concurrent-sandbox refusal, which must fail at once; transport retries are
 * owned by `createSandboxAttempts` instead.
 */
export const SANDBOX_CREATE_SDK_RETRIES = 0;

/** Floor for E2B control-plane requestTimeoutMs on sandbox create. */
export const SANDBOX_CREATE_REQUEST_TIMEOUT_MS = 120_000;

/**
 * E2B refused a create because the team's concurrent-sandbox plan limit is in
 * use (HTTP 429, `RateLimitError`). Creates fail immediately on it, without
 * waiting or queueing, so the shortage stays visible and the plan gets scaled.
 */
export class E2BSandboxCapacityError extends Error {
  readonly code = 'E2B_CAPACITY_EXHAUSTED';
  readonly statusCode = 503;
  constructor(readonly providerDetail: string) {
    super(
      'E2B concurrent-sandbox limit reached: every sandbox allowed by the current E2B plan ' +
        'is in use, so no new sandbox can start. Scale the E2B plan to run more code agents.'
    );
    this.name = 'E2BSandboxCapacityError';
  }
}

/**
 * Who created a sandbox, carried as E2B metadata so ownership is attributable:
 * the deployment (`roseOrigin`: the Render service on Render, else this host) and the
 * stack (`roseStack`: origin + workspace name + the database it records sandboxes in, or an
 * explicit ROSE_SANDBOX_STACK_ID). Every sandbox of a stack is recorded in that
 * stack's database, so its teardown and its orphan reaper can act on exactly
 * its own sandboxes (codeSessions/sandboxReaper.ts). The database part is a
 * hash of host/port/name only; no credentials are tagged.
 */
export function roseSandboxIdentity(): { roseOrigin: string; roseStack: string } {
  const roseOrigin =
    process.env.ROSE_SANDBOX_ORIGIN?.trim() ||
    // Render sets RENDER=true on its instances; a laptop .env may carry the
    // production RENDER_SERVICE_ID and must not claim the production origin.
    (process.env.RENDER === 'true' && process.env.RENDER_SERVICE_ID
      ? `render:${process.env.RENDER_SERVICE_ID}`
      : '') ||
    `host:${hostname()}`;
  const explicit = process.env.ROSE_SANDBOX_STACK_ID?.trim();
  // Every boxes devbox shares hostname `boxes` and the same local DB, so host+db
  // cannot tell workspaces apart. The workspace name (run.sh and `.cloud-env` set
  // it, clone-unique) does. Render keeps its format; sandboxes tagged before this
  // part existed keep their old `host:..|db:..` stack id.
  const workspace = process.env.CONDUCTOR_WORKSPACE_NAME?.trim();
  const workspacePart = workspace && !roseOrigin.startsWith('render:') ? `|ws:${workspace}` : '';
  return {
    roseOrigin,
    roseStack: explicit || `${roseOrigin}${workspacePart}|db:${databaseFingerprint()}`,
  };
}

function databaseFingerprint(): string {
  const raw = process.env.DATABASE_URL;
  if (raw === undefined || raw === '') return 'none';
  try {
    const url = new URL(raw);
    return createHash('sha256')
      .update(`${url.hostname}:${url.port}${url.pathname}`)
      .digest('hex')
      .slice(0, 16);
  } catch {
    return 'unparsed';
  }
}

export async function createSandboxWithRetry(
  templateId: string,
  options: Parameters<typeof Sandbox.create>[1],
  label: string
): Promise<Awaited<ReturnType<typeof Sandbox.create>>> {
  try {
    return await createSandboxAttempts(templateId, options, label);
  } catch (error) {
    if (!(error instanceof RateLimitError)) throw error;
    const capacity = new E2BSandboxCapacityError(error.message);
    log.error(`E2B:${label} ${capacity.message}`, { providerDetail: error.message });
    alertError({
      source: 'e2b_capacity',
      message: capacity.message,
      context: { label, providerDetail: error.message.slice(0, 300) },
    });
    throw capacity;
  }
}

async function createSandboxAttempts(
  templateId: string,
  options: Parameters<typeof Sandbox.create>[1],
  label: string
): Promise<Awaited<ReturnType<typeof Sandbox.create>>> {
  const createRequestId = uuidv4();
  const callerRequestTimeoutMs =
    options && typeof options === 'object' && 'requestTimeoutMs' in options
      ? (options as { requestTimeoutMs?: number }).requestTimeoutMs
      : undefined;
  const taggedOptions = {
    ...options,
    // Never inherit the SDK's 60s default when a keep-alive socket is half-dead —
    // give the control plane enough room, and still classify abort as transient.
    retries: SANDBOX_CREATE_SDK_RETRIES,
    requestTimeoutMs: Math.max(callerRequestTimeoutMs ?? 0, SANDBOX_CREATE_REQUEST_TIMEOUT_MS),
    metadata: { ...(options?.metadata ?? {}), ...roseSandboxIdentity(), createRequestId },
  } as Parameters<typeof Sandbox.create>[1];

  let attempt = 0;
  try {
    return await retryWithBackoff(
      async () => {
        attempt += 1;
        if (attempt > 1) {
          const lookup = await findSandboxByCreateRequestId(createRequestId, label);
          if (lookup.status === 'found') {
            log.warn(
              `E2B:${label} adopting sandbox ${lookup.sandbox.sandboxId} from a prior attempt of ` +
                `create ${createRequestId} (response was lost, sandbox was not)`
            );
            return lookup.sandbox;
          }
          if (lookup.status === 'unknown') {
            // The prior attempt may have created a sandbox we simply cannot see
            // right now. Creating another one here would leave the first
            // untracked and billed forever, so surface a retryable error and let
            // backoff re-run the lookup instead. Exhausting retries fails the
            // create — strictly better than silently double-provisioning.
            throw new SandboxOrphanLookupError(createRequestId, lookup.error);
          }
        }
        return Sandbox.create(templateId, taggedOptions);
      },
      {
        maxRetries: SANDBOX_CREATE_ATTEMPTS,
        initialBackoffMs: SANDBOX_CREATE_BASE_BACKOFF_MS,
        isRetryable: isTransientSandboxCreateError,
        component: `E2B:${label}`,
      }
    );
  } catch (error) {
    if (isTransientSandboxCreateError(error)) {
      const lookup = await findSandboxByCreateRequestId(createRequestId, label);
      if (lookup.status === 'found') {
        log.warn(
          `E2B:${label} adopting sandbox ${lookup.sandbox.sandboxId} from the final attempt of ` +
            `create ${createRequestId} (response was lost, sandbox was not)`
        );
        return lookup.sandbox;
      }
    }
    throw error;
  }
}

type OrphanLookup =
  | { status: 'found'; sandbox: Awaited<ReturnType<typeof Sandbox.connect>> }
  | { status: 'absent' }
  | { status: 'unknown'; error: unknown };

/**
 * Three-state on purpose. Collapsing a failed `Sandbox.list()` into "no orphan"
 * makes an inconclusive lookup indistinguishable from a conclusive absence, and
 * the caller then creates a second sandbox while the first stays alive, untracked
 * and billed. `absent` is only returned when the list call actually completed.
 */
async function findSandboxByCreateRequestId(
  createRequestId: string,
  label: string
): Promise<OrphanLookup> {
  let sandboxId: string | undefined;
  try {
    const paginator = Sandbox.list({ query: { metadata: { createRequestId } } });
    const items = await paginator.nextItems();
    sandboxId = items?.[0]?.sandboxId;
  } catch (error) {
    log.warn(
      `E2B:${label} could not check for an orphaned sandbox from create ${createRequestId}: ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
    return { status: 'unknown', error };
  }
  if (!sandboxId) return { status: 'absent' };

  // A failed connection does not mean the tagged sandbox disappeared. Let the
  // outer retry adopt it again instead of falling through to a duplicate create.
  return { status: 'found', sandbox: await Sandbox.connect(sandboxId) };
}
