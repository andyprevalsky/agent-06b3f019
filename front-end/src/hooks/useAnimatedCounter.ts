import { useMotionValue, animate } from 'framer-motion';
import { useEffect, useState } from 'react';

/**
 * Hook for animating a number counter that "spins up" to target value.
 * Uses framer-motion's animate function for smooth interpolation.
 */
export function useAnimatedCounter(targetValue: number, duration: number = 0.5) {
  const [displayValue, setDisplayValue] = useState(0);
  const motionValue = useMotionValue(0);

  useEffect(() => {
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
