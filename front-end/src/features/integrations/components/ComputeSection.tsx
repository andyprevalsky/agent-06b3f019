/**
 * STATE MACHINE: ComputeSection
 *
 * [COLLAPSED] --toggle--> [EXPANDED] --toggle--> [COLLAPSED]
 *
 * Sub-items:
 *   Claude: [IDLE] --click--> [SYNCING] --done--> [SYNCED]  (Desktop only)
 *   ChatGPT, Gemini: [COMING_SOON] (static)
 */

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

import claudeIcon from '@/assets/claude-color.svg';
import geminiIcon from '@/assets/gemini-icon.png';

import SectionToggleButton from './SectionToggleButton';
import SyncItemButton from './SyncItemButton';

interface ComputeSectionProps {
  expanded: boolean;
  onToggle: () => void;
  isClaudeCodeAvailable: boolean;
  claudeCodeSynced: boolean;
  claudeCodeSyncLoading: boolean;
  claudeCodeStatus: string | null;
  onClaudeCodeSync: () => void;
}

function ComputeIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
      <defs>
        <linearGradient id="computeGradientIntegrations" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ef4444" />
          <stop offset="100%" stopColor="#f87171" />
        </linearGradient>
      </defs>
      <path
        d="M13 2L4.5 14h6l-1 8L19.5 10h-6l1-8z"
        fill="url(#computeGradientIntegrations)"
        stroke="url(#computeGradientIntegrations)"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChatGPTIcon() {
  return (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

function ClaudeRow({
  isAvailable,
  synced,
  loading,
  onSync,
}: {
  isAvailable: boolean;
  synced: boolean;
  loading: boolean;
  onSync: () => void;
}) {
  if (isAvailable) {
    return (
      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
        <div className="flex items-center gap-3">
          <img src={claudeIcon} alt="Claude" className="w-6 h-6" />
          <span className="text-sm">Claude Subscription</span>
        </div>
        <SyncItemButton isLoading={loading} isSynced={synced} onClick={onSync} />
      </div>
    );
  }
  return (
    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
      <div className="flex items-center gap-3">
        <img src={claudeIcon} alt="Claude" className="w-6 h-6" />
        <div className="flex items-center gap-2">
          <span className="text-sm">Claude Subscription</span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            Desktop Only
          </span>
        </div>
      </div>
      <Button size="sm" variant="ghost" asChild className="h-8 px-2">
        <a href="/download" className="text-xs">
          Get App
        </a>
      </Button>
    </div>
  );
}

export default function ComputeSection({
  expanded,
  onToggle,
  isClaudeCodeAvailable,
  claudeCodeSynced,
  claudeCodeSyncLoading,
  claudeCodeStatus,
  onClaudeCodeSync,
}: ComputeSectionProps) {
  return (
    <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
      <div className="p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
            <ComputeIcon />
          </div>
          <div className="flex flex-col">
            <h3 className="font-medium">Compute</h3>
            <span className="text-xs text-muted-foreground">Connect AI subscriptions</span>
          </div>
        </div>
        <SectionToggleButton isConnected={claudeCodeSynced} onClick={onToggle} />
      </div>
      {claudeCodeSyncLoading && claudeCodeStatus && (
        <div className="px-4 py-2 flex items-center gap-2 border-t border-border/50">
          <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{claudeCodeStatus}</span>
        </div>
      )}
      {expanded && (
        <div className="border-t border-border">
          <ClaudeRow
            isAvailable={isClaudeCodeAvailable}
            synced={claudeCodeSynced}
            loading={claudeCodeSyncLoading}
            onSync={onClaudeCodeSync}
          />
          <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
            <div className="flex items-center gap-3">
              <ChatGPTIcon />
              <span className="text-sm">ChatGPT Subscription</span>
            </div>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              Coming Soon
            </span>
          </div>
          <div className="px-4 py-2 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={geminiIcon} alt="Gemini" className="w-6 h-6" />
              <span className="text-sm">Gemini Subscription</span>
            </div>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              Coming Soon
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
