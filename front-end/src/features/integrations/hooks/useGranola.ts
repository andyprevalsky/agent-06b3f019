/** Compatibility hook; state machine lives in useMeetingNotes. */
import { useMeetingNotes } from './useMeetingNotes';
export function useGranola(enabled: boolean, onChange?: () => Promise<void> | void) {
  return useMeetingNotes('granola', enabled, onChange);
}
