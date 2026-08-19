/**
 * STATE MACHINE: SectionToggleButton
 *
 * [MOUNTED] --> renders section action toggle (pure, stateless).
 *
 * Connected state is represented by the section icon glow plus a rose "Connected"
 * label; the plus communicates opening the section to add/manage connected accounts.
 */

import { Plus } from 'lucide-react';

import ConnectedLabel from './ConnectedLabel';

interface SectionToggleButtonProps {
  isConnected: boolean;
  onClick: () => void;
  /** Section name, used to give the icon-only button an accessible name. */
  sectionLabel: string;
}

export default function SectionToggleButton({
  isConnected,
  onClick,
  sectionLabel,
}: SectionToggleButtonProps) {
  return (
    <div className="flex items-center gap-2">
      {isConnected && <ConnectedLabel />}
      <button
        onClick={onClick}
        aria-label={`Manage ${sectionLabel} connections`}
        className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 bg-primary text-primary-foreground hover:bg-primary/90"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}
