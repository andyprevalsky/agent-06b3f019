/**
 * STATE MACHINE: SectionToggleButton
 *
 * [MOUNTED] --> renders section action toggle (pure, stateless).
 *
 * Connected state is represented by the section icon glow; the plus communicates
 * opening the section to add/manage connected accounts.
 */

import { Plus } from 'lucide-react';

interface SectionToggleButtonProps {
  isConnected: boolean;
  onClick: () => void;
}

export default function SectionToggleButton({ onClick }: SectionToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 bg-primary text-primary-foreground hover:bg-primary/90"
    >
      <Plus className="w-4 h-4" />
    </button>
  );
}
