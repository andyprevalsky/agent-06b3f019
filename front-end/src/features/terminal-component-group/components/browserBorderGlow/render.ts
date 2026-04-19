import { CONFIG, type Dot } from './config';

function computeWavePositions(timestamp: number): number[] {
  const { numWaves, waveSpeed } = CONFIG;
  const wavePositions: number[] = [];
  for (let i = 0; i < numWaves; i++) {
    const pos = (timestamp * waveSpeed * 4 + i / numWaves) % 1;
    wavePositions.push(pos);
  }
  return wavePositions;
}

function minWaveDistance(cornerPos: number, wavePositions: number[]): number {
  let minWaveDist = 1;
  for (const wavePos of wavePositions) {
    let dist = Math.abs(cornerPos - wavePos);
    if (dist > 0.5) dist = 1 - dist;
    minWaveDist = Math.min(minWaveDist, dist);
  }
  return minWaveDist;
}

function computeDotOpacity(dot: Dot, wavePositions: number[], timestamp: number): number {
  const { waveWidth, flickerSpeed, minOpacity, maxOpacity } = CONFIG;
  const cornerPos = dot.cornerIndex / 4;
  const minWaveDist = minWaveDistance(cornerPos, wavePositions);

  const waveInfluence = Math.max(0, 1 - minWaveDist / waveWidth);
  const flicker =
    waveInfluence > 0.05 ? 0.5 + 0.5 * Math.sin(timestamp * flickerSpeed + dot.flickerPhase) : 0;

  const cornerFade = dot.cornerDist < 1 ? 1 - dot.cornerDist : 0;
  const edgeFadeRaw = dot.edgeDist < 1 ? 1 - dot.edgeDist : 0;
  const regionFade = Math.max(cornerFade, edgeFadeRaw * 0.5);
  const baseOpacity = minOpacity * regionFade * regionFade;
  const activeOpacity = waveInfluence * flicker * (maxOpacity - minOpacity) * regionFade;
  return baseOpacity + activeOpacity;
}

function blendDotPixel(
  data: Uint8ClampedArray,
  idx: number,
  newAlpha: number,
  existingAlpha: number,
) {
  const { dotColor } = CONFIG;
  const outAlpha = newAlpha + existingAlpha * (1 - newAlpha);
  if (outAlpha > 0) {
    data[idx] = (dotColor.r * newAlpha + data[idx] * existingAlpha * (1 - newAlpha)) / outAlpha;
    data[idx + 1] =
      (dotColor.g * newAlpha + data[idx + 1] * existingAlpha * (1 - newAlpha)) / outAlpha;
    data[idx + 2] =
      (dotColor.b * newAlpha + data[idx + 2] * existingAlpha * (1 - newAlpha)) / outAlpha;
    data[idx + 3] = outAlpha * 255;
  }
}

function drawDot(
  data: Uint8ClampedArray,
  dot: Dot,
  alpha: number,
  scaledRadius: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  for (let dy = -scaledRadius; dy <= scaledRadius; dy++) {
    for (let dx = -scaledRadius; dx <= scaledRadius; dx++) {
      const px = dot.x + dx;
      const py = dot.y + dy;
      if (px >= 0 && px < canvasWidth && py >= 0 && py < canvasHeight) {
        const idx = (py * canvasWidth + px) * 4;
        const existingAlpha = data[idx + 3] / 255;
        const newAlpha = alpha / 255;
        blendDotPixel(data, idx, newAlpha, existingAlpha);
      }
    }
  }
}

export interface RenderFrameArgs {
  ctx: CanvasRenderingContext2D;
  canvasWidth: number;
  canvasHeight: number;
  dpr: number;
  glowData: Uint8ClampedArray;
  dots: Dot[];
  timestamp: number;
}

export function renderFrame({
  ctx,
  canvasWidth,
  canvasHeight,
  dpr,
  glowData,
  dots,
  timestamp,
}: RenderFrameArgs) {
  const imageData = ctx.createImageData(canvasWidth, canvasHeight);
  imageData.data.set(glowData);
  const data = imageData.data;

  const wavePositions = computeWavePositions(timestamp);
  const scaledRadius = Math.max(1, Math.floor(CONFIG.dotRadius * dpr));

  for (const dot of dots) {
    const opacity = computeDotOpacity(dot, wavePositions, timestamp);
    if (opacity > 0.01) {
      const alpha = Math.min(255, opacity * 255);
      drawDot(data, dot, alpha, scaledRadius, canvasWidth, canvasHeight);
    }
  }

  ctx.putImageData(imageData, 0, 0);
}
