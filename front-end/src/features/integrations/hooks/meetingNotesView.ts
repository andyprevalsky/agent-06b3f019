/** Shared meeting status text for cards and Desktop rows. */
import type { MeetingNotesProvider, MeetingNotesConnection } from '../types';
import { meetingNotesProviders } from '../config';

export function meetingNotesDetail(
  connection: MeetingNotesConnection,
  provider: MeetingNotesProvider,
): string {
  const { name, meetingDocument } = meetingNotesProviders[provider];
  const { status } = connection;
  if (status === null) return 'Loading...';
  if (connection.busy === 'connect') return `Finish signing in to ${name}...`;
  if (!status.connected) return 'Search your meeting notes, summaries and transcripts';
  if (status.status === 'EXPIRED') return `${name} sign-in expired. Reconnect to keep syncing.`;
  if (status.status === 'SYNC_FAILED') return `Last sync failed: ${status.lastError ?? 'unknown'}`;
  const meetings = status.documents[meetingDocument] ?? 0;
  const synced = `${meetings} meeting${meetings === 1 ? '' : 's'} synced`;
  return status.backfillDone ? synced : `${synced}, importing older meetings...`;
}
