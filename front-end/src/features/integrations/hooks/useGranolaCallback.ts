/** Compatibility hook; state machine lives in useMeetingNotesCallback. */
import { useMeetingNotesCallback } from './useMeetingNotesCallback';
export type { MeetingNotesCallbackState as GranolaCallbackState } from './useMeetingNotesCallback';
export const useGranolaCallback = () => useMeetingNotesCallback('granola');
