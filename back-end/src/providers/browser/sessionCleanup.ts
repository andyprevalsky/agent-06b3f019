import { createLogger } from '../logger';
import { releaseSteelRemoteSession } from '../steel/session';
import { releaseKernelRemoteSession } from './kernel';
import { releaseBrowserUseRemoteSession } from './browserUse';
import { releaseTilionRemoteSession } from './tilion';
import type { BrowserProviderName } from './types';

const log = createLogger('BrowserProvider');

export interface SupersededBrowserRelease {
  taskId: string;
  previousProvider: BrowserProviderName;
  previousSessionId: string | null;
  operation: 'resume' | 'rotation';
  /** The replacement's session id; equal to previousSessionId on a reattach/in-place rotate. */
  currentSessionId?: string;
}

export interface SupersededBrowserReleaseDependencies {
  releaseKernel: (sessionId: string) => Promise<void>;
  releaseSteel: (sessionId: string) => Promise<void>;
  releaseBrowserUse: (sessionId: string) => Promise<void>;
  releaseTilion: (sessionId: string) => Promise<void>;
}

const defaultDependencies: SupersededBrowserReleaseDependencies = {
  releaseKernel: releaseKernelRemoteSession,
  releaseSteel: releaseSteelRemoteSession,
  releaseBrowserUse: releaseBrowserUseRemoteSession,
  releaseTilion: releaseTilionRemoteSession,
};

/** Reap an already-replaced remote browser without hiding cleanup exhaustion. */
export async function releaseSupersededBrowser(
  release: SupersededBrowserRelease,
  dependencies: SupersededBrowserReleaseDependencies = defaultDependencies
): Promise<boolean> {
  if (release.previousSessionId === null) return true;
  // A reattach or in-place rotate keeps the same remote session: nothing was superseded.
  if (release.currentSessionId === release.previousSessionId) return true;
  try {
    if (release.previousProvider === 'kernel') {
      await dependencies.releaseKernel(release.previousSessionId);
    } else if (release.previousProvider === 'browser-use') {
      await dependencies.releaseBrowserUse(release.previousSessionId);
    } else if (release.previousProvider === 'tilion') {
      await dependencies.releaseTilion(release.previousSessionId);
    } else {
      await dependencies.releaseSteel(release.previousSessionId);
    }
    return true;
  } catch (error) {
    // The replacement is already committed. Returning it keeps the worker in
    // sync with the DB; provider release helpers have exhausted bounded retries.
    log.error(`Failed to release superseded browser after ${release.operation}`, {
      taskId: release.taskId,
      previousProvider: release.previousProvider,
      previousSessionId: release.previousSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
