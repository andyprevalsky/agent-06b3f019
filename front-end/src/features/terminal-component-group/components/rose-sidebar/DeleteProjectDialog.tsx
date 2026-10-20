/**
 * STATE MACHINE: DeleteProjectDialog (UI ledger row 60)
 *
 *   project === null --> closed
 *   project !== null --> [OPEN] --Cancel | Escape | outside--> onCancel
 *                               --Delete project--> onConfirm
 *
 * Deleting a project moves its agents back to Home (server-side).
 */

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { Project } from '@/lib/api/projects';

export function DeleteProjectDialog({
  project,
  onCancel,
  onConfirm,
}: {
  project: Project | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md dark:border-white/[0.09] dark:bg-[#262624] dark:text-[#ecece8]">
        <DialogHeader>
          <DialogTitle>Delete project “{project?.name}”?</DialogTitle>
          <DialogDescription className="dark:text-[#a3a39d]">
            Its agents move back to Home. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} className="bg-[#e5484d] text-white hover:bg-[#d13d42]">
            Delete project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
