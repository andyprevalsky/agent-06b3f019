/** Public Granola document API; implementation shared with other meeting providers. */
import { meetingDocuments } from './meetingDocuments';
import type { ListedMeeting, MeetingNotes } from './granolaMcp';
export const GRANOLA_PROVIDER = 'granola';
export const GRANOLA_NOTE_SOURCE = 'granola_note';
export const GRANOLA_SUMMARY_SOURCE = 'granola_summary';
export const GRANOLA_TRANSCRIPT_SOURCE = 'granola_transcript';
export const GRANOLA_SOURCES = [
  GRANOLA_NOTE_SOURCE,
  GRANOLA_SUMMARY_SOURCE,
  GRANOLA_TRANSCRIPT_SOURCE,
] as const;
export function granolaMeetingDocuments(
  meeting: ListedMeeting,
  notes: MeetingNotes | undefined,
  transcript: string | null | undefined
) {
  return meetingDocuments({ id: GRANOLA_PROVIDER, label: 'Granola' }, meeting, notes, transcript);
}
