/**
 * Typed access to the Mac-app IPC bridge exposed on `window.api`.
 *
 * The Electron preload script injects this object when Rose is running in the
 * Mac app. In the web build it is `undefined`. We keep the surface area we
 * actually use narrow to avoid a blanket `any`.
 */

export interface SendIMessageArgs {
  to: string;
  message: string;
}

export interface SendIMessageResult {
  success?: boolean;
  message?: string;
}

export interface MacAppBridge {
  sendIMessage?: (args: SendIMessageArgs) => Promise<SendIMessageResult>;
}

interface WindowWithBridge {
  api?: MacAppBridge;
}

/** Returns the Mac-app IPC bridge if we're running inside Electron. */
export function getMacAppBridge(): MacAppBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as WindowWithBridge).api;
}
