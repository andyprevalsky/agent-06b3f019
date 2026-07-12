// GateRequestCard — renders a Gate (metadata.gate on an AttentionRequest) in the
// attention inbox using the locked design: Rail layout · navi-black rail/border/
// button · white Rose logo · animated thinking dot · CTA + Cancel. Pure render +
// two callbacks (primary / cancel). See
// docs/plans/active/sms-onboarding-and-gates.md and the /gate-playground sandbox.

import { ArrowRight, Check, X } from 'lucide-react';
import { ThinkingAnimation } from '@/components/ThinkingAnimation';
import type { GateMetadata } from './types';

const NAVI_BLACK = '#272725';

/** Rose mark (public/social/rose-svf-logo.svg) inlined so it inherits color. */
function RoseLogo({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <svg viewBox="21 62 220 222" width={size} height={size} fill="currentColor" aria-hidden="true">
      <g transform="translate(0,303) scale(0.1,-0.1)">
        <path d="M1276 2378 c-145 -192 -231 -442 -211 -616 8 -68 41 -202 61 -251 8 -19 13 -35 11 -37 -2 -2 -30 7 -62 21 -249 100 -537 54 -784 -124 -36 -25 -69 -49 -75 -53 -17 -11 22 -46 119 -105 163 -101 300 -144 460 -144 92 -1 226 24 301 56 20 8 38 15 39 15 2 0 -10 -39 -25 -87 -69 -213 -58 -395 36 -600 31 -69 136 -237 154 -248 10 -6 114 144 152 220 37 73 75 199 88 293 14 101 1 206 -40 330 -15 48 -27 88 -26 89 1 2 26 -7 55 -18 195 -74 423 -66 611 22 98 46 217 118 245 149 18 20 18 21 -1 35 -177 139 -396 225 -570 225 -79 0 -195 -23 -282 -56 -44 -16 -63 -20 -59 -11 27 72 60 196 68 260 17 132 -17 300 -89 442 -36 72 -124 209 -141 219 -5 4 -21 -8 -35 -26z m40 -935 c7 -46 50 -92 109 -119 27 -13 41 -23 31 -23 -11 -1 -38 -12 -62 -26 -49 -29 -83 -90 -85 -151 -1 -37 -2 -36 -9 13 -4 29 -17 67 -28 85 -22 35 -86 77 -118 79 -11 0 1 9 26 20 79 35 118 90 121 168 1 25 3 28 6 11 2 -14 6 -39 9 -57z" />
      </g>
    </svg>
  );
}

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
