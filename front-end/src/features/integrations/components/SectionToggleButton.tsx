/**
 * STATE MACHINE: SectionToggleButton
 *
 * [MOUNTED] --> renders section action toggle (pure, stateless).
 *
 * Connected state is represented by the section icon glow, so this action icon
 * remains stable instead of becoming a status checkmark.
 */

import { RefreshCw } from 'lucide-react';

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
      <RefreshCw className="w-4 h-4" />
    </button>
  );
}
