export const TERMINAL_THEME = {
  background: '#101211',
  foreground: '#ecf0e8',
  cursor: '#f7d774',
  cursorAccent: '#101211',
  selectionBackground: '#375f62',
  black: '#101211',
  red: '#ff6b6b',
  green: '#7ee787',
  yellow: '#f7d774',
  blue: '#7dcfff',
  magenta: '#d2a8ff',
  cyan: '#79d4d7',
  white: '#ecf0e8',
  brightBlack: '#758078',
  brightRed: '#ff8f8f',
  brightGreen: '#a6f3a6',
  brightYellow: '#ffe58f',
  brightBlue: '#9bdcff',
  brightMagenta: '#e2c4ff',
  brightCyan: '#a2f0f2',
  brightWhite: '#ffffff',
} as const;

export type TerminalStream = 'stdout' | 'stderr' | 'buffer' | 'error';

export function parseExitCode(code: unknown): number | null {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && code.trim() !== '') {
    const parsed = Number(code);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
