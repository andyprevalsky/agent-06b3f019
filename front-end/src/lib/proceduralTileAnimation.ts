/**
 * Frame-based tile animation player with pixel manipulation
 *
 * Plays back pre-recorded frames from the animation video as raw pixel data
 * Supports multiple animations with rotation
 */

import animation1Data from './animation-1-pixels.json';
import animation2Data from './animation-2-pixels.json';
import animation3Data from './animation-3-pixels.json';
import animation4Data from './animation-4-pixels.json';

interface DeltaFrame {
  type: 'delta';
  deltas: number[][]; // [[pixel_index, color_index], ...]
}

interface FullFrame {
  type: 'full';
  indices: number[]; // Color indices (0, 1, or 2)
}

type CompressedFrame = DeltaFrame | FullFrame;

interface AnimationData {
  id: string;
  fps: number;
  duration_ms: number;
  frame_count: number;
  width: number;
  height: number;
  format: string;
  description: string;
  compressed?: boolean;
  colors?: number[][]; // RGB triplets for indexed format
  frames: CompressedFrame[];
}

// Load all available animations
export const availableAnimations: AnimationData[] = [
  animation1Data as AnimationData,
  animation2Data as AnimationData,
  animation3Data as AnimationData,
  animation4Data as AnimationData,
];

// Cache for ImageData objects (per animation ID)
const imageDataCache: Map<string, Map<number, ImageData>> = new Map();

// Cache for reconstructed frames (per animation ID)
const reconstructedFrameCache: Map<string, Map<number, number[]>> = new Map();

// Reusable temporary canvases (one per animation size)
const tempCanvases: Map<string, [HTMLCanvasElement, CanvasRenderingContext2D]> = new Map();

function getTempCanvas(
  animationData: AnimationData,
): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const key = `${animationData.width}x${animationData.height}`;

  if (!tempCanvases.has(key)) {
    const canvas = document.createElement('canvas');
    canvas.width = animationData.width;
    canvas.height = animationData.height;
    const ctx = canvas.getContext('2d', {
      alpha: true,
      willReadFrequently: false,
    })!;

    // Disable image smoothing for crisp pixels
    ctx.imageSmoothingEnabled = false;

    tempCanvases.set(key, [canvas, ctx]);
  }

  return tempCanvases.get(key)!;
}

/**
 * Reconstruct a full frame from compressed indexed data
 * Returns color indices (0, 1, or 2)
 */
function reconstructFrame(animationData: AnimationData, frameIndex: number): number[] {
  const animId = animationData.id;

  // Get or create cache for this animation
  if (!reconstructedFrameCache.has(animId)) {
    reconstructedFrameCache.set(animId, new Map());
  }
  const cache = reconstructedFrameCache.get(animId)!;

  // Check cache first
  if (cache.has(frameIndex)) {
    return cache.get(frameIndex)!;
  }

  const frames = animationData.frames as CompressedFrame[];
  const frame = frames[frameIndex];
  let indices: number[];

  if (frame.type === 'full') {
    // Full frame - return the indices
    indices = frame.indices;
  } else {
    // Delta frame - reconstruct from previous frame
    const prevIndices = reconstructFrame(animationData, frameIndex - 1);
    indices = [...prevIndices]; // Copy previous frame

    // Apply deltas: [pixel_index, color_index]
    for (const delta of frame.deltas) {
      const [pixelIdx, colorIdx] = delta;
      indices[pixelIdx] = colorIdx;
    }
  }

  // Cache it
  cache.set(frameIndex, indices);

  return indices;
}

/**
 * Color mapping function - maps animation color indices to tile theme
 * Direct mapping based on extraction order (sorted by frequency):
 * - Index 0 (most common) → background
 * - Index 1 (second most) → border color
 * - Index 2 (third most) → border color (same as index 1)
 * - Index 3 (least common) → lighter flicker
 */
function mapColorByIndex(colorIdx: number): [number, number, number] {
  // Tile background: #f9f9fb (249, 249, 251)
  const tileBackground = [249, 249, 251] as [number, number, number];

  // Border color: #e5e7eb (229, 231, 235)
  const borderColor = [229, 231, 235] as [number, number, number];

  // Flicker color: #f3f4f6 (243, 244, 246) - lighter than border
  const flickerColor = [243, 244, 246] as [number, number, number];

  switch (colorIdx) {
    case 0: // Background (most common)
      return tileBackground;
    case 1: // Main animation (second most common)
      return borderColor;
    case 2: // Also maps to border (third most common)
      return borderColor;
    case 3: // Flicker/highlights (least common)
      return flickerColor;
    default:
      return tileBackground;
  }
}

/**
 * Create ImageData from indexed color data with optional color manipulation
 * Uses delta compression to reconstruct frames efficiently
 */
function createImageData(animationData: AnimationData, frameIndex: number): ImageData {
  const animId = animationData.id;

  // Get or create cache for this animation
  if (!imageDataCache.has(animId)) {
    imageDataCache.set(animId, new Map());
  }
  const cache = imageDataCache.get(animId)!;

  // Check cache first
  if (cache.has(frameIndex)) {
    return cache.get(frameIndex)!;
  }

  // Reconstruct frame indices from deltas
  const colorIndices = reconstructFrame(animationData, frameIndex);
  const width = animationData.width;
  const height = animationData.height;

  // Create ImageData
  const imageData = new ImageData(width, height);
  const data = imageData.data;

  // Convert indices to RGB pixels (direct mapping to theme colors)
  let dstIndex = 0;

  for (let i = 0; i < width * height; i++) {
    const colorIdx = colorIndices[i];

    // Map color index to theme color
    const [r, g, b] = mapColorByIndex(colorIdx);

    data[dstIndex++] = r;
    data[dstIndex++] = g;
    data[dstIndex++] = b;
    data[dstIndex++] = 255; // Alpha
  }

  // Cache it
  cache.set(frameIndex, imageData);

  return imageData;
}

/**
 * Render pixel-based animation with color manipulation
 * @returns true if still playing, false if complete
 */
export function renderProceduralAnimationSync(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  tileSize: number,
  elapsedMs: number,
  animationId: string,
): boolean {
  // Find the animation data
  const animationData = availableAnimations.find((a) => a.id === animationId);
  if (!animationData) {
    console.error(`Animation not found: ${animationId}`);
    return false;
  }

  // Calculate current frame based on elapsed time (NO looping - play once)
  const msPerFrame = 1000 / animationData.fps;
  const frameNumber = Math.floor(elapsedMs / msPerFrame);

  // Check if animation is complete
  if (frameNumber >= animationData.frame_count) {
    return false; // Animation complete
  }

  const currentFrame = frameNumber;

  // Get or create ImageData for this frame
  let imageData: ImageData;
  try {
    imageData = createImageData(animationData, currentFrame);
  } catch (error) {
    console.error(`Error creating frame ${currentFrame} for ${animationId}:`, error);
    return true; // Continue trying
  }

  // Clear the tile area
  ctx.clearRect(x, y, tileSize, tileSize);

  // Get reusable temp canvas
  const [canvas, canvasCtx] = getTempCanvas(animationData);

  // Put the pixel data
  canvasCtx.putImageData(imageData, 0, 0);

  // Save context state
  ctx.save();

  // Disable ALL forms of image smoothing for pixel-perfect rendering
  ctx.imageSmoothingEnabled = false;
  // @ts-ignore - vendor prefixes for older browsers
  ctx.mozImageSmoothingEnabled = false;
  // @ts-ignore
  ctx.webkitImageSmoothingEnabled = false;
  // @ts-ignore
  ctx.msImageSmoothingEnabled = false;

  // Add padding (10% on each side = 80% of tile size)
  const padding = tileSize * 0.1;
  const paddedSize = tileSize - padding * 2;
  const paddedX = x + padding;
  const paddedY = y + padding;

  // Draw scaled to padded size
  ctx.drawImage(canvas, paddedX, paddedY, paddedSize, paddedSize);

  // Restore context state
  ctx.restore();

  return true; // Animation still playing
}
