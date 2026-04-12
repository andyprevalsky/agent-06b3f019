/**
 * STATE MACHINE: PasswordsSection
 *
 * [COLLAPSED] --toggle--> [EXPANDED] --toggle--> [COLLAPSED]
 *
 * Sub-items (Chrome, Apple, Atlas):
 *   [IDLE] --click--> [SYNCING/MODAL] --done--> [SYNCED]
 *
 * Password request:
 *   [HIDDEN] --click "Request one"--> [INPUT_VISIBLE] --submit--> [SENT]
 */

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

import chromeIcon from '@/assets/chrome-icon.png';
import chatgptIcon from '@/assets/chatgpt-icon.webp';
import applePasswordsIcon from '@/assets/apple-passwords-icon.png';

import type { PasswordSyncType } from '../types';
import SectionToggleButton from './SectionToggleButton';
import SyncItemButton from './SyncItemButton';

interface PasswordsSectionProps {
  expanded: boolean;
  onToggle: () => void;
  isBrowserCookiesAvailable: boolean;
  chromePasswordsSynced: boolean;
  applePasswordsSynced: boolean;
  atlasPasswordsSynced: boolean;
  passwordSyncLoading: PasswordSyncType | null;
  onChromeSync: () => void;
  onApplePasswordsOpen: () => void;
  onAtlasPasswordsOpen: () => void;
  passwordRequestExpanded: boolean;
  onPasswordRequestExpand: () => void;
  passwordRequestInput: string;
  onPasswordRequestInputChange: (value: string) => void;
  passwordRequestSending: boolean;
  passwordRequestSent: boolean;
  onPasswordRequestSubmit: () => void;
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
    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
      <div className="flex items-center gap-3">
        <img
          src={icon}
          alt={label}
          className={`w-6 h-6${label === 'ChatGPT Atlas' ? ' rounded' : ''}`}
        />
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

function PasswordRequestRow({
  expanded,
  onExpand,
  input,
  onInputChange,
  sending,
  sent,
  onSubmit,
}: {
  expanded: boolean;
  onExpand: () => void;
  input: string;
  onInputChange: (v: string) => void;
  sending: boolean;
  sent: boolean;
  onSubmit: () => void;
}) {
  if (!expanded) {
    return (
      <div className="px-4 py-2">
        <button
          onClick={onExpand}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Don't see your password client? <span className="underline">Request one</span> and we'll
          add it in &lt; 1 day
        </button>
      </div>
    );
  }
  if (sent) {
    return (
      <div className="px-4 py-2">
        <p className="text-xs text-green-600 dark:text-green-400">
          Request sent! We'll add the integration within 24 hours.
        </p>
      </div>
    );
  }
  return (
    <div className="px-4 py-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder="e.g., 1Password, Bitwarden, LastPass..."
          disabled={sending}
          className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !sending) onSubmit();
          }}
        />
        <Button
          size="sm"
          variant="default"
          onClick={onSubmit}
          disabled={sending || !input.trim()}
          className="h-7 px-2 text-xs"
        >
          {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Send'}
        </Button>
      </div>
    </div>
  );
}

function PasswordItemRow({
  icon,
  label,
  rounded,
  isLoading,
  isSynced,
  onClick,
}: {
  icon: string;
  label: string;
  rounded?: boolean;
  isLoading: boolean;
  isSynced: boolean;
  onClick: () => void;
}) {
  return (
    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
      <div className="flex items-center gap-3">
        <img src={icon} alt={label} className={`w-6 h-6${rounded ? ' rounded' : ''}`} />
        <span className="text-sm">{label}</span>
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
      <PasswordItemRow
        icon={applePasswordsIcon}
        label="Apple Passwords"
        isLoading={props.passwordSyncLoading === 'apple'}
        isSynced={props.applePasswordsSynced}
        onClick={props.onApplePasswordsOpen}
      />
      {props.isBrowserCookiesAvailable ? (
        <PasswordItemRow
          icon={chatgptIcon}
          label="ChatGPT Atlas"
          rounded
          isLoading={props.passwordSyncLoading === 'atlas'}
          isSynced={props.atlasPasswordsSynced}
          onClick={props.onAtlasPasswordsOpen}
        />
      ) : (
        <DesktopOnlyRow icon={chatgptIcon} label="ChatGPT Atlas" />
      )}
      <PasswordRequestRow
        expanded={props.passwordRequestExpanded}
        onExpand={props.onPasswordRequestExpand}
        input={props.passwordRequestInput}
        onInputChange={props.onPasswordRequestInputChange}
        sending={props.passwordRequestSending}
        sent={props.passwordRequestSent}
        onSubmit={props.onPasswordRequestSubmit}
      />
    </div>
  );
}

export default function PasswordsSection(props: PasswordsSectionProps) {
  const anyPasswordSynced =
    props.chromePasswordsSynced || props.applePasswordsSynced || props.atlasPasswordsSynced;
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
            <KeyIcon />
          </div>
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
