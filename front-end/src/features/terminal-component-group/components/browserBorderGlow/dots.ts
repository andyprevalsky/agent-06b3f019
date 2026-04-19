import { CONFIG, type Dot } from './config';

interface Corner {
  x: number;
  y: number;
}

function getCorners(width: number, height: number): Corner[] {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

function findClosestCorner(
  x: number,
  y: number,
  corners: Corner[],
): { minCornerDist: number; closestCorner: number } {
  let minCornerDist = Infinity;
  let closestCorner = 0;
  for (let i = 0; i < corners.length; i++) {
    const corner = corners[i];
    const dist = Math.sqrt((x - corner.x) ** 2 + (y - corner.y) ** 2);
    if (dist < minCornerDist) {
      minCornerDist = dist;
      closestCorner = i;
    }
  }
  return { minCornerDist, closestCorner };
}

/** Generate the dot positions that populate corner + edge glow regions. */
export function generateDots(width: number, height: number, dpr: number): Dot[] {
  const dots: Dot[] = [];
  const { gridSpacing, cornerRadius, edgeRadius } = CONFIG;
  const scaledSpacing = Math.max(2, gridSpacing * dpr);
  const scaledCornerRadius = cornerRadius * dpr;
  const scaledEdgeRadius = edgeRadius * dpr;
  const corners = getCorners(width, height);

  for (let x = 0; x < width; x += scaledSpacing) {
    for (let y = 0; y < height; y += scaledSpacing) {
      const { minCornerDist, closestCorner } = findClosestCorner(x, y, corners);
      const edgeDist = Math.min(x, y, width - x, height - y);

      const inCornerRegion = minCornerDist < scaledCornerRadius;
      const inEdgeRegion = edgeDist < scaledEdgeRadius;

      if (inCornerRegion || inEdgeRegion) {
        dots.push({
          x: Math.floor(x),
          y: Math.floor(y),
          cornerIndex: closestCorner,
          cornerDist: minCornerDist / scaledCornerRadius,
          edgeDist: edgeDist / scaledEdgeRadius,
          flickerPhase: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  return dots;
}
