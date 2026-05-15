const VIEWPORT_SCALE_MIN_WIDTH = 768;
const VIEWPORT_SCALE_DESIGN_WIDTH = 1440;
const VIEWPORT_SCALE_DESIGN_HEIGHT = 900;
const VIEWPORT_SCALE_MIN = 0.7;
const VIEWPORT_REMEASURE_DELAY_MS = 100;

function clampViewportScale(scale: number): number {
  return Math.min(1, Math.max(VIEWPORT_SCALE_MIN, scale));
}

export function computeViewportScale(width: number, height: number): number {
  if (width < VIEWPORT_SCALE_MIN_WIDTH) return 1;

  const widthScale = width / VIEWPORT_SCALE_DESIGN_WIDTH;
  const heightScale = height / VIEWPORT_SCALE_DESIGN_HEIGHT;
  return Number(clampViewportScale(Math.min(widthScale, heightScale)).toFixed(3));
}

export function initViewportScale(): void {
  const setViewportScale = () => {
    const scale = computeViewportScale(window.innerWidth, window.innerHeight);
    document.documentElement.style.setProperty('--app-rem-scale', String(scale));
  };

  setViewportScale();

  window.addEventListener('resize', setViewportScale);
  window.addEventListener('orientationchange', () => {
    setTimeout(setViewportScale, VIEWPORT_REMEASURE_DELAY_MS);
  });
}
