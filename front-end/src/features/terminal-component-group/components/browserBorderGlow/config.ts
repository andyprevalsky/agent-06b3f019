// Grid and animation configuration for BrowserBorderGlow

export const CONFIG = {
  gridSpacing: 4,
  dotRadius: 1,
  // How far corners extend toward center (reduced 10% from 525)
  cornerRadius: 473,
  // How far edge glow extends inward
  edgeRadius: 80,
  // Persistent glow underneath
  glowOpacity: 0.45,
  edgeGlowOpacity: 0.2,
  glowColor: { r: 186, g: 230, b: 253 },
  numWaves: 3,
  waveWidth: 0.22,
  waveSpeed: 0.00003125,
  flickerSpeed: 0.004,
  minOpacity: 0.02,
  maxOpacity: 0.5,
  dotColor: { r: 224, g: 242, b: 254 },
} as const;

export interface Dot {
  x: number;
  y: number;
  cornerIndex: number;
  cornerDist: number;
  edgeDist: number;
  flickerPhase: number;
}
