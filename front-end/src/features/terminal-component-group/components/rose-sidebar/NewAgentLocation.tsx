/**
 * STATE MACHINE: desktop + project selected -> show project/folder breadcrumb from shared cache.
 * Mobile (<md) -> hidden; the query box has no location label.
 * Home or an existing agent -> unmounted; pending project query -> hidden until loaded.
 */
import { Folder } from 'lucide-react';
import { useProjects } from './useProjects';

/** Pending project/folder -> compact breadcrumb; shared project cache owns loading. */
export function NewAgentLocation({
  projectId,
  folderId,
}: {
  projectId: string;
  folderId?: string | null;
}) {
  const projects = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const folder = project?.folders?.find((f) => f.id === folderId);
  if (!project) return null;
  return (
    <div
      role="status"
      data-testid="new-agent-location"
      className="mx-auto mb-2 hidden max-w-4xl items-center gap-1.5 px-3 text-xs text-muted-foreground md:flex md:px-0"
    >
      <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        New agent in{' '}
        <span className="font-medium text-foreground">
          {project.name}
          {folder ? ` / ${folder.name}` : ''}
        </span>
      </span>
    </div>
  );
}
