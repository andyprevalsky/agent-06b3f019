/** What useRoseTheme() returns (see hooks.ts for the state machine). */
export interface RoseThemeValue {
  /** True only for a Rose Desktop account that switched to dark. */
  isDark: boolean;
  /** Flip light <-> dark and persist it for the signed-in user. */
  toggle: () => void;
}

/** The persisted choice; anything else (or nothing) reads as light. */
export type RoseThemeChoice = 'light' | 'dark';
