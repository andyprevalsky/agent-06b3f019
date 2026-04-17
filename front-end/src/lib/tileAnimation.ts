/**
 * Tile animation data and utilities
 *
 * Position-based animation mapping for tiles surrounding the large center tile.
 * Positions 0-29 are defined relative to the large tile in a fixed layout.
 *
 * KEY EDGE POSITIONS (for 1:1 reference mapping):
 *   Left edge (top to bottom):  12, 17, 23, 27
 *   Right edge (top to bottom): 13, 19, 24, 28
 */

export interface TileAnimationData {
  color_palette: {
    id: number;
    rgb: [number, number, number];
    hex: string;
  }[];
  frames: {
    [frameName: string]: number[]; // Array of 30 color values (0-3), one per position
  };
}

// Color palette for animation - evenly spaced from base to diamond color
export const colorPalette = [
  { id: 0, rgb: [249, 249, 251] as [number, number, number], hex: '#f9f9fb' }, // Base (matches body background)
  { id: 1, rgb: [242, 243, 246] as [number, number, number], hex: '#f2f3f6' }, // 1/3 between base and diamond
  { id: 2, rgb: [236, 237, 240] as [number, number, number], hex: '#ecedf0' }, // 2/3 between base and diamond
  { id: 3, rgb: [229, 231, 235] as [number, number, number], hex: '#e5e7eb' }, // Darkest (matches diamonds exactly)
];

// Grid structure:
// - 5 rows: indices 0-4 map to rows -2,-1,0,1,2 relative to large tile
// - 9 columns: indices 0-8 map to columns -3,-2,-1,0,1,2,3,4,5 relative to large tile
// - Large tile (T markers) at rows 1,2,3 (rows -1,0,1) and columns 4,5,6 (cols 0,1,2)

// Animation frames as 2D grids for easy editing
// 'T' marks the large tile (3x3), numbers 0-3 are color IDs
// NO GAPS - all tiles are adjacent
// prettier-ignore
const frameGrids = {
  f1: [
    /*-2*/ [0, 0, 0, 0, 0, 0, 0, 0, 0],
    /*-1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 0*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 2*/ [0, 0, 0,'T','T','T', 0, 0, 0]
  ],
  f2: [
    /*-2*/ [0, 0, 0, 2, 1, 2, 0, 0, 0],
    /*-1*/ [0, 0, 1,'T','T','T', 1, 0, 0],
    /* 0*/ [0, 0, 1,'T','T','T', 1, 0, 0],
    /* 1*/ [0, 0, 1,'T','T','T', 1, 0, 0],
    /* 2*/ [0, 0, 1,'T','T','T', 1, 0, 0]
  ],
  f3: [
    /*-2*/ [0, 0, 0, 1, 1, 2, 0, 0, 0],
    /*-1*/ [0, 0, 1,'T','T','T', 1, 0, 0],
    /* 0*/ [0, 0, 1,'T','T','T', 3, 0, 0],
    /* 1*/ [0, 0, 1,'T','T','T', 2, 0, 0],
    /* 2*/ [0, 0, 2,'T','T','T', 1, 0, 0]
  ],
  f4: [
    /*-2*/ [0, 0, 0, 2, 2, 1, 1, 0, 0],
    /*-1*/ [0, 0, 3,'T','T','T', 2, 0, 0],
    /* 0*/ [0, 1, 1,'T','T','T', 2, 0, 0],
    /* 1*/ [0, 0, 1,'T','T','T', 2, 0, 0],
    /* 2*/ [0, 0, 2,'T','T','T', 2, 0, 0]
  ],
  f5: [
    /*-2*/ [0, 0, 1, 2, 2, 2, 2, 0, 0],
    /*-1*/ [0, 1, 1,'T','T','T', 1, 0, 0],
    /* 0*/ [0, 2, 2,'T','T','T', 1, 1, 0],
    /* 1*/ [0, 1, 2,'T','T','T', 1, 2, 0],
    /* 2*/ [0, 1, 2,'T','T','T', 1, 1, 0]
  ],
  f6: [
    /*-2*/ [0, 0, 1, 2, 2, 1, 0, 0, 0],
    /*-1*/ [0, 1, 1,'T','T','T', 1, 2, 0],
    /* 0*/ [0, 2, 2,'T','T','T', 1, 3, 0],
    /* 1*/ [0, 3, 2,'T','T','T', 1, 0, 0],
    /* 2*/ [0, 0, 2,'T','T','T', 0, 0, 0]
  ],
  f7: [
    /*-2*/ [0, 0, 1, 2, 1, 2, 0, 0, 0],
    /*-1*/ [0, 1, 1,'T','T','T', 2, 2, 0],
    /* 0*/ [0, 1, 0,'T','T','T', 1, 1, 0],
    /* 1*/ [0, 1, 3,'T','T','T', 1, 1, 0],
    /* 2*/ [0, 1, 1,'T','T','T', 1, 3, 0]
  ],
  f8: [
    /*-2*/ [0, 0, 0, 2, 1, 2, 2, 0, 0],
    /*-1*/ [0, 0, 1,'T','T','T', 2, 1, 0],
    /* 0*/ [0, 3, 0,'T','T','T', 1, 2, 0],
    /* 1*/ [0, 0, 3,'T','T','T', 1, 2, 0],
    /* 2*/ [0, 1, 1,'T','T','T', 1, 0, 0]
  ],
  f9: [
    /*-2*/ [0, 2, 2, 2, 1, 2, 1, 0, 0],
    /*-1*/ [0, 0, 1,'T','T','T', 2, 2, 0],
    /* 0*/ [2, 3, 0,'T','T','T', 1, 0, 0],
    /* 1*/ [0, 1, 2,'T','T','T', 1, 1, 0],
    /* 2*/ [0, 1, 1,'T','T','T', 1, 3, 0]
  ],
  f10: [
    /*-2*/ [0, 3, 0, 2, 1, 2, 1, 0, 0],
    /*-1*/ [0, 1, 1,'T','T','T', 2, 1, 0],
    /* 0*/ [3, 1, 0,'T','T','T', 1, 2, 1],
    /* 1*/ [0, 1, 2,'T','T','T', 1, 2, 0],
    /* 2*/ [0, 1, 1,'T','T','T', 1, 0, 0]
  ],
  f11: [
    /*-2*/ [0, 1, 0, 2, 1, 2, 1, 1, 0],
    /*-1*/ [0, 1, 1,'T','T','T', 2, 1, 0],
    /* 0*/ [3, 1, 0,'T','T','T', 1, 2, 1],
    /* 1*/ [0, 0, 2,'T','T','T', 0, 2, 0],
    /* 2*/ [0, 1, 1,'T','T','T', 1, 0, 0]
  ],
  f12: [
    /*-2*/ [0, 2, 0, 2, 1, 1, 1, 2, 0],
    /*-1*/ [0, 1, 1,'T','T','T', 2, 1, 0],
    /* 0*/ [1, 1, 0,'T','T','T', 0, 2, 0],
    /* 1*/ [0, 0, 2,'T','T','T', 0, 2, 0],
    /* 2*/ [0, 1, 1,'T','T','T', 1, 0, 0]
  ],
  f13: [
    /*-2*/ [0, 0, 0, 1, 1, 1, 1, 1, 0],
    /*-1*/ [0, 1, 1,'T','T','T', 1, 1, 0],
    /* 0*/ [1, 1, 0,'T','T','T', 0, 2, 1],
    /* 1*/ [0, 1, 1,'T','T','T', 0, 2, 0],
    /* 2*/ [0, 1, 1,'T','T','T', 0, 0, 0]
  ],
  f14: [
    /*-2*/ [0, 2, 0, 0, 0, 1, 1, 1, 0],
    /*-1*/ [0, 1, 0,'T','T','T', 0, 1, 0],
    /* 0*/ [2, 1, 0,'T','T','T', 0, 1, 1],
    /* 1*/ [0, 2, 0,'T','T','T', 0, 1, 0],
    /* 2*/ [0, 1, 0,'T','T','T', 0, 0, 0]
  ],
  f16: [
    /*-2*/ [0, 1, 0, 0, 0, 1, 1, 1, 0],
    /*-1*/ [0, 1, 0,'T','T','T', 0, 1, 0],
    /* 0*/ [0, 1, 0,'T','T','T', 0, 1, 1],
    /* 1*/ [0, 0, 0,'T','T','T', 0, 1, 0],
    /* 2*/ [0, 1, 0,'T','T','T', 0, 0, 0]
  ],
  f17: [
    /*-2*/ [0, 1, 0, 0, 0, 0, 0, 1, 0],
    /*-1*/ [0, 1, 0,'T','T','T', 0, 1, 0],
    /* 0*/ [1, 0, 0,'T','T','T', 0, 1, 1],
    /* 1*/ [0, 0, 0,'T','T','T', 0, 1, 0],
    /* 2*/ [0, 1, 0,'T','T','T', 0, 0, 0]
  ],
  f18: [
    /*-2*/ [0, 1, 0, 0, 0, 0, 0, 1, 0],
    /*-1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 0*/ [1, 0, 0,'T','T','T', 0, 0, 2],
    /* 1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 2*/ [0, 0, 0,'T','T','T', 0, 0, 0]
  ],
  f19: [
    /*-2*/ [0, 1, 0, 0, 0, 0, 0, 1, 0],
    /*-1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 0*/ [2, 0, 0,'T','T','T', 0, 0, 2],
    /* 1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 2*/ [0, 0, 0,'T','T','T', 0, 0, 0]
  ],
  f20: [
    /*-2*/ [0, 1, 0, 0, 0, 0, 0, 1, 0],
    /*-1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 0*/ [0, 0, 0,'T','T','T', 0, 0, 1],
    /* 1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 2*/ [0, 0, 0,'T','T','T', 0, 0, 0]
  ],
  f21: [
    /*-2*/ [0, 1, 0, 0, 0, 0, 0, 0, 0],
    /*-1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 0*/ [0, 0, 0,'T','T','T', 0, 0, 1],
    /* 1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 2*/ [0, 0, 0,'T','T','T', 0, 0, 0]
  ],
  f22: [
    /*-2*/ [0, 0, 0, 0, 0, 0, 0, 0, 0],
    /*-1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 0*/ [0, 0, 0,'T','T','T', 0, 0, 1],
    /* 1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 2*/ [0, 0, 0,'T','T','T', 0, 0, 0]
  ],
  f23: [
    /*-2*/ [0, 0, 0, 0, 0, 0, 0, 0, 0],
    /*-1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 0*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 1*/ [0, 0, 0,'T','T','T', 0, 0, 0],
    /* 2*/ [0, 0, 0,'T','T','T', 0, 0, 0]
  ],
};

// Store frame grids directly for easier access
export const frameGridsData = frameGrids;

// Animation data - keeping for compatibility but using grid-based approach
export const tileAnimationData: TileAnimationData = {
  color_palette: colorPalette,
  frames: {}, // Not used anymore - using frameGridsData directly
};

export const frameSequence = [
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
  'f13',
  'f14',
  'f16',
  'f17',
  'f18',
  'f19',
  'f20',
  'f21',
  'f22',
  'f23',
];

/**
 * Get tile colors for a given frame - maps grid positions to color values
 * @param frameName - The frame to get colors for (e.g. 'f1', 'f2')
 * @param viewportWidth - Width of viewport
 * @param viewportHeight - Height of viewport
 * @param tileSize - Size of each small tile (143px)
 * @param largeTileSize - Size of large tile (429px for 3x3)
 * @returns Map of "row,col" keys to color IDs
 */
export function getTileColorsForFrame(
  frameName: string,
  viewportWidth: number,
  viewportHeight: number,
  tileSize: number,
  largeTileSize: number,
): Map<string, number> {
  const grid = frameGridsData[frameName as keyof typeof frameGridsData];
  if (!grid) return new Map();

  const centerX = viewportWidth / 2;
  const centerY = viewportHeight * 0.4;
  const largeTileHalf = largeTileSize / 2;

  // Large tile top-left corner in grid coordinates
  const largeTileRow = Math.floor((centerY - largeTileHalf) / tileSize);
  const largeTileCol = Math.floor((centerX - largeTileHalf) / tileSize);

  const colors = new Map<string, number>();

  // Grid indices to actual grid positions:
  // Grid row 0 → largeTileRow - 1 (above large tile)
  // Grid row 1 → largeTileRow (top of large tile) <- T markers here
  // Grid row 2 → largeTileRow + 1 (middle) <- T markers here
  // Grid row 3 → largeTileRow + 2 (bottom) <- T markers here
  // Grid row 4 → largeTileRow + 3 (below large tile)
  //
  // Grid col 0-2 → largeTileCol - 3 to -1 (left of large tile)
  // Grid col 3-5 → largeTileCol to +2 (large tile) <- T markers here
  // Grid col 6-8 → largeTileCol + 3 to +5 (right of large tile)

  grid.forEach((row: (number | string)[], rowIdx: number) => {
    const actualRow = largeTileRow + rowIdx - 1;

    row.forEach((val: number | string, colIdx: number) => {
      if (val !== 'T') {
        const actualCol = largeTileCol + colIdx - 3;
        colors.set(`${actualRow},${actualCol}`, val as number);
      }
    });
  });

  return colors;
}
