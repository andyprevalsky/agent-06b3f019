/**
 * STATE MACHINE: PasswordsSection
 *
 * [COLLAPSED] --toggle--> [EXPANDED] --toggle--> [COLLAPSED]
 *
 * Sub-items (Chrome, Apple Passwords & Passkeys, Atlas):
 *   [IDLE] --click--> [SYNCING/MODAL] --done--> [SYNCED]
 *   Apple Passwords & Passkeys:
 *     [IDLE] --sync icon--> [MODAL] --Sync--> [AUTOFILL_SETTINGS|PASSWORDS_APP]
 *       --OS credential exchange import--> [SYNCED]
 *
 */

import { Button } from '@/components/ui/button';

import chromeIcon from '@/assets/chrome-icon.png';
import chatgptIcon from '@/assets/chatgpt-icon.webp';

import type { PasswordSyncType } from '../types';
import DropdownIconFrame, {
  dropdownIconImageClassName,
  DropdownIconPreset,
} from './DropdownIconFrame';
import PasskeysConnectRow from './PasskeysConnectRow';
import SectionToggleButton from './SectionToggleButton';
import SyncItemButton from './SyncItemButton';

interface PasswordsSectionProps {
  expanded: boolean;
  onToggle: () => void;
  isBrowserCookiesAvailable: boolean;
  isPasskeysAvailable: boolean;
  chromePasswordsSynced: boolean;
  applePasswordsSynced: boolean;
  passkeysSynced: boolean;
  atlasPasswordsSynced: boolean;
  passwordSyncLoading: PasswordSyncType | null;
  onChromeSync: () => void;
  onPasskeysOpen: () => void;
  onAtlasPasswordsOpen: () => void;
}

function KeyIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="url(#keyGradient)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        <linearGradient id="keyGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#fcd34d" />
        </linearGradient>
      </defs>
      <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

function DesktopOnlyRow({ icon, label }: { icon: string; label: string }) {
  return (
    <div className="px-4 py-2 flex items-center justify-between flex-wrap gap-2 border-b border-border/50">
      <div className="flex items-center gap-3">
        <DropdownIconFrame
          {...(label === 'ChatGPT Atlas' ? DropdownIconPreset.atlas : DropdownIconPreset.chrome)}
        >
          <img src={icon} alt={label} className={dropdownIconImageClassName} />
        </DropdownIconFrame>
        <div className="flex items-center gap-2">
          <span className="text-sm">{label}</span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            Desktop Only
          </span>
        </div>
      </div>
      <Button size="sm" variant="outline" asChild>
        <a href="/download">Download for Mac</a>
      </Button>
    </div>
  );
}

function PasswordItemRow({
  icon,
  label,
  isLoading,
  isSynced,
  onClick,
}: {
  icon: string;
  label: string;
  isLoading: boolean;
  isSynced: boolean;
  onClick: () => void;
}) {
  return (
    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
      <div className="flex items-center gap-3">
        <DropdownIconFrame
          {...(label === 'ChatGPT Atlas' ? DropdownIconPreset.atlas : DropdownIconPreset.chrome)}
          isSynced={isSynced}
        >
          <img src={icon} alt={label} className={dropdownIconImageClassName} />
        </DropdownIconFrame>
        <div className="flex min-w-0 items-center">
          <span className="truncate text-sm">{label}</span>
        </div>
      </div>
      <SyncItemButton isLoading={isLoading} isSynced={isSynced} onClick={onClick} />
    </div>
  );
}

function PasswordsExpandedContent(props: Omit<PasswordsSectionProps, 'expanded' | 'onToggle'>) {
  return (
    <div className="border-t border-border">
      {props.isBrowserCookiesAvailable ? (
        <PasswordItemRow
          icon={chromeIcon}
          label="Chrome"
          isLoading={props.passwordSyncLoading === 'chrome'}
          isSynced={props.chromePasswordsSynced}
          onClick={props.onChromeSync}
        />
      ) : (
        <DesktopOnlyRow icon={chromeIcon} label="Chrome" />
      )}
      <PasskeysConnectRow
        isAvailable={props.isPasskeysAvailable}
        isSynced={props.applePasswordsSynced || props.passkeysSynced}
        isLoading={props.passwordSyncLoading === 'passkeys'}
        onConnect={props.onPasskeysOpen}
      />
      {props.isBrowserCookiesAvailable ? (
        <PasswordItemRow
          icon={chatgptIcon}
          label="ChatGPT Atlas"
          isLoading={props.passwordSyncLoading === 'atlas'}
          isSynced={props.atlasPasswordsSynced}
          onClick={props.onAtlasPasswordsOpen}
        />
      ) : (
        <DesktopOnlyRow icon={chatgptIcon} label="ChatGPT Atlas" />
      )}
    </div>
  );
}

export default function PasswordsSection(props: PasswordsSectionProps) {
  const anyPasswordSynced =
    props.chromePasswordsSynced ||
    props.applePasswordsSynced ||
    props.passkeysSynced ||
    props.atlasPasswordsSynced;
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.passwordsMain} isSynced={anyPasswordSynced}>
            <KeyIcon />
          </DropdownIconFrame>
          <div className="flex flex-col">
            <h3 className="font-medium">Passwords</h3>
            <span className="text-xs text-muted-foreground">Auto-fill login credentials</span>
          </div>
        </div>
        <SectionToggleButton isConnected={anyPasswordSynced} onClick={props.onToggle} />
      </div>
      {props.expanded && <PasswordsExpandedContent {...props} />}
    </div>
  );
}
