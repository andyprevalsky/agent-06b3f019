/**
 * Steel provider — browser session management via Steel.dev API.
 */

export { SteelRateLimitError } from "./types";
export type { SteelFileInfo } from "./types";
export {
  getOrCreateContext,
  createSessionWithContext,
  closeSession,
  resumeSession,
  getSession,
  closeAllActiveSessions,
} from "./session";
export { injectUserData } from "./injection";
export { uploadFileToSession, listSessionFiles, getFingerprintInjectionData } from "./files";
