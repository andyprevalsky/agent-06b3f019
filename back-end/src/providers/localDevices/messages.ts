/**
 * Exact user-facing text for local (Mac) code-agent runs (rose-builds-rose.md
 * C14). Shown in the code-agent chip's red failure box and returned as the tool
 * error. The agents worker formats the same templates
 * (agents/domains/spawn_claude_code_agent/config.py); its blackbox
 * code_agent_local_target asserts the two never drift.
 */

export const LOCAL_TARGET_UNAVAILABLE_CODE = 'LOCAL_TARGET_UNAVAILABLE';

export type LocalTargetReason =
  'not_mac_origin' | 'device_disconnected' | 'no_folder_granted' | 'no_own_credentials';

export const LOCAL_TARGET_NOT_MAC_ORIGIN: LocalTargetReason = 'not_mac_origin';
export const LOCAL_TARGET_DEVICE_DISCONNECTED: LocalTargetReason = 'device_disconnected';
/** Not in the C14 spec text: copy for review at /deploy. */
export const LOCAL_TARGET_NO_FOLDER_GRANTED: LocalTargetReason = 'no_folder_granted';
/** Not in the C14 spec text: copy for review at /deploy. */
export const LOCAL_TARGET_NO_OWN_CREDENTIALS: LocalTargetReason = 'no_own_credentials';

/** Only when a Mac-origin agent's device row has no name. */
export const UNKNOWN_DEVICE_NAME = 'your Mac';

export const LOCAL_TARGET_NOT_MAC_ORIGIN_MESSAGE =
  'Local runs need an agent started from the Rose Mac app. Start this agent from the Mac app, or run it in the cloud.';

export function localTargetDisconnectedMessage(deviceName: string | null | undefined): string {
  return disconnectedTemplate(displayName(deviceName));
}

function disconnectedTemplate(deviceName: string): string {
  return `Can't run locally: the Rose Mac app on ${deviceName} is closed or disconnected. Open the Rose Mac app and retry, or run this agent in the cloud.`;
}

function displayName(deviceName: string | null | undefined): string {
  return deviceName !== null && deviceName !== undefined && deviceName !== ''
    ? deviceName
    : UNKNOWN_DEVICE_NAME;
}

export function localTargetError(
  reason: LocalTargetReason,
  deviceName: string | null | undefined,
  providerLabel = 'Claude Code'
): string {
  switch (reason) {
    case 'not_mac_origin':
      return LOCAL_TARGET_NOT_MAC_ORIGIN_MESSAGE;
    case 'no_folder_granted':
      return `Can't run locally: no folder on ${displayName(deviceName)} is shared with Rose. Share a folder in the Rose Mac app and retry, or run this agent in the cloud.`;
    case 'no_own_credentials':
      return `Can't run locally: Rose has no ${providerLabel} login of yours to use on ${displayName(deviceName)}. Connect ${providerLabel} in the Rose Mac app and retry, or run this agent in the cloud.`;
    case 'device_disconnected':
      return localTargetDisconnectedMessage(deviceName);
  }
}

/** 409 body the worker maps to a non-retryable tool error with `error` verbatim. */
export function localTargetUnavailableBody(error: LocalTargetUnavailableError): {
  code: typeof LOCAL_TARGET_UNAVAILABLE_CODE;
  reason: LocalTargetReason;
  device_name: string | null;
  error: string;
} {
  return {
    code: LOCAL_TARGET_UNAVAILABLE_CODE,
    reason: error.reason,
    device_name: error.deviceName,
    error: error.message,
  };
}

/**
 * Raised by the session-create path when the Mac cannot run the session now.
 * Routes answer 409 `{ code: LOCAL_TARGET_UNAVAILABLE, reason, device_name, error }`
 * and the worker surfaces `error` verbatim without retrying.
 */
export class LocalTargetUnavailableError extends Error {
  constructor(
    public readonly reason: LocalTargetReason,
    public readonly deviceName: string | null,
    message: string = localTargetError(reason, deviceName)
  ) {
    super(message);
    this.name = 'LocalTargetUnavailableError';
  }
}
