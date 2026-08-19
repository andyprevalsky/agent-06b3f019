/**
 * Steel provider — browser session management via Steel.dev API.
 */

export { SteelRateLimitError } from './types';
export type { SteelFileInfo } from './types';
export {
  getOrCreateContext,
  createSessionWithContext,
  closeSession,
  resumeSession,
} from './session';
export {
  getSession,
  getSteelSessionHealth,
  getSteelSessionCookieSummary,
  closeAllActiveSessions,
} from './sessionInspect';
export { createSteelRecoverySession, buildSteelRecoveryBrowserOptions } from './sessionRecovery';
export { injectUserData } from './injection';
export { uploadFileToSession, listSessionFiles, getFingerprintInjectionData } from './files';
