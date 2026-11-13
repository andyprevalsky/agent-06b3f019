/** STATE MACHINE: delegates Fireflies callback states to MeetingNotesCallback. */
import MeetingNotesCallback from './MeetingNotesCallback';
export default function FirefliesCallback() {
  return <MeetingNotesCallback provider="fireflies" />;
}
