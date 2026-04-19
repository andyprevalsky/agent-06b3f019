import { useEffect, type RefObject } from 'react';

function disableSmoothing(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.imageSmoothingEnabled = false;
}

export function useCanvasSizing(
  dotsRef: RefObject<HTMLCanvasElement>,
  animationsRef: RefObject<HTMLCanvasElement>,
  bordersRef: RefObject<HTMLCanvasElement>,
) {
  useEffect(() => {
    const canvases = [dotsRef.current, animationsRef.current, bordersRef.current];
    if (canvases.some((c) => !c)) return;

    const updateSize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      canvases.forEach((canvas) => {
        if (!canvas) return;
        canvas.width = width;
        canvas.height = height;
        disableSmoothing(canvas);
      });
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, [dotsRef, animationsRef, bordersRef]);
}
