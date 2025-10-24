/**
 * Small tile animations system
 * 
 * This system handles animated small tiles with canvas-based rendering.
 * Tiles are marked with dots and animated with various effects.
 */

export interface TilePosition {
  row: number;
  col: number;
  x: number;
  y: number;
}

export interface TileGridPosition {
  row: number;
  col: number;
}

export interface AnimatingTile {
  position: TileGridPosition; // Only store row/col, not x/y (x/y calculated dynamically)
  animationId: string;
  startTime: number;
  currentFrame: number;
}

/**
 * Get the tile positions that should be marked with dots (animation-ready tiles)
 * These are small tiles surrounding the large center tile
 */
export function getAnimationReadyTilePositions(
  viewportWidth: number,
  viewportHeight: number,
  tileSize: number,
  largeTileSize: number
): TilePosition[] {
  const centerX = viewportWidth / 2;
  const centerY = viewportHeight * 0.4;
  const largeTileHalf = largeTileSize / 2;
  
  // Calculate grid origin (top-left of tile grid)
  const tilesLeft = Math.floor((centerX - largeTileHalf) / tileSize);
  const tilesUp = Math.floor((centerY - largeTileHalf) / tileSize);
  const gridOriginX = centerX - largeTileHalf - (tilesLeft * tileSize);
  const gridOriginY = centerY - largeTileHalf - (tilesUp * tileSize);
  
  // Large tile boundaries in grid coordinates
  const largeTileRow = Math.floor((centerY - largeTileHalf) / tileSize);
  const largeTileCol = Math.floor((centerX - largeTileHalf) / tileSize);
  
  const positions: TilePosition[] = [];
  
  // Define which tiles should be animation-ready (tiles immediately surrounding large tile)
  // Using the same grid system as tileAnimation.ts
  // Grid positions relative to large tile:
  const relativePositions = [
    // Top row (above large tile)
    [-1, -1], [-1, 0], [-1, 1], [-1, 2], [-1, 3],
    // Middle rows (sides of large tile)
    [0, -1], [0, 3],
    [1, -1], [1, 3],
    [2, -1], [2, 3],
    // Bottom row (below large tile)
    [3, -1], [3, 0], [3, 1], [3, 2], [3, 3],
  ];
  
  relativePositions.forEach(([relRow, relCol]) => {
    const row = largeTileRow + relRow;
    const col = largeTileCol + relCol;
    const x = gridOriginX + col * tileSize;
    const y = gridOriginY + row * tileSize;
    
    positions.push({ row, col, x, y });
  });
  
  return positions;
}

/**
 * Draw a dot marker on a tile to indicate it's animation-ready
 */
export function drawDotMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string = 'rgba(0, 0, 0, 0.3)'
) {
  const centerX = x + size / 2;
  const centerY = y + size / 2;
  const radius = 3; // Small dot
  
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

