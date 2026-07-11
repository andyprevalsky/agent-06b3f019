import type { ShortcutConfig } from './types';

export const ROSE_GRADIENT =
  'linear-gradient(to bottom left, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)';

export const DEFAULT_SHORTCUT: ShortcutConfig = {
  modifiers: ['Alt'],
  key: 'Space',
};

export const MODIFIER_DISPLAY: Record<string, string> = {
  Meta: '\u2318', // Command
  Alt: '\u2325', // Option
  Control: '\u2303', // Control
  Shift: '\u21E7', // Shift
};

export const KEY_DISPLAY: Record<string, string> = {
  Space: 'Space',
  ArrowUp: '\u2191',
  ArrowDown: '\u2193',
  ArrowLeft: '\u2190',
  ArrowRight: '\u2192',
  Enter: '\u23CE',
  Escape: 'Esc',
  Tab: '\u21E5',
  Backspace: '\u232B',
};

export const MODIFIER_KEY_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
]);

export const RESEND_COOLDOWN_SECONDS = 30;

export function resolveBackendUrl(rawUrl: string | undefined, isProd: boolean): string {
  const url = rawUrl?.trim();
  if (url !== undefined && url !== '') return url;
  if (isProd) {
    throw new Error('Missing VITE_BACKEND_API_URL for packaged Mac app');
  }
  return 'http://localhost:3001';
}

export const getBackendUrl = (): string => {
  return resolveBackendUrl(import.meta.env.VITE_BACKEND_API_URL, import.meta.env.PROD);
};
