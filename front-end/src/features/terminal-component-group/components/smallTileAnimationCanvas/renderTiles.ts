import { drawDotMarker, type AnimatingTile } from '@/lib/smallTileAnimations';
import { renderProceduralAnimationSync } from '@/lib/proceduralTileAnimation';

interface ScrollOffset {
  x: number;
  y: number;
}

interface GridOriginArgs {
  viewportWidth: number;
  viewportHeight: number;
  tileSize: number;
  largeTileSize: number;
  scrollOffset: ScrollOffset;
}

export interface GridOrigin {
  x: number;
  y: number;
}

export function computeGridOrigin({
  viewportWidth,
  viewportHeight,
  tileSize,
  largeTileSize,
  scrollOffset,
}: GridOriginArgs): GridOrigin {
  const centerX = viewportWidth / 2;
  const centerY = viewportHeight * 0.4;
  const largeTileHalf = largeTileSize / 2;
  const tilesLeft = Math.floor((centerX - largeTileHalf) / tileSize);
  const tilesUp = Math.floor((centerY - largeTileHalf) / tileSize);
  return {
    x: centerX - largeTileHalf - tilesLeft * tileSize + scrollOffset.x,
    y: centerY - largeTileHalf - tilesUp * tileSize + scrollOffset.y,
  };
}

function resolveDotColor(): string {
  const isDarkMode = document.documentElement.classList.contains('dark');
  return isDarkMode ? 'rgba(31, 41, 55, 0.8)' : 'rgba(229, 231, 235, 0.8)';
}

export function drawDots(
  ctx: CanvasRenderingContext2D,
  origin: GridOrigin,
  tileSize: number,
  everColoredTiles: Set<string>,
  animatingPositions: Set<string>,
) {
  const dotColor = resolveDotColor();
  everColoredTiles.forEach((key) => {
    if (animatingPositions.has(key)) return;
    const [row, col] = key.split(',').map(Number);
    const x = origin.x + col * tileSize;
    const y = origin.y + row * tileSize;
    drawDotMarker(ctx, x, y, tileSize, dotColor);
  });
}

export function drawAnimations(
  ctx: CanvasRenderingContext2D,
  origin: GridOrigin,
  tileSize: number,
  animatingTiles: AnimatingTile[],
  now: number,
): AnimatingTile[] {
  const completed: AnimatingTile[] = [];
  animatingTiles.forEach((tile) => {
    const elapsedMs = now - tile.startTime;
    const screenX = origin.x + tile.position.col * tileSize;
    const screenY = origin.y + tile.position.row * tileSize;
    const isStillPlaying = renderProceduralAnimationSync(
      ctx,
      screenX,
      screenY,
      tileSize,
      elapsedMs,
      tile.animationId,
    );
    if (!isStillPlaying) completed.push(tile);
  });
  return completed;
}
