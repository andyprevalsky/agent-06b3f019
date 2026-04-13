/**
 * Terminal feature — tile animation hook.
 *
 * Manages the frame-by-frame tile color animation with a
 * short initial pause, playing once through to completion.
 */

import { useState, useEffect, useRef } from 'react';

import { FRAME_DURATION_MS } from '../config';
import { frameSequence } from '@/lib/tileAnimation';

export function useTileAnimation() {
  const [currentFrame, setCurrentFrame] = useState(0);
  const [animationComplete, setAnimationComplete] = useState(false);
  const [animationResetKey, setAnimationResetKey] = useState(0);
  const tileAnimationRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (animationComplete) return;

    const startDelay = setTimeout(() => {
      tileAnimationRef.current = setInterval(() => {
        setCurrentFrame((prev) => {
          const nextFrame = prev + 1;
          if (nextFrame >= frameSequence.length) {
            setAnimationComplete(true);
            if (tileAnimationRef.current) {
              clearInterval(tileAnimationRef.current);
            }
            return frameSequence.length - 1;
          }
          return nextFrame;
        });
      }, FRAME_DURATION_MS);
    }, 800);

    return () => {
      clearTimeout(startDelay);
      if (tileAnimationRef.current) {
        clearInterval(tileAnimationRef.current);
      }
    };
  }, [animationComplete]);

  const reset = () => {
    setCurrentFrame(0);
    setAnimationComplete(false);
    setAnimationResetKey((prev) => prev + 1);
  };

  return {
    currentFrame,
    animationComplete,
    animationResetKey,
    reset,
  };
}
