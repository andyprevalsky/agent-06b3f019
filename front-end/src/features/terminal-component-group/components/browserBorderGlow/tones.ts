/** Border-glow color tones for BrowserBorderGlow. */

export type BrowserBorderGlowTone = 'default' | 'challenge_recovery';

export interface GlowToneColors {
  glowColor: { r: number; g: number; b: number };
  dotColor: { r: number; g: number; b: number };
}

/** Soft sky blue — normal agent control. */
export const DEFAULT_GLOW_TONE: GlowToneColors = {
  glowColor: { r: 186, g: 230, b: 253 },
  dotColor: { r: 224, g: 242, b: 254 },
};

/** Warm orange — recover_from_challenge / browser_challenge_recovery in flight. */
export const CHALLENGE_RECOVERY_GLOW_TONE: GlowToneColors = {
  glowColor: { r: 253, g: 186, b: 116 },
  dotColor: { r: 254, g: 215, b: 170 },
};

export function glowToneColors(tone: BrowserBorderGlowTone): GlowToneColors {
  return tone === 'challenge_recovery' ? CHALLENGE_RECOVERY_GLOW_TONE : DEFAULT_GLOW_TONE;
}
