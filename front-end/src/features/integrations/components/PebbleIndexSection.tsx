/**
 * STATE MACHINE: PebbleIndexSection
 *
 * System context:
 *   Integrations page -> IntegrationSections -> PebbleIndexSection
 *     --plus click--> onConnect (Integrations opens PebbleIndexSetupModal)
 *
 * Last stock card. There is no sync state: the Index 01 ring posts to Rose's
 * webhook directly, so this card only launches the guided setup.
 */

import { Plus } from 'lucide-react';

import pebbleIndexIcon from '@/assets/pebble-index-icon.png';

import DropdownIconFrame, {
  DropdownIconPreset,
  dropdownIconImageClassName,
} from './DropdownIconFrame';

interface PebbleIndexSectionProps {
  onConnect: () => void;
}

export function PebbleIndexIcon() {
  return (
    <img src={pebbleIndexIcon} alt="" aria-hidden="true" className={dropdownIconImageClassName} />
  );
}

export default function PebbleIndexSection({ onConnect }: PebbleIndexSectionProps) {
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.pebbleIndex}>
            <PebbleIndexIcon />
          </DropdownIconFrame>
          <div className="flex min-w-0 flex-col">
            <h3 className="truncate font-medium">Pebble Index 01</h3>
            <span className="truncate text-xs text-muted-foreground">
              Every voice note becomes a Rose agent
            </span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Connect Pebble Index 01"
          onClick={onConnect}
          className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
