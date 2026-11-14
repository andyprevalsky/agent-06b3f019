/** STATE MACHINE: delegates Granola connection states to MeetingNotesProviderCard. */
import type { useGranola } from '../hooks/useGranola';
import MeetingNotesProviderCard from './MeetingNotesProviderCard';
export { GranolaIcon } from './MeetingNotesProviderCard';
export default function GranolaSection({ granola }: { granola: ReturnType<typeof useGranola> }) {
  return <MeetingNotesProviderCard provider="granola" connection={granola} />;
}
