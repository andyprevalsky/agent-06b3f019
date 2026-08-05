import { Sandbox } from 'e2b';
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
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EADDRNOTAVAIL|EAI_AGAIN|ENOTFOUND|EPIPE|ENETUNREACH|socket hang up|UND_ERR|terminated/i.test(
    haystack
  );
}

/**
 * Create an E2B sandbox with transport retries and client-side idempotency.
 *
 * E2B has no create idempotency key. A transport error is therefore ambiguous: the sandbox may
 * be running even though its response was lost. All attempts carry one metadata tag, and each
 * retry plus the terminal failure path adopts a sandbox already created for that logical request.
 */
export async function createSandboxWithRetry(
  templateId: string,
  options: Parameters<typeof Sandbox.create>[1],
  label: string
): Promise<Awaited<ReturnType<typeof Sandbox.create>>> {
  const createRequestId = uuidv4();
  const taggedOptions = {
    ...options,
    metadata: { ...(options?.metadata ?? {}), createRequestId },
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
