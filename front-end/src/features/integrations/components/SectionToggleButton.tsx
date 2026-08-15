/**
 * STATE MACHINE: SectionToggleButton
 *
 * [MOUNTED] --> renders section action toggle (pure, stateless).
 *
 * Connected state is represented by the section icon glow plus a rose "Connected"
 * label; the plus communicates opening the section to add/manage connected accounts.
 */

import { Plus } from 'lucide-react';

interface SectionToggleButtonProps {
  isConnected: boolean;
  onClick: () => void;
}

export default function SectionToggleButton({ isConnected, onClick }: SectionToggleButtonProps) {
  return (
    <div className="flex items-center gap-2">
      {isConnected && (
        <span className="bg-gradient-to-bl from-[#FE7503] via-[#FD5776] to-[#7A6BEC] bg-clip-text text-xs font-medium text-transparent">
          Connected
        </span>
      )}
      <button
        onClick={onClick}
        className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 bg-primary text-primary-foreground hover:bg-primary/90"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
