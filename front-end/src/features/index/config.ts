import type { FeatureItem, FeatureKey } from './types';

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

export const HERO_BASE_TEXT = "Hi! I'm Rose, your voice AI ";

export const HERO_ROTATING_WORDS = ['companion.', 'assistant.', 'daemon.', 'computer.'];

// Typing speed constants (milliseconds)
export const HERO_TYPE_BASE_SPEED = 64;
export const HERO_TYPE_WORD_SPEED = 53;
export const HERO_DELETE_SPEED = 27;
export const HERO_PAUSE_AFTER_WORD = 1000;
export const HERO_PAUSE_BETWEEN_WORDS = 133;

// ---------------------------------------------------------------------------
// Powered-by ticker
// ---------------------------------------------------------------------------

export const PROVIDER_LOGOS = [
  { src: 'openai-logo.png', alt: 'OpenAI', height: 40 },
  { src: 'anthropic-logo.png', alt: 'Anthropic', height: 24 },
  { src: 'cerebras-logo.png', alt: 'Cerebras', height: 52 },
  { src: 'elevenlabs-logo.png', alt: 'ElevenLabs', height: 24, extraClass: 'elevenlabs-logo' },
  { src: 'google-ai-logo.png', alt: 'Google AI', height: 40, marginBottom: 8 },
  { src: 'meta-logo.png', alt: 'Meta', height: 24 },
  { src: 'deepgram-logo.png', alt: 'Deepgram', height: 32, marginTop: 8 },
  { src: 'hedra-logo.png', alt: 'Hedra', height: 40 },
  { src: 'ycombinator-logo.png', alt: 'Y Combinator', height: 40 },
] as const;

// ---------------------------------------------------------------------------
// Features section
// ---------------------------------------------------------------------------

export const FEATURES: FeatureItem[] = [
  {
    title: 'Fully Customizable',
    description: '',
    details: [
      'Change the LLM provider, System Prompt & Voice to create your perfect AI companion.',
      'Connect your own tools to Rose through MCPs, or use tools shared by other devs in our marketplace.',
      'Rose comes with prebuilt presets to get you up and running with SOTA models in an instant.',
    ],
  },
  {
    title: 'Seamless Conversations',
    description: '',
    details: [
      'Sub-800 ms responses keep every exchange natural and fluid.',
      'Custom models fine-tuned for smooth interruption handling and turn-taking.',
      'Custom voice pipeline engineered by veterans of top voice-AI companies.',
    ],
  },
  {
    title: 'Agent Enabled',
    description: '',
    details: [
      'Rose agents break down, measure & iterate towards any long-term goal.',
      'Integrated with phone calling, web search, email/SMS, and user-authorized payments, so Rose can take real-world actions on your behalf.',
      'Each agent runs on a SOTA agent harness, so that agents maintain long term context, are fault tolerant & can share learnings across sessions.',
    ],
  },
  {
    title: 'Rose Grows With You',
    description: '',
    details: [
      'After each conversation, Rose extracts key entity information to keep track of your most important relationships, events, and ideas.',
      "Rose's personality evolves to match your communication style.",
      'Time-based queries keep Rose working in the background, constantly refining its understanding of your world and ideating on ways to help you grow.',
    ],
  },
  {
    title: 'Privacy First',
    description: '',
    details: [
      // The JSX privacy link is injected at render time in the component.
      'Your conversations stay private. Rose never stores or sells your data.',
      'Rose does not passively listen, and is designed to only trigger active listening according to the customizable wake word, "Hi Rose".',
      'Audio data & transcriptions are streamed directly, securely & anonymously to AI providers.',
    ],
  },
];

/** Rose logo gradient stops used for sequential card backgrounds. */
export const LOGO_GRADIENT_STOPS = [
  '#FE7503',
  '#FC585C',
  '#FD5776',
  '#E062CC',
  '#A76CED',
  '#7A6BEC',
];

export const FEATURE_ICONS: Record<number, string> = {
  0: 'customize.svg',
  1: 'seamless.svg',
  2: 'agent.svg',
  3: 'grow.svg',
  4: 'privacy.svg',
};

/** Lux neutral palette accents. */
export const PEARL_BLUE = '#F8FAFF';
export const HERO_BLACK = '#272725';

// ---------------------------------------------------------------------------
// Feature video
// ---------------------------------------------------------------------------

export const MASTER_SRC_WEBM = '/navi-features.webm';
export const MASTER_SRC_HEVC = '/navi-features-hevc.mov';

export function mapIndexToKey(index: number): FeatureKey {
  switch (index) {
    case 0:
      return 'customization';
    case 1:
      return 'conversations';
    case 2:
      return 'engine';
    case 3:
      return 'memory';
    case 4:
      return 'privacy';
    default:
      return 'engine';
  }
}

// ---------------------------------------------------------------------------
// Pre-order
// ---------------------------------------------------------------------------

export const PRE_ORDER_CHECKOUT_URLS = {
  black: 'https://buy.stripe.com/5kQ5kD6Dy4vr2Zr1OB5kk03',
  white: 'https://buy.stripe.com/8x2dR9aTO6Dz6bD0Kx5kk02',
} as const;

// ---------------------------------------------------------------------------
// Waitlist API
// ---------------------------------------------------------------------------

export function getApiBaseUrl(): string {
  const raw = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
  return raw.endsWith('/api') ? raw : `${raw}/api`;
}

// ---------------------------------------------------------------------------
// Color utilities
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}

export function darkenHex(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const k = Math.max(0, Math.min(1, amount));
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(Math.round(r * (1 - k)))}${toHex(Math.round(g * (1 - k)))}${toHex(Math.round(b * (1 - k)))}`;
}

export function rgbaString(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function mixWithWhite(hex: string, t: number): string {
  const { r, g, b } = hexToRgb(hex);
  const k = Math.max(0, Math.min(1, t));
  const mr = Math.round(r * (1 - k) + 255 * k);
  const mg = Math.round(g * (1 - k) + 255 * k);
  const mb = Math.round(b * (1 - k) + 255 * k);
  const toHex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${toHex(mr)}${toHex(mg)}${toHex(mb)}`;
}
