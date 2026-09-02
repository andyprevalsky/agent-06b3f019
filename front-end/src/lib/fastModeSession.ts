/**
 * Session-only Fast Mode preference shared by the chat query box and Settings.
 * Never written to disk; a null override means "use the account default".
 */

type Listener = () => void;

let override: boolean | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getFastModeSessionOverride(): boolean | null {
  return override;
}

export function setFastModeSessionOverride(enabled: boolean): void {
  override = enabled;
  notify();
}

export function subscribeFastModeSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: drop the in-memory override so suites do not leak across files. */
export function resetFastModeSessionOverride(): void {
  override = null;
  notify();
}
