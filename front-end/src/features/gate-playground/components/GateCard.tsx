// GateCard — the component under design. Pure/stateless: given a content preset
// and a GateDesign token bundle, it renders one of several layout variants with
// every slider/toggle applied via inline style so the preview updates live.
//
// Layouts split into a "card family" (roomy, always room for a receipt /
// breakdown — the important case for payment approvals) and compact alternates:
//   card_*  → card · card_header · card_rail · card_split · card_hero
//   compact → inline · banner · chip
// All card_* share Header + Body(reason+receipt) + Cta with one spacing rhythm
// (header → mt-3 body → mt-4 cta); they differ only in framing/chrome.
//
// Brand chrome (fixed, not accent-driven): the icon is ALWAYS the Rose logo, the
// icon chip / rail column is ALWAYS navi-black, and the filled/primary button is
// navi-black. The accent only colors the status dot, borders, and banner/inline
// tints. No network, no real actions.

import type { CSSProperties } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ThinkingAnimation } from '@/components/ThinkingAnimation';
import {
  ACCENTS,
  formatCents,
  ROSE_GRADIENT,
  type AccentDef,
  type GateDesign,
  type GatePreset,
} from '../presets';

/** navi-black brand color (tailwind.config.ts). */
const NAVI_BLACK = '#272725';

const SHADOWS = [
  'none',
  '0 4px 20px -4px rgb(15 23 42 / 0.10)',
  '0 10px 30px -10px rgb(15 23 42 / 0.20)',
  '0 25px 50px -12px rgb(15 23 42 / 0.30)',
];

const tint = (a: AccentDef, pct: number): string => `rgb(${a.rgb} / ${pct}%)`;

/** Rose mark (public/social/rose-svf-logo.svg) inlined so it can inherit color. */
function RoseLogo({ size = 20, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      viewBox="21 62 220 222"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <g transform="translate(0,303) scale(0.1,-0.1)">
        <path d="M1276 2378 c-145 -192 -231 -442 -211 -616 8 -68 41 -202 61 -251 8 -19 13 -35 11 -37 -2 -2 -30 7 -62 21 -249 100 -537 54 -784 -124 -36 -25 -69 -49 -75 -53 -17 -11 22 -46 119 -105 163 -101 300 -144 460 -144 92 -1 226 24 301 56 20 8 38 15 39 15 2 0 -10 -39 -25 -87 -69 -213 -58 -395 36 -600 31 -69 136 -237 154 -248 10 -6 114 144 152 220 37 73 75 199 88 293 14 101 1 206 -40 330 -15 48 -27 88 -26 89 1 2 26 -7 55 -18 195 -74 423 -66 611 22 98 46 217 118 245 149 18 20 18 21 -1 35 -177 139 -396 225 -570 225 -79 0 -195 -23 -282 -56 -44 -16 -63 -20 -59 -11 27 72 60 196 68 260 17 132 -17 300 -89 442 -36 72 -124 209 -141 219 -5 4 -21 -8 -35 -26z m40 -935 c7 -46 50 -92 109 -119 27 -13 41 -23 31 -23 -11 -1 -38 -12 -62 -26 -49 -29 -83 -90 -85 -151 -1 -37 -2 -36 -9 13 -4 29 -17 67 -28 85 -22 35 -86 77 -118 79 -11 0 1 9 26 20 79 35 118 90 121 168 1 25 3 28 6 11 2 -14 6 -39 9 -57z" />
      </g>
    </svg>
  );
}

function ctaStyle(design: GateDesign): CSSProperties {
  const a = ACCENTS[design.accent];
  const borderRadius = Math.min(design.radius, 12);
  if (design.buttonStyle === 'gradient') {
    return { backgroundImage: ROSE_GRADIENT, color: '#fff', borderRadius };
  }
  if (design.buttonStyle === 'filled') {
    // Primary / approve button is always navi-black.
    return { backgroundColor: NAVI_BLACK, color: '#fff', borderRadius };
  }
  return {
    backgroundColor: 'transparent',
    color: a.dot,
    border: `1px solid rgb(${a.rgb} / 0.55)`,
    borderRadius,
  };
}

const BTN_BASE =
  'inline-flex h-9 items-center justify-center gap-1.5 px-4 text-sm font-medium transition-transform active:scale-[0.98]';

/** Secondary dismiss button — every gate can be cancelled. */
function CancelButton({ design, label }: { design: GateDesign; label: string }): JSX.Element {
  return (
    <button
      type="button"
      className={cn(BTN_BASE, 'border border-border text-muted-foreground hover:text-foreground')}
      style={{ borderRadius: Math.min(design.radius, 12) }}
    >
      <X className="h-4 w-4" />
      {label}
    </button>
  );
}

function Cta({
  design,
  preset,
  block = false,
}: {
  design: GateDesign;
  preset: GatePreset;
  block?: boolean;
}): JSX.Element {
  const isReply = preset.actionKind === 'reply';
  return (
    <div className={cn('flex items-center gap-2', block && 'w-full')}>
      <button type="button" className={cn(BTN_BASE, block && 'flex-1')} style={ctaStyle(design)}>
        {isReply && <Check className="h-4 w-4" />}
        {preset.cta}
        {!isReply && <ArrowRight className="h-4 w-4" />}
      </button>
      <CancelButton design={design} label={isReply ? 'Decline' : 'Cancel'} />
    </div>
  );
}

/** Accent dot — the animated Rose "thinking" indicator (agent paused, waiting on you). */
function StatusDot({ design }: { design: GateDesign }): JSX.Element | null {
  if (!design.showStatusDot) return null;
  return (
    <ThinkingAnimation
      dataUrl="/thinking_animations.txt"
      autoplay
      loop
      className="shrink-0"
      style={{ width: 18, height: 18 }}
    />
  );
}

/** Icon chip — always navi-black with the white Rose logo. */
function GateIcon({
  design,
  box = 34,
  icon = 18,
}: {
  design: GateDesign;
  box?: number;
  icon?: number;
}): JSX.Element | null {
  if (!design.showIcon) return null;
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg text-white"
      style={{ backgroundColor: NAVI_BLACK, width: box, height: box }}
    >
      <RoseLogo size={icon} />
    </span>
  );
}

function Receipt({ preset }: { preset: GatePreset }): JSX.Element | null {
  const r = preset.receipt;
  if (!r) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="truncate font-medium">{r.merchant}</span>
        <span className="font-semibold">{formatCents(r.totalCents)}</span>
      </div>
      <div className="space-y-1.5">
        {r.lines.map((item) => (
          <div key={item.name} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-foreground">{item.name}</span>
            <span className="shrink-0 text-muted-foreground">
              ×{item.qty} · {formatCents(item.lineCents)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 space-y-1 border-t border-border pt-2 text-muted-foreground">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatCents(r.subtotalCents)}</span>
        </div>
        {r.fees.map((fee) => (
          <div key={fee.label} className="flex justify-between">
            <span>{fee.label}</span>
            <span>{formatCents(fee.amountCents)}</span>
          </div>
        ))}
        <div className="flex justify-between pt-0.5 font-semibold text-foreground">
          <span>Total</span>
          <span>{formatCents(r.totalCents)}</span>
        </div>
      </div>
    </div>
  );
}

/** reason + receipt, single spacing rhythm. Returns null when there's nothing. */
function Body({ design, preset }: { design: GateDesign; preset: GatePreset }): JSX.Element | null {
  const hasReason = design.showReason;
  if (!hasReason && !preset.receipt) return null;
  return (
    <div className="space-y-3">
      {hasReason && <p className="text-sm leading-snug text-muted-foreground">{preset.reason}</p>}
      <Receipt preset={preset} />
    </div>
  );
}

function Title({ preset }: { preset: GatePreset }): JSX.Element {
  return <span className="text-sm font-semibold text-foreground">{preset.title}</span>;
}

function borderRule(design: GateDesign): string {
  // Border is always navi-black (rgb 39 39 37); emphasis controls weight/opacity.
  const width = design.borderEmphasis === 2 ? 2 : 1;
  const alpha = 0.15 + design.borderEmphasis * 0.22;
  return `${width}px solid rgb(39 39 37 / ${alpha})`;
}

export function GateCard({
  design,
  preset,
}: {
  design: GateDesign;
  preset: GatePreset;
}): JSX.Element {
  const a = ACCENTS[design.accent];
  const pad = design.padding;
  const widthClass = design.fullWidth ? 'w-full' : 'inline-block max-w-[85%]';

  // ── CHIP (compact) ────────────────────────────────────────────────────────
  if (design.variant === 'chip') {
    return (
      <div
        className="inline-flex max-w-full items-center gap-2.5 bg-card"
        style={{
          borderRadius: design.radius,
          padding: `${Math.max(6, pad * 0.5)}px ${pad * 0.75}px`,
          border: borderRule(design),
          boxShadow: SHADOWS[design.elevation],
        }}
      >
        <GateIcon design={design} box={26} icon={14} />
        <StatusDot design={design} />
        <span className="truncate text-sm font-medium text-foreground">{preset.title}</span>
        <span className="ml-1">
          <Cta design={design} preset={preset} />
        </span>
      </div>
    );
  }

  // ── BANNER (compact) ──────────────────────────────────────────────────────
  if (design.variant === 'banner') {
    return (
      <div
        className={cn(widthClass, 'flex items-center gap-3')}
        style={{
          borderRadius: design.radius,
          padding: pad,
          background: tint(a, design.accentIntensity),
          border: borderRule(design),
          boxShadow: SHADOWS[design.elevation],
        }}
      >
        <GateIcon design={design} box={40} icon={20} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot design={design} />
            <Title preset={preset} />
          </div>
          {design.showReason && (
            <p className="text-sm leading-snug text-muted-foreground">{preset.reason}</p>
          )}
        </div>
        <div className="shrink-0">
          <Cta design={design} preset={preset} />
        </div>
      </div>
    );
  }

  // ── INLINE (compact, accent left bar) ─────────────────────────────────────
  if (design.variant === 'inline') {
    return (
      <div
        className={widthClass}
        style={{
          borderRadius: design.radius,
          padding: pad,
          paddingLeft: pad + 6,
          background: tint(a, Math.round(design.accentIntensity * 0.55)),
          borderLeft: `3px solid ${a.dot}`,
          boxShadow: SHADOWS[design.elevation],
        }}
      >
        <div className="flex items-center gap-2">
          <GateIcon design={design} box={30} icon={16} />
          <StatusDot design={design} />
          <Title preset={preset} />
        </div>
        <div className="mt-3">
          <Body design={design} preset={preset} />
        </div>
        <div className="mt-4">
          <Cta design={design} preset={preset} />
        </div>
      </div>
    );
  }

  // ── CARD FAMILY ───────────────────────────────────────────────────────────

  // card_header — accent header band across the top, padded body below.
  if (design.variant === 'card_header') {
    return (
      <div
        className={widthClass}
        style={{
          borderRadius: design.radius,
          border: borderRule(design),
          boxShadow: SHADOWS[design.elevation],
          overflow: 'hidden',
        }}
      >
        <div
          className="flex items-center gap-2.5 border-b border-border"
          style={{ background: tint(a, Math.max(design.accentIntensity, 8)), padding: pad }}
        >
          <GateIcon design={design} box={34} icon={18} />
          <StatusDot design={design} />
          <Title preset={preset} />
        </div>
        <div style={{ padding: pad }}>
          <Body design={design} preset={preset} />
          <div className="mt-4">
            <Cta design={design} preset={preset} />
          </div>
        </div>
      </div>
    );
  }

  // card_rail — navi-black Rose-logo rail on the left, content column on the right.
  if (design.variant === 'card_rail') {
    return (
      <div
        className={cn(widthClass, 'flex')}
        style={{
          borderRadius: design.radius,
          border: borderRule(design),
          boxShadow: SHADOWS[design.elevation],
          overflow: 'hidden',
        }}
      >
        <div
          className="flex shrink-0 items-start justify-center text-white"
          style={{ backgroundColor: NAVI_BLACK, padding: pad }}
        >
          {design.showIcon && <RoseLogo size={24} />}
        </div>
        <div className="min-w-0 flex-1 bg-card" style={{ padding: pad }}>
          <div className="flex items-center gap-2">
            <StatusDot design={design} />
            <Title preset={preset} />
          </div>
          <div className="mt-3">
            <Body design={design} preset={preset} />
          </div>
          <div className="mt-4">
            <Cta design={design} preset={preset} />
          </div>
        </div>
      </div>
    );
  }

  // card_split — header + body, then a footer action bar (right-aligned CTA).
  if (design.variant === 'card_split') {
    return (
      <div
        className={cn(widthClass, 'bg-card/90 backdrop-blur-sm')}
        style={{
          borderRadius: design.radius,
          border: borderRule(design),
          boxShadow: SHADOWS[design.elevation],
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: pad }}>
          <div className="flex items-center gap-2.5">
            <GateIcon design={design} box={34} icon={18} />
            <StatusDot design={design} />
            <Title preset={preset} />
          </div>
          <div className="mt-3">
            <Body design={design} preset={preset} />
          </div>
        </div>
        <div
          className="flex items-center justify-end border-t border-border bg-muted/30"
          style={{ padding: `${Math.max(10, pad * 0.7)}px ${pad}px` }}
        >
          <Cta design={design} preset={preset} />
        </div>
      </div>
    );
  }

  // card_hero — large logo + prominent title, full-width CTA.
  if (design.variant === 'card_hero') {
    return (
      <div
        className={cn(widthClass, 'bg-card/90 backdrop-blur-sm')}
        style={{
          borderRadius: design.radius,
          padding: pad + 2,
          border: borderRule(design),
          boxShadow: SHADOWS[design.elevation],
        }}
      >
        <div className="flex flex-col items-start gap-3">
          <div className="flex w-full items-center justify-between">
            <GateIcon design={design} box={44} icon={24} />
            {design.showStatusDot && (
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: tint(a, 16), color: a.dot }}
              >
                Action needed
              </span>
            )}
          </div>
          <div className="text-base font-semibold text-foreground">{preset.title}</div>
        </div>
        <div className="mt-3">
          <Body design={design} preset={preset} />
        </div>
        <div className="mt-4">
          <Cta design={design} preset={preset} block />
        </div>
      </div>
    );
  }

  // card (default) — icon + dot + title header, body, CTA.
  return (
    <div
      className={cn(widthClass, 'bg-card/90 backdrop-blur-sm')}
      style={{
        borderRadius: design.radius,
        padding: pad,
        border: borderRule(design),
        boxShadow: SHADOWS[design.elevation],
      }}
    >
      <div className="flex items-center gap-2.5">
        <GateIcon design={design} box={34} icon={18} />
        <StatusDot design={design} />
        <Title preset={preset} />
      </div>
      <div className="mt-3">
        <Body design={design} preset={preset} />
      </div>
      <div className="mt-4">
        <Cta design={design} preset={preset} />
      </div>
    </div>
  );
}
