/**
 * Delete-agent section: a single trigger button that expands into a
 * "Are you sure?" two-button confirm UI. The confirm button is disabled for
 * the first 1.8s to prevent misclicks (enforced by useDeleteFlow).
 */

import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UseDeleteFlowResult } from './useDeleteFlow';

interface DeleteSectionProps {
  flow: UseDeleteFlowResult;
}

export default function DeleteSection({ flow }: DeleteSectionProps) {
  return (
    <div className="space-y-3 pt-4 border-t border-red-500/30">
      {!flow.showDeleteSection ? (
        <Button
          onClick={flow.startDelete}
          variant="outline"
          className="w-full text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-500/30 hover:border-red-500/50 transition-colors"
        >
          <Trash2 className="h-4 w-4 mr-2" />
          Delete Agent
        </Button>
      ) : (
        <>
          <p className="text-sm text-red-600 dark:text-red-500 font-semibold text-center py-2">
            Are you sure?
          </p>
          <div className="flex gap-2">
            <Button
              onClick={flow.cancelDelete}
              variant="outline"
              className="flex-1"
              disabled={flow.isDeleting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void flow.confirmDelete()}
              disabled={flow.isDeleting || !flow.confirmEnabled}
              className="flex-1 bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {flow.isDeleting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4 mr-2" />
                  {flow.confirmEnabled ? 'Delete' : 'Wait...'}
                </>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
