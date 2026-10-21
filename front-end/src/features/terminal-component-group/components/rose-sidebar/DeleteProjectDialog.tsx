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
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import type { Project } from '@/lib/api/projects';

export function DeleteProjectDialog({
  project,
  onCancel,
  onConfirm,
  inline = false,
}: {
  project: Project | null;
  onCancel: () => void;
  onConfirm: () => void;
  inline?: boolean;
}) {
  const content = (
    <>
      <DialogHeader>
        {inline ? (
          <h2 id="delete-project-title" className="text-lg font-semibold">
            Delete project “{project?.name}”?
          </h2>
        ) : (
          <DialogTitle>Delete project “{project?.name}”?</DialogTitle>
        )}
        {inline ? (
          <p className="text-sm text-muted-foreground dark:text-[#a3a39d]">
            Its agents move back to Home. This cannot be undone.
          </p>
        ) : (
          <DialogDescription className="dark:text-[#a3a39d]">
            Its agents move back to Home. This cannot be undone.
          </DialogDescription>
        )}
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} autoFocus={inline}>
          Cancel
        </Button>
        <Button onClick={onConfirm} className="bg-[#e5484d] text-white hover:bg-[#d13d42]">
          Delete project
        </Button>
      </DialogFooter>
    </>
  );
  if (inline)
    return project === null ? null : (
      <section role="alertdialog" aria-labelledby="delete-project-title" className="space-y-5 p-5">
        {content}
      </section>
    );
  return (
    <Dialog open={project !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md dark:border-white/[0.09] dark:bg-[#262624] dark:text-[#ecece8]">
        {content}
      </DialogContent>
    </Dialog>
  );
}
