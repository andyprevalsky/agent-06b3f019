// GateRequestCard — renders a Gate (metadata.gate on an AttentionRequest) in the
// attention inbox using the locked design: Rail layout · navi-black rail/border/
// button · white Rose logo · animated thinking dot · CTA + Cancel. Pure render +
// two callbacks (primary / cancel). See
// docs/plans/active/sms-onboarding-and-gates.md and the /gate-playground sandbox.

import { ArrowRight, Check, X } from 'lucide-react';
import { RoseLogo } from '@/components/RoseLogo';
import { ThinkingAnimation } from '@/components/ThinkingAnimation';
import type { GateMetadata } from './types';

const NAVI_BLACK = '#272725';

const BTN =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-sm font-medium transition-transform active:scale-[0.98] disabled:opacity-50';

export function GateRequestCard({
  gate,
  loading,
  onPrimary,
  onCancel,
}: {
  gate: GateMetadata;
  loading: boolean;
  onPrimary: () => void;
  onCancel: () => void;
}): JSX.Element {
  const isReply = gate.action.kind === 'reply';
  return (
    <div
      className="flex overflow-hidden rounded-2xl"
      style={{ border: '1px solid rgb(39 39 37 / 0.37)' }}
    >
      <div
        className="flex shrink-0 items-start justify-center text-white"
        style={{ backgroundColor: NAVI_BLACK, padding: 16 }}
      >
        <RoseLogo size={22} />
      </div>
      <div className="min-w-0 flex-1 bg-card" style={{ padding: 16 }}>
        <div className="flex items-center gap-2">
          <ThinkingAnimation
            dataUrl="/thinking_animations.txt"
            autoplay
            loop
            className="shrink-0"
            style={{ width: 18, height: 18 }}
          />
          <span className="text-sm font-semibold text-foreground">{gate.presentation.title}</span>
        </div>
        <p className="mt-2 text-sm leading-snug text-muted-foreground">
          {gate.presentation.reason}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={onPrimary}
            className={`${BTN} text-white`}
            style={{ backgroundColor: NAVI_BLACK }}
          >
            {isReply && <Check className="h-4 w-4" />}
            {gate.presentation.cta}
            {!isReply && <ArrowRight className="h-4 w-4" />}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className={`${BTN} border border-border text-muted-foreground hover:text-foreground`}
          >
            <X className="h-4 w-4" />
            {isReply ? 'Decline' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
