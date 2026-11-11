/**
 * STATE MACHINE: MeetingNotesSection
 * [MOUNTED] → provider choices; each card owns independent connection/sync state.
 * Integrations → shared category → provider card → useMeetingNotes → mirrored API.
 */
import type { useMeetingNotes } from '../hooks/useMeetingNotes';
import {
  MEETING_NOTES_TITLE,
  MEETING_NOTES_DESCRIPTION,
  MEETING_NOTES_PROVIDERS,
  type MeetingNotesProvider,
} from '../meetingNotes';
import MeetingNotesProviderCard from './MeetingNotesProviderCard';

export type MeetingNotesConnections = Record<
  MeetingNotesProvider,
  ReturnType<typeof useMeetingNotes>
>;

export default function MeetingNotesSection({
  connections,
}: {
  connections: MeetingNotesConnections;
}) {
  return (
    <section aria-label={MEETING_NOTES_TITLE} className="space-y-3">
      <div>
        <h2 className="font-medium">{MEETING_NOTES_TITLE}</h2>
        <p className="text-xs text-muted-foreground">{MEETING_NOTES_DESCRIPTION}</p>
      </div>
      {MEETING_NOTES_PROVIDERS.map((provider) => (
        <MeetingNotesProviderCard
          key={provider}
          provider={provider}
          connection={connections[provider]}
        />
      ))}
    </section>
  );
}
