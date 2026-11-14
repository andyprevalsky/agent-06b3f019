import { createHash } from 'node:crypto';
import type { NormalizedDocumentRow } from '../../domains/integrations/repo.documents';
import type { MeetingRecord, MeetingNotes, MeetingProviderIdentity } from './meetingProvider';

export function meetingSources(provider: string): string[] {
  return [`${provider}_note`, `${provider}_summary`, `${provider}_transcript`];
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function structuredNote(
  provider: MeetingProviderIdentity,
  meeting: MeetingRecord,
  notes: MeetingNotes | undefined
): string {
  const lines = [`# ${meeting.title}`, '', `${provider.label} meeting: ${meeting.id}`];
  lines.push(`Meeting time: ${meeting.meetingAt}`);
  if (meeting.url !== null) lines.push(`${provider.label} link: ${meeting.url}`);
  if (meeting.details !== '') lines.push('', meeting.details);
  // Note responses may repeat listing sections (participants); keep one copy.
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
 * the provider confirms none.
 */
export function meetingDocuments(
  provider: MeetingProviderIdentity,
  meeting: MeetingRecord,
  notes: MeetingNotes | undefined,
  transcript: string | null | undefined
): NormalizedDocumentRow[] {
  const metadata = {
    provider: provider.id,
    meetingId: meeting.id,
    meetingTime: meeting.meetingAt,
  };
  const layers: Array<{ source: string; kind: string; content: string }> = [
    {
      source: `${provider.id}_note`,
      kind: 'note',
      content: structuredNote(provider, meeting, notes),
    },
    { source: `${provider.id}_summary`, kind: 'summary', content: notes?.summary ?? '' },
    { source: `${provider.id}_transcript`, kind: 'transcript', content: transcript ?? '' },
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
