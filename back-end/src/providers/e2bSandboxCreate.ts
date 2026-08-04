import { Sandbox } from 'e2b';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './logger';
import { retryWithBackoff } from './retry';

const log = createLogger('E2B');
const SANDBOX_CREATE_ATTEMPTS = 3;
const SANDBOX_CREATE_BASE_BACKOFF_MS = 500;

/**
 * Classify a transport failure reaching the E2B control plane, as opposed to a rejection by it.
 * Fetch hides the socket reason in `.cause`, so inspect the bounded cause chain as well.
 */
export function isTransientSandboxCreateError(error: unknown): boolean {
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
          const orphan = await findSandboxByCreateRequestId(createRequestId, label);
          if (orphan) {
            log.warn(
              `E2B:${label} adopting sandbox ${orphan.sandboxId} from a prior attempt of ` +
                `create ${createRequestId} (response was lost, sandbox was not)`
            );
            return orphan;
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
      const orphan = await findSandboxByCreateRequestId(createRequestId, label);
      if (orphan) {
        log.warn(
          `E2B:${label} adopting sandbox ${orphan.sandboxId} from the final attempt of ` +
            `create ${createRequestId} (response was lost, sandbox was not)`
        );
        return orphan;
      }
    }
    throw error;
  }
}

/** Best-effort lookup: a control-plane list failure must not suppress a retryable create. */
async function findSandboxByCreateRequestId(
  createRequestId: string,
  label: string
): Promise<Awaited<ReturnType<typeof Sandbox.connect>> | null> {
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
    return null;
  }
  if (!sandboxId) return null;

  // A failed connection does not mean the tagged sandbox disappeared. Let the
  // outer retry adopt it again instead of falling through to a duplicate create.
  return Sandbox.connect(sandboxId);
}
