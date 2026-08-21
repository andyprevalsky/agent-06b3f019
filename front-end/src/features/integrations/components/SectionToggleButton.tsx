/**
 * STATE MACHINE: SectionToggleButton
 *
 * [MOUNTED] --> renders section action toggle (pure, stateless).
 *
 *   isConnected && !needsReconnection --> rose "Connected"
 *   isConnected &&  needsReconnection --> amber "Needs Reconnection" + warning icon
 *   !isConnected                      --> no label
 *
 * Connected state is represented by the section icon glow plus the label; the
 * plus communicates opening the section to add/manage connected accounts.
 */

import { AlertTriangle, Plus } from 'lucide-react';

interface SectionToggleButtonProps {
  isConnected: boolean;
  /**
   * At least one account in this section is damaged. Takes precedence over the
   * connected label: "Connected" next to a broken account is a lie, and it is
   * the whole reason a user cannot tell that their email stopped syncing.
   */
  needsReconnection?: boolean;
  onClick: () => void;
  /** Section name, used to give the icon-only button an accessible name. */
  sectionLabel: string;
}

export default function SectionToggleButton({
  isConnected,
  needsReconnection = false,
  onClick,
  sectionLabel,
}: SectionToggleButtonProps) {
  return (
    <div className="flex items-center gap-2">
      {isConnected &&
        (needsReconnection ? (
          <span className="flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            Needs Reconnection
          </span>
        ) : (
          <span className="bg-gradient-to-bl from-[#FE7503] via-[#FD5776] to-[#7A6BEC] bg-clip-text text-xs font-medium text-transparent">
            Connected
          </span>
        ))}
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
