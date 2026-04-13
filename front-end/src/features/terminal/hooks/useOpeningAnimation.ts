/**
 * Terminal feature — opening animation hook.
 *
 * Manages the reveal-pause-fade cycle for opening messages
 * displayed when no agent is selected.
 */

import { useState, useEffect } from 'react';

import { OPENING_MESSAGES } from '../config';
import type { AnimationPhase } from '../types';

export function useOpeningAnimation(selectedAgentId: string | null, isLoadingNetwork: boolean) {
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
  const [animationPhase, setAnimationPhase] = useState<AnimationPhase>('revealing');
  const [revealProgress, setRevealProgress] = useState(0);
  const [isTypingComplete, setIsTypingComplete] = useState(false);

  // Reveal animation for opening messages on page load
  useEffect(() => {
    if (selectedAgentId || isLoadingNetwork || isTypingComplete) return;

    if (currentMessageIndex >= OPENING_MESSAGES.length) {
      setIsTypingComplete(true);
      return;
    }

    const [, pauseDuration] = OPENING_MESSAGES[currentMessageIndex];

    if (animationPhase === 'revealing') {
      if (revealProgress < 100) {
        const timer = setTimeout(() => {
          setRevealProgress((prev) => Math.min(100, prev + 2));
        }, 20);
        return () => clearTimeout(timer);
      }
      if (currentMessageIndex === OPENING_MESSAGES.length - 1) {
        setIsTypingComplete(true);
        return;
      }
      setAnimationPhase('paused');
    }

    if (animationPhase === 'paused') {
      const timer = setTimeout(() => {
        setAnimationPhase('fading');
      }, pauseDuration);
      return () => clearTimeout(timer);
    }

    if (animationPhase === 'fading') {
      const timer = setTimeout(() => {
        setCurrentMessageIndex((prev) => prev + 1);
        setAnimationPhase('revealing');
        setRevealProgress(0);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [
    currentMessageIndex,
    animationPhase,
    revealProgress,
    selectedAgentId,
    isLoadingNetwork,
    isTypingComplete,
  ]);

  const reset = () => {
    setCurrentMessageIndex(0);
    setAnimationPhase('revealing');
    setRevealProgress(0);
    setIsTypingComplete(false);
  };

  return {
    currentMessageIndex,
    animationPhase,
    revealProgress,
    isTypingComplete,
    reset,
  };
}
