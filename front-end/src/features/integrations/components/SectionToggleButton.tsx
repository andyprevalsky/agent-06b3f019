/**
 * STATE MACHINE: SectionToggleButton
 *
 * [MOUNTED] --> renders connected/unconnected toggle (pure, stateless).
 */

import { Check, RefreshCw } from 'lucide-react';

interface SectionToggleButtonProps {
  isConnected: boolean;
  onClick: () => void;
}

export default function SectionToggleButton({ isConnected, onClick }: SectionToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 ${
        isConnected
          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
          : 'bg-primary text-primary-foreground hover:bg-primary/90'
      }`}
    >
      {isConnected ? <Check className="w-4 h-4" /> : <RefreshCw className="w-4 h-4" />}
    </button>
  );
}
