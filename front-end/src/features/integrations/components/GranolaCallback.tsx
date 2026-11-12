/** STATE MACHINE: delegates Granola callback states to MeetingNotesCallback. */
import MeetingNotesCallback from './MeetingNotesCallback';
export default function GranolaCallback() {
  return <MeetingNotesCallback provider="granola" />;
}
