/**
 * STATE MACHINE: useAnimatedCounter
 *
 * [IDLE / target = 0]
 *   | first positive target (initial mount or a new stream)
 *   v
 * [FIRST VALUE / paint target synchronously]
 *   | later positive target
 *   v
 * [ANIMATING / 300ms easeOut interpolation]
 *   | target = 0
 *   v
 * [IDLE / reset motion value and display to 0]
 */

import { useMotionValue, animate } from 'framer-motion';
import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Hook for animating a number counter that "spins up" to target value.
 * Uses framer-motion's animate function for smooth interpolation.
 */
export function useAnimatedCounter(targetValue: number, duration: number = 0.5) {
  const initialMotionValue = targetValue > 0 ? targetValue : 0;
  const [displayValue, setDisplayValue] = useState(Math.round(initialMotionValue));
  const motionValue = useMotionValue(initialMotionValue);
  const previousTargetRef = useRef(0);

  useLayoutEffect(() => {
    const previousTarget = previousTargetRef.current;
    previousTargetRef.current = targetValue;

    if (targetValue <= 0) {
      motionValue.set(0);
      setDisplayValue(0);
      return undefined;
    }

    if (previousTarget <= 0) {
      motionValue.set(targetValue);
      setDisplayValue(Math.round(targetValue));
      return undefined;
    }

    const controls = animate(motionValue, targetValue, {
      duration,
      ease: 'easeOut',
      onUpdate: (latest) => {
        setDisplayValue(Math.round(latest));
      },
    });

    return () => controls.stop();
  }, [targetValue, duration, motionValue]);

  return displayValue;
}
