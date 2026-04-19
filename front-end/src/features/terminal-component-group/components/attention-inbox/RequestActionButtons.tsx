/**
 * Three-button action row for an attention request: Skip, Reject, Accept.
 */

import { Button } from '@/components/ui/button';

interface RequestActionButtonsProps {
  requestId: string;
  loading: boolean;
  onSkip: (requestId: string) => void;
  onReject: (requestId: string) => void;
  onAccept: (requestId: string) => void;
}

export function RequestActionButtons({
  requestId,
  loading,
  onSkip,
  onReject,
  onAccept,
}: RequestActionButtonsProps) {
  return (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => onSkip(requestId)} disabled={loading}>
        Skip
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onReject(requestId)}
        disabled={loading}
        className="text-red-600 border-red-300 hover:bg-red-50 dark:text-red-400 dark:border-red-700 dark:hover:bg-red-900/20"
      >
        Reject
      </Button>
      <Button
        size="sm"
        onClick={() => onAccept(requestId)}
        disabled={loading}
        className="bg-green-600 hover:bg-green-700 text-white"
      >
        Accept
      </Button>
    </div>
  );
}
