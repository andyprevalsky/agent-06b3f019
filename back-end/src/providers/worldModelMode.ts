export type WorldModelMode = 'real' | 'simulate' | 'shadow';

export function normalizeWorldModelMode(mode: string | null | undefined): WorldModelMode {
  return mode === 'simulate' || mode === 'shadow' ? mode : 'real';
}

export function isNonRealWorldModelMode(mode: string | null | undefined): boolean {
  return normalizeWorldModelMode(mode) !== 'real';
}
