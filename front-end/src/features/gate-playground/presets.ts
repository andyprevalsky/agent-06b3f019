// Gate playground — data + types.
//
// Pure data module (no state, no side effects). Defines the design-token shape
// the sliders drive, the accent palette, and one content preset per gate type
// (title / reason / cta / faux chat thread) so every gate reads coherently in
// the preview. Nothing here is wired to the real attention-request pipeline —
// this is a design sandbox only. The production Gate object is specified in
// docs/plans/active/sms-onboarding-and-gates.md.

import type { LucideIcon } from 'lucide-react';
import { Mail, ShieldCheck, Sparkles, ShoppingBag } from 'lucide-react';

/** Rose brand gradient (front-end/src/index.css). */
export const ROSE_GRADIENT =
  'linear-gradient(135deg, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)';
export const SUNSET_GRADIENT = 'linear-gradient(135deg, #FF8A00, #FF5E62)';
export const OCEAN_GRADIENT = 'linear-gradient(135deg, #2E7BEF, #00C2A8)';

// No `payment_method` gate: if there's no card on file the user simply needs to
// subscribe, so that case is covered by the `subscription` gate.
export type GateTypeKey = 'subscription' | 'source_connect' | 'kyc' | 'approval';

export type AccentKey =
  'rose' | 'sunset' | 'amber' | 'jade' | 'ocean' | 'azure' | 'iris' | 'graphite';
/**
 * Card family (roomy, detail-capable — hold receipts/breakdowns):
 *   card · card_header · card_rail · card_split · card_hero
 * Compact alternates: inline · banner · chip
 */
export type GateVariant =
  'card' | 'card_header' | 'card_rail' | 'card_split' | 'card_hero' | 'inline' | 'banner' | 'chip';
export type ButtonStyle = 'filled' | 'outline' | 'gradient';

/** Every visual knob the control panel drives. */
export interface GateDesign {
  variant: GateVariant;
  radius: number; // px — corner radius
  padding: number; // px — internal density
  accent: AccentKey;
  accentIntensity: number; // 0–100 — tint strength (bg on banner/inline, border elsewhere)
  elevation: number; // 0–3 — shadow depth
  borderEmphasis: number; // 0–2 — border weight
  buttonStyle: ButtonStyle;
  showIcon: boolean;
  showStatusDot: boolean;
  showReason: boolean;
  fullWidth: boolean;
}

export const DEFAULT_DESIGN: GateDesign = {
  variant: 'card_rail',
  radius: 14,
  padding: 16,
  accent: 'rose',
  accentIntensity: 12,
  elevation: 2,
  borderEmphasis: 1,
  buttonStyle: 'filled',
  showIcon: true,
  showStatusDot: true,
  showReason: true,
  fullWidth: true,
};

export interface AccentDef {
  label: string;
  rgb: string; // "r g b" — used in rgb(… / a%) tints
  dot: string; // solid hex for status dot / outline text
  gradient?: string;
}

export const ACCENTS: Record<AccentKey, AccentDef> = {
  rose: { label: 'Rose', rgb: '253 87 118', dot: '#FD5776', gradient: ROSE_GRADIENT },
  sunset: { label: 'Sunset', rgb: '255 107 74', dot: '#FF6B4A', gradient: SUNSET_GRADIENT },
  amber: { label: 'Gold', rgb: '227 154 11', dot: '#E39A0B' },
  jade: { label: 'Jade', rgb: '15 185 129', dot: '#0FB981' },
  ocean: { label: 'Ocean', rgb: '46 123 239', dot: '#2E7BEF', gradient: OCEAN_GRADIENT },
  azure: { label: 'Azure', rgb: '47 128 237', dot: '#2F80ED' },
  iris: { label: 'Iris', rgb: '122 107 236', dot: '#7A6BEC' },
  graphite: { label: 'Graphite', rgb: '71 85 105', dot: '#64748B' },
};

export interface ReceiptLine {
  name: string;
  qty: number;
  unitCents: number;
  lineCents: number;
}

export interface GatePaymentReceipt {
  merchant: string;
  lines: ReceiptLine[];
  subtotalCents: number;
  fees: { label: string; amountCents: number }[];
  totalCents: number;
}

export interface FauxMsg {
  role: 'USER' | 'ASSISTANT' | 'TOOL';
  text: string;
  tool?: 'search' | 'cart';
}

export interface GatePreset {
  key: GateTypeKey;
  label: string;
  icon: LucideIcon;
  title: string;
  reason: string;
  cta: string;
  actionKind: 'link' | 'reply';
  /** Plain-text body of the SMS the gate would send (the "minimal path"). */
  smsBody: string;
  defaultAccent: AccentKey;
  receipt?: GatePaymentReceipt;
  /** Faux chat messages shown above the gate so it reads in context. */
  thread: FauxMsg[];
}

export const GATE_PRESETS: Record<GateTypeKey, GatePreset> = {
  subscription: {
    key: 'subscription',
    label: 'Subscription',
    icon: Sparkles,
    title: 'Subscribe to let Rose complete purchases',
    reason:
      "You've used your $1.00 of free credit — an active plan lets me finish tasks that cost real money.",
    cta: 'Subscribe · $20/mo',
    actionKind: 'link',
    smsBody: "You're out of free credit. Subscribe to finish your task: roselabs.ai/s/9f2a",
    defaultAccent: 'rose',
    thread: [
      { role: 'USER', text: 'get me a bottle of casamigos delivered for tonight 🍸' },
      {
        role: 'ASSISTANT',
        text: 'On it — found Casamigos Blanco at a shop near you, $52 delivered.',
      },
      { role: 'TOOL', text: 'Preparing checkout', tool: 'cart' },
    ],
  },
  source_connect: {
    key: 'source_connect',
    label: 'Connect source',
    icon: Mail,
    title: 'Connect Gmail',
    reason: 'I need read access to your inbox to find your flight confirmation.',
    cta: 'Connect Gmail',
    actionKind: 'link',
    smsBody:
      'To complete your task (check your flight to SFO), connect Gmail here: roselabs.ai/c/gmail',
    defaultAccent: 'rose',
    thread: [
      { role: 'USER', text: 'did my flight to SFO get confirmed? check my email' },
      {
        role: 'ASSISTANT',
        text: "I don't have access to your inbox yet — one tap and I'll pull it up.",
      },
    ],
  },
  kyc: {
    key: 'kyc',
    label: 'KYC',
    icon: ShieldCheck,
    title: 'Verify your identity',
    reason: 'A one-time identity check is required before Rose can issue your card.',
    cta: 'Verify identity',
    actionKind: 'link',
    smsBody: 'Quick identity check before I can issue your card: roselabs.ai/kyc/start',
    defaultAccent: 'rose',
    thread: [
      { role: 'USER', text: 'set up my rose card so you can pay for stuff' },
      {
        role: 'ASSISTANT',
        text: 'Almost there — I need to verify your identity before issuing a card.',
      },
    ],
  },
  approval: {
    key: 'approval',
    label: 'Approval + payment',
    icon: ShoppingBag,
    title: 'Approve this purchase',
    reason: "Reply to confirm and I'll place the order right away.",
    cta: 'Approve',
    actionKind: 'reply',
    smsBody: 'Casamigos Blanco 750ml — $60.99 delivered. Reply YES to place the order.',
    defaultAccent: 'rose',
    receipt: {
      merchant: 'Drizly · Casa Fiesta Wine & Spirits',
      lines: [{ name: 'Casamigos Blanco Tequila 750ml', qty: 1, unitCents: 5200, lineCents: 5200 }],
      subtotalCents: 5200,
      fees: [
        { label: 'Delivery', amountCents: 599 },
        { label: 'Service fee', amountCents: 300 },
      ],
      totalCents: 6099,
    },
    thread: [
      { role: 'USER', text: 'yes get the tequila' },
      { role: 'ASSISTANT', text: "Here's the order — approve and I'll place it." },
    ],
  },
};

export const GATE_TYPE_ORDER: GateTypeKey[] = ['subscription', 'source_connect', 'kyc', 'approval'];

export const formatCents = (c: number): string => `$${(c / 100).toFixed(2)}`;
