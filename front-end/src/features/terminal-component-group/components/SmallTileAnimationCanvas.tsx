/**
 * STATE MACHINE: Desktop tile animation boundary
 * [NOT_MOUNTED/mobile] -> no renderer or animation-data download
 * [MOUNTED/LOADING] -> Suspense -> [READY] unchanged desktop canvas renderer
 */
import { lazy, Suspense } from 'react';
import type { SmallTileAnimationCanvasProps } from './SmallTileAnimationCanvasRenderer';

const Renderer = lazy(() => import('./SmallTileAnimationCanvasRenderer'));

export default function SmallTileAnimationCanvas(props: SmallTileAnimationCanvasProps) {
  return (
    <Suspense fallback={null}>
      <Renderer {...props} />
    </Suspense>
  );
}
