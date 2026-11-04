/**
 * Granola meeting → normalized grep documents.
 *
 * One Granola meeting becomes up to three `UserDataDocument` rows, so an agent
 * can grep one layer or all of them:
 *
 *   granola_note        structured record: title, time, link, participants and
 *                       every non-summary section of the note (own notes, …)
 *   granola_summary     Granola's AI summary
 *   granola_transcript  the raw transcript, verbatim
 *
 * `document_source: "granola"` matches all three (GRANOLA_SOURCES). Every row
 * keys on the Granola meeting id, so a re-sync overwrites in place.
 */

import { createHash } from 'node:crypto';
import type { NormalizedDocumentRow } from '../../domains/integrations/repo.documents';
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

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function structuredNote(meeting: ListedMeeting, notes: MeetingNotes | undefined): string {
  const lines = [`# ${meeting.title}`, '', `Granola meeting: ${meeting.id}`];
  lines.push(`Meeting time: ${meeting.meetingAt}`);
  if (meeting.url !== null) lines.push(`Granola link: ${meeting.url}`);
  if (meeting.details !== '') lines.push('', meeting.details);
  // get_meetings repeats the listing's sections (participants); keep one copy.
  const listed = new Set(meeting.details.split('\n\n'));
  const rest = (notes?.rest ?? '')
    .split('\n\n')
    .filter((section) => section !== '' && !listed.has(section))
    .join('\n\n');
  if (rest !== '') lines.push('', rest);
  return lines.join('\n');
}

/**
 * The grep documents for one meeting; empty layers are omitted. `transcript`
 * undefined means "not fetched this run" (the stored layer is kept), null means
 * Granola has none.
 */
export function granolaMeetingDocuments(
  meeting: ListedMeeting,
  notes: MeetingNotes | undefined,
  transcript: string | null | undefined
): NormalizedDocumentRow[] {
  const metadata = {
    provider: GRANOLA_PROVIDER,
    meetingId: meeting.id,
    meetingTime: meeting.meetingAt,
  };
  const layers: Array<{ source: string; kind: string; content: string }> = [
    { source: GRANOLA_NOTE_SOURCE, kind: 'note', content: structuredNote(meeting, notes) },
    { source: GRANOLA_SUMMARY_SOURCE, kind: 'summary', content: notes?.summary ?? '' },
    { source: GRANOLA_TRANSCRIPT_SOURCE, kind: 'transcript', content: transcript ?? '' },
  ];
  return layers
    .filter((layer) => layer.content.trim() !== '')
    .map((layer) => ({
      source: layer.source,
      externalId: meeting.id,
      title: meeting.title,
      content: layer.content,
      url: meeting.url ?? undefined,
      metadata: { ...metadata, kind: layer.kind },
      sourceUpdatedAt: new Date(meeting.meetingAt),
      contentHash: hash(layer.content),
    }));
}
