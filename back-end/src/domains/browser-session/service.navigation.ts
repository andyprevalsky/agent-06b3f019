import { randomUUID } from 'node:crypto';
import { refreshTilionConnectUrl } from '../../providers/browser/tilion';
import { withTimeout } from '../../providers/steel/injectionTimeouts';
import { retryWithBackoff } from '../../providers/retry';
import { rootBrowserAgentId } from '../../providers/browser/worldStateMerge';
import { SessionNotFoundError } from './service.local-storage';
import * as repo from './repo.navigation';
import { navigateRootBrowser } from './service.navigation-cdp';

export type NavigationAction = 'back' | 'forward' | 'reload';
export type NavigationCommand = {
  id: string;
  sessionId: string;
  action: NavigationAction;
  deadline: number;
  state: 'pending' | 'claimed' | 'done' | 'error';
  url?: string | null;
  error?: string;
};
export class BrowserNavigationError extends Error {
  constructor(
    message: string,
    public readonly status = 409
  ) {
    super(message);
  }
}
function command(value: unknown): NavigationCommand | null {
  return value !== null && typeof value === 'object' ? (value as NavigationCommand) : null;
}
async function requireSession(taskId: string, userId?: string) {
  const row = await repo.findNavigationSession(taskId);
  if (!row || (userId !== undefined && row.context.userId !== userId))
    throw new SessionNotFoundError();
  if (
    row.status !== 'ACTIVE' ||
    row.sessionId === null ||
    row.sessionId === '' ||
    row.controlState !== 'USER' ||
    !row.controlLeaseExpiresAt ||
    row.controlLeaseExpiresAt.getTime() <= Date.now()
  ) {
    throw new BrowserNavigationError('Take control of the live browser before navigating');
  }
  return row;
}
const json = (value: NavigationCommand) =>
  value as unknown as NonNullable<Parameters<typeof repo.swapNavigationCommand>[2]>;

export async function navigateBrowser(taskId: string, action: NavigationAction, userId?: string) {
  const row = await requireSession(taskId, userId);
  const previous = command(row.navigationCommand);
  if (
    previous &&
    previous.sessionId === row.sessionId &&
    previous.deadline > Date.now() &&
    (previous.state === 'pending' || previous.state === 'claimed')
  ) {
    throw new BrowserNavigationError('Browser navigation is already in progress');
  }
  const root = row.agentId === rootBrowserAgentId(row.context.userId);
  const mayDriveDirectly = async () =>
    root ||
    (await repo.hasDetachedAuthWorker(taskId, row.sessionId!, row.agentId, row.context.userId));
  const direct = await mayDriveDirectly();
  const request: NavigationCommand = {
    id: randomUUID(),
    sessionId: row.sessionId!,
    action,
    deadline: Date.now() + 15_000,
    state: direct ? 'claimed' : 'pending',
  };
  if (
    !(await repo.swapNavigationCommand(
      taskId,
      request.sessionId,
      row.navigationCommand as NonNullable<Parameters<typeof repo.swapNavigationCommand>[2]> | null,
      json(request)
    ))
  ) {
    throw new BrowserNavigationError('Browser session or control changed; retry navigation');
  }
  if (direct) {
    try {
      const checkBinding = async () => {
        const current = await requireSession(taskId, userId);
        if (
          current.sessionId !== request.sessionId ||
          command(current.navigationCommand)?.id !== request.id
        ) {
          throw new BrowserNavigationError('Browser session changed during navigation');
        }
        if (!(await mayDriveDirectly()))
          throw new BrowserNavigationError('Browser worker ownership changed');
      };
      const wsUrl =
        row.provider === 'tilion'
          ? await withTimeout(
              refreshTilionConnectUrl(request.sessionId),
              Math.max(1, request.deadline - Date.now()),
              'Timed out refreshing browser connection'
            )
          : row.wsUrl;
      await checkBinding();
      const url = await navigateRootBrowser(wsUrl, action, request.deadline, checkBinding);
      if (
        !(await repo.swapNavigationCommand(
          taskId,
          request.sessionId,
          json(request),
          json({ ...request, state: 'done', url })
        ))
      ) {
        throw new BrowserNavigationError('Browser session changed during navigation');
      }
      return { url };
    } catch (error) {
      await repo.swapNavigationCommand(
        taskId,
        request.sessionId,
        json(request),
        json({ ...request, state: 'error', error: 'Browser navigation failed' })
      );
      if (error instanceof BrowserNavigationError) throw error;
      throw new BrowserNavigationError('Browser navigation failed', 502);
    }
  }
  return waitForNavigation(taskId, request, userId);
}

const NAVIGATION_RECEIPT_POLL_MS = 100;

async function waitForNavigation(taskId: string, request: NavigationCommand, userId?: string) {
  // Poll a durable command receipt; this is not a retry of browser side effects.
  // Each read happens only before the deadline; the attempt cap is a safety
  // bound, since every poll waits at least NAVIGATION_RECEIPT_POLL_MS.
  const polls =
    Math.ceil(Math.max(0, request.deadline - Date.now()) / NAVIGATION_RECEIPT_POLL_MS) + 1;
  const receipt = await retryWithBackoff(
    async () => {
      if (Date.now() >= request.deadline) return null;
      const current = await requireSession(taskId, userId);
      const observed = command(current.navigationCommand);
      if (current.sessionId !== request.sessionId || observed?.id !== request.id) {
        throw new BrowserNavigationError('Browser session changed during navigation');
      }
      return observed;
    },
    {
      maxRetries: polls,
      fixedDelays: Array<number>(polls).fill(NAVIGATION_RECEIPT_POLL_MS),
      isRetryable: () => false,
      shouldRetryResult: (observed) =>
        observed !== null && observed.state !== 'done' && observed.state !== 'error',
      component: 'BrowserNavigationReceipt',
    }
  );
  if (receipt?.state === 'done') return { url: receipt.url ?? null };
  if (receipt?.state === 'error')
    throw new BrowserNavigationError(receipt.error ?? 'Browser navigation failed', 502);
  throw new BrowserNavigationError(
    'Browser worker did not complete navigation before the deadline',
    504
  );
}

/** Worker-only claim; the caller must supply the provider session it actually holds. */
export async function claimBrowserNavigation(taskId: string, sessionId: string) {
  const row = await requireSession(taskId);
  const pending = command(row.navigationCommand);
  if (
    row.sessionId !== sessionId ||
    !pending ||
    pending.sessionId !== sessionId ||
    pending.state !== 'pending' ||
    pending.deadline <= Date.now()
  )
    return null;
  const claimed: NavigationCommand = { ...pending, state: 'claimed' };
  return (await repo.swapNavigationCommand(taskId, sessionId, json(pending), json(claimed)))
    ? claimed
    : null;
}
export async function completeBrowserNavigation(
  taskId: string,
  sessionId: string,
  id: string,
  result: { url: string | null; error?: string }
) {
  const row = await requireSession(taskId);
  const claimed = command(row.navigationCommand);
  if (
    row.sessionId !== sessionId ||
    !claimed ||
    claimed.id !== id ||
    claimed.sessionId !== sessionId ||
    claimed.state !== 'claimed' ||
    claimed.deadline <= Date.now()
  ) {
    throw new BrowserNavigationError('Navigation command is stale');
  }
  const next: NavigationCommand = {
    ...claimed,
    state: result.error !== undefined ? 'error' : 'done',
    url: result.url,
    ...(result.error !== undefined ? { error: 'Browser worker navigation failed' } : {}),
  };
  if (!(await repo.swapNavigationCommand(taskId, sessionId, json(claimed), json(next)))) {
    throw new BrowserNavigationError('Navigation command changed');
  }
}
