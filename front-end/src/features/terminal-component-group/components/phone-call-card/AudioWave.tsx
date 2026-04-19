import { memo } from 'react';
import { cn } from '@/lib/utils';

/**
 * Small animated audio-wave indicator shown during a live call.
 */
export const AudioWave = memo(function AudioWave({ isActive }: { isActive: boolean }) {
  return (
    <div className="flex items-center gap-0.5 h-4">
      {[...Array(4)].map((_, i) => (
        <div
          key={i}
          className={cn(
            'w-0.5 bg-green-500 rounded-full transition-all duration-150',
            isActive ? 'animate-pulse' : 'h-1',
          )}
          style={{
            height: isActive ? `${8 + Math.random() * 8}px` : '4px',
            animationDelay: `${i * 100}ms`,
          }}
        />
      ))}
    </div>
  );
});
