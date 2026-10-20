/**
 * STATE MACHINE: SocialsSection
 *
 * [COLLAPSED] --toggle--> [EXPANDED] --toggle--> [COLLAPSED]
 *
 * Sub-items:
 *   LinkedIn (Desktop only; state is the server's `linkedin` integration row):
 *     [IDLE | SYNC_FAILED] --click--> [SPAWNING] --agent recorded--> [SYNCING]
 *     [SPAWNING] --spawn fails--> [IDLE] (retryable)
 *     [SYNCING] --export agent uploads--> [CONNECTED]
 *     [SYNCING] --export agent ends without uploading--> [SYNC_FAILED]
 *     SYNCING shows "Connecting your data…" across refreshes; SYNCING and
 *     CONNECTED light the rose glow and block re-export.
 *   X, Instagram: [COMING_SOON] (static)
 */

import { Loader2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

import DropdownIconFrame, { DropdownIconPreset } from './DropdownIconFrame';
import SectionToggleButton from './SectionToggleButton';

interface SocialsSectionProps {
  expanded: boolean;
  onToggle: () => void;
  isBrowserCookiesAvailable: boolean;
  linkedinSyncLoading: boolean;
  linkedinSyncStarted: boolean;
  linkedinConnected: boolean;
  onLinkedInSync: () => void;
}

function SocialsIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
      <defs>
        <linearGradient id="socialsGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <circle cx="5" cy="12" r="2.5" fill="url(#socialsGradient)" />
      <circle cx="19" cy="5" r="2.5" fill="url(#socialsGradient)" />
      <circle cx="19" cy="19" r="2.5" fill="url(#socialsGradient)" />
      <line x1="7.5" y1="11" x2="16.5" y2="6" stroke="url(#socialsGradient)" strokeWidth="1.5" />
      <line x1="7.5" y1="13" x2="16.5" y2="18" stroke="url(#socialsGradient)" strokeWidth="1.5" />
    </svg>
  );
}

export function XIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24">
      <rect width="24" height="24" rx="5" fill="#000000" className="dark:fill-[#d6d6d2]" />
      <path
        fill="white"
        className="dark:fill-[#262624]"
        d="M13.3 10.75L18.18 5h-1.16l-4.23 4.99L9.26 5H5l5.11 7.55L5 19h1.16l4.47-5.27L14.74 19H19l-5.7-8.25zm-1.58 1.87l-.52-.75L6.68 5.92h1.77l3.32 4.83.52.75 4.33 6.29h-1.77l-3.53-5.17z"
        transform="scale(0.72) translate(4.7, 4.7)"
      />
    </svg>
  );
}

export function LinkedInIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24">
      <rect width="24" height="24" rx="5" fill="#0A66C2" />
      <path
        fill="white"
        d="M8.34 18H5.66V9.75h2.68V18zM7 8.62a1.56 1.56 0 1 1 0-3.12 1.56 1.56 0 0 1 0 3.12zM18.34 18h-2.67v-4.02c0-.96-.02-2.19-1.33-2.19-1.34 0-1.54 1.04-1.54 2.12V18h-2.68V9.75h2.57v1.12h.04c.36-.68 1.23-1.39 2.53-1.39 2.7 0 3.2 1.78 3.2 4.1V18z"
        transform="scale(0.85) translate(2.1, 2.1)"
      />
    </svg>
  );
}

export function InstagramIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24">
      <defs>
        <linearGradient id="igGrad" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#FFDC80" />
          <stop offset="25%" stopColor="#F77737" />
          <stop offset="50%" stopColor="#E1306C" />
          <stop offset="75%" stopColor="#C13584" />
          <stop offset="100%" stopColor="#833AB4" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="5" fill="url(#igGrad)" />
      <rect
        x="6"
        y="6"
        width="12"
        height="12"
        rx="3.5"
        stroke="white"
        strokeWidth="1.5"
        fill="none"
      />
      <circle cx="12" cy="12" r="3" stroke="white" strokeWidth="1.5" fill="none" />
      <circle cx="16.5" cy="7.5" r="1" fill="white" />
    </svg>
  );
}

const COMING_SOON_BADGE = (
  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
    Coming Soon
  </span>
);

function LinkedInRow({
  isAvailable,
  loading,
  started,
  connected,
  onSync,
}: {
  isAvailable: boolean;
  loading: boolean;
  started: boolean;
  connected: boolean;
  onSync: () => void;
}) {
  if (!isAvailable) {
    return (
      <div className="px-4 py-2 flex items-center justify-between flex-wrap gap-2 border-b border-border/50">
        <div className="flex items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.linkedin}>
            <LinkedInIcon />
          </DropdownIconFrame>
          <div className="flex items-center gap-2">
            <span className="text-sm">LinkedIn</span>
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
  return (
    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
      <div className="flex items-center gap-3">
        <DropdownIconFrame {...DropdownIconPreset.linkedin} isSynced={started || connected}>
          <LinkedInIcon />
        </DropdownIconFrame>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm">LinkedIn</span>
          {started && (
            <span className="bg-gradient-to-bl from-[#FE7503] via-[#FD5776] to-[#7A6BEC] bg-clip-text text-[11px] font-medium leading-none text-transparent">
              Connecting your data…
            </span>
          )}
        </div>
      </div>
      <button
        onClick={onSync}
        disabled={loading || started || connected}
        aria-label="Connect LinkedIn"
        className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground disabled:opacity-60 disabled:hover:bg-muted disabled:hover:text-muted-foreground"
      >
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Plus className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}

export default function SocialsSection({
  expanded,
  onToggle,
  isBrowserCookiesAvailable,
  linkedinSyncLoading,
  linkedinSyncStarted,
  linkedinConnected,
  onLinkedInSync,
}: SocialsSectionProps) {
  const linkedinActive = linkedinSyncStarted || linkedinConnected;
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DropdownIconFrame {...DropdownIconPreset.socialsMain} isSynced={linkedinActive}>
            <SocialsIcon />
          </DropdownIconFrame>
          <div className="flex flex-col">
            <h3 className="font-medium">Socials</h3>
            <span className="text-xs text-muted-foreground">Connect social media accounts</span>
          </div>
        </div>
        <SectionToggleButton
          isConnected={linkedinActive}
          onClick={onToggle}
          sectionLabel="Socials"
        />
      </div>
      {expanded && (
        <div className="border-t border-border">
          <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
            <div className="flex items-center gap-3">
              <DropdownIconFrame {...DropdownIconPreset.x}>
                <XIcon />
              </DropdownIconFrame>
              <span className="text-sm">X</span>
            </div>
            {COMING_SOON_BADGE}
          </div>
          <LinkedInRow
            isAvailable={isBrowserCookiesAvailable}
            loading={linkedinSyncLoading}
            started={linkedinSyncStarted}
            connected={linkedinConnected}
            onSync={onLinkedInSync}
          />
          <div className="px-4 py-2 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <DropdownIconFrame {...DropdownIconPreset.instagram}>
                <InstagramIcon />
              </DropdownIconFrame>
              <span className="text-sm">Instagram</span>
            </div>
            {COMING_SOON_BADGE}
          </div>
        </div>
      )}
    </div>
  );
}
