/**
 * STATE MACHINE: StatusBanners
 *
 * Renders a banner based on agent.status:
 *   PAUSED              --> "Rose has stopped..."
 *   OUT_OF_CREDITS      --> "agent ran out of credits" + Add Credits btn
 *   COST_LIMIT_REACHED  --> "agent cost limit reached" + Increase btn
 *   source=WEB          --> "Preview Mode" + Download link (always at bottom)
 *
 * Completed state is handled by MessageBubble (CompletionSummaryCard).
 */
import type { AgentDetail } from '../hooks';
import { Button } from '@/components/ui/button';

interface StatusBannersProps {
  agent: AgentDetail | null;
  onAddCredits?: () => void;
  onIncreaseCostLimit?: () => void;
}

const BANNER_STYLE: React.CSSProperties = {
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  backgroundColor: 'rgba(255, 255, 255, 0.1)',
};

function PausedBanner() {
  return (
    <div className="flex gap-3">
      <div
        className="flex items-center gap-2 py-1.5 px-3 rounded-full border border-border"
        style={BANNER_STYLE}
      >
        <div className="flex items-center justify-center w-5 h-5 rounded-full border-[1.5px] border-muted-foreground">
          <svg
            className="w-2 h-2 text-muted-foreground"
            fill="currentColor"
            viewBox="0 0 24 24"
          >
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        </div>
        <span className="text-muted-foreground font-medium text-sm">
          Rose has stopped, send a new message to continue
        </span>
      </div>
    </div>
  );
}

function OutOfCreditsBanner({ onAddCredits }: { onAddCredits?: () => void }) {
  return (
    <div className="flex gap-3 items-center">
      <div className="flex items-center gap-3">
        <p className="text-sm text-red-500 dark:text-red-400 font-medium">
          agent ran out of credits
        </p>
        {onAddCredits && (
          <Button size="sm" variant="default" onClick={onAddCredits} className="h-7 text-xs">
            Add Credits
          </Button>
        )}
      </div>
    </div>
  );
}

function CostLimitBanner({ onIncreaseCostLimit }: { onIncreaseCostLimit?: () => void }) {
  return (
    <div className="flex gap-3 items-center">
      <div className="flex items-center gap-3">
        <p className="text-sm text-amber-500 dark:text-amber-400 font-medium">
          agent cost limit reached
        </p>
        {onIncreaseCostLimit && (
          <Button
            size="sm"
            variant="default"
            onClick={onIncreaseCostLimit}
            className="h-7 text-xs"
          >
            Increase Cost Limit
          </Button>
        )}
      </div>
    </div>
  );
}

export function StatusBanners({ agent, onAddCredits, onIncreaseCostLimit }: StatusBannersProps) {
  if (agent?.status === 'PAUSED') return <PausedBanner />;
  if (agent?.status === 'OUT_OF_CREDITS') return <OutOfCreditsBanner onAddCredits={onAddCredits} />;
  if (agent?.status === 'COST_LIMIT_REACHED') {
    return <CostLimitBanner onIncreaseCostLimit={onIncreaseCostLimit} />;
  }
  return null;
}

export function WebPreviewBanner() {
  return (
    <div className="flex gap-3">
      <div
        className="flex items-center gap-2 py-1.5 px-3 rounded-full border border-border"
        style={BANNER_STYLE}
      >
        <span className="text-muted-foreground text-sm">
          Agents spawned via web are in Preview Mode and have restricted functionality. To enable
          all tools
        </span>
        <a
          href="/download"
          className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-foreground text-background hover:opacity-90 transition-opacity"
        >
          Download for Mac
        </a>
      </div>
    </div>
  );
}

export default StatusBanners;
