import { cn } from '@/lib/utils';

interface StatusOverlayProps {
  isResuming: boolean;
  onResume: () => void;
}

export function StatusOverlay({ isResuming, onResume }: StatusOverlayProps) {
  return (
    <div className="absolute inset-0 backdrop-blur-md flex items-center justify-center">
      <button
        onClick={onResume}
        disabled={isResuming}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded-lg border border-foreground/20 bg-foreground/10 text-foreground text-xs shadow-sm transition-colors',
          isResuming
            ? 'opacity-50 cursor-not-allowed'
            : 'hover:bg-foreground/20 cursor-pointer',
        )}
      >
        {isResuming ? 'Loading...' : 'Take Control'}
      </button>
    </div>
  );
}
