import { CONFIG } from './config';

function getCorners(width: number, height: number) {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

function computeCornerIntensity(
  x: number,
  y: number,
  corners: ReturnType<typeof getCorners>,
  scaledCornerRadius: number,
): number {
  let cornerIntensity = 0;
  for (const corner of corners) {
    const dist = Math.sqrt((x - corner.x) ** 2 + (y - corner.y) ** 2);
    const intensity = Math.max(0, 1 - dist / scaledCornerRadius);
    // squared falloff for softer edges
    cornerIntensity = Math.max(cornerIntensity, intensity * intensity);
  }
  return cornerIntensity;
}

/**
 * Precompute static glow bitmap. Returns RGBA Uint8ClampedArray of length width*height*4.
 */
export function generateGlow(width: number, height: number, dpr: number): Uint8ClampedArray {
  const { glowOpacity, edgeGlowOpacity, cornerRadius, edgeRadius, glowColor } = CONFIG;
  const scaledCornerRadius = cornerRadius * dpr;
  const scaledEdgeRadius = edgeRadius * dpr;
  const glowData = new Uint8ClampedArray(width * height * 4);
  const corners = getCorners(width, height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cornerIntensity = computeCornerIntensity(x, y, corners, scaledCornerRadius);

      const edgeDist = Math.min(x, y, width - 1 - x, height - 1 - y);
      const edgeIntensity = Math.max(0, 1 - edgeDist / scaledEdgeRadius);
      const edgeGlow = edgeIntensity * edgeIntensity;

      const cornerAlpha = cornerIntensity * glowOpacity;
      const edgeAlpha = edgeGlow * edgeGlowOpacity;
      const finalAlpha = Math.max(cornerAlpha, edgeAlpha);

      if (finalAlpha > 0) {
        const idx = (y * width + x) * 4;
        glowData[idx] = glowColor.r;
        glowData[idx + 1] = glowColor.g;
        glowData[idx + 2] = glowColor.b;
        glowData[idx + 3] = finalAlpha * 255;
      }
    }
  }

  return glowData;
}
