/**
 * STATE MACHINE: ProjectsHub
 * Open -> loading -> list | error(retry). List -> create -> settings(project).
 * Settings reuse the existing repo/env/setup contract; back returns to list.
 * Only the open Projects panel mounts this component and performs its reads.
 */
import { useState } from 'react';
import { ArrowLeft, FolderGit2, Plus, Trash2 } from 'lucide-react';
import type { Project } from '@/lib/api/projects';
import { useRoseApps } from '../rose-apps/roseAppsState';
import { DeleteProjectDialog } from './DeleteProjectDialog';
import RoseProjectSettingsPanel from './RoseProjectSettingsPanel';
import { useCreateProject, useDeleteProject, useProjectsQuery } from './useProjects';

export default function ProjectsHub() {
  const query = useProjectsQuery();
  const create = useCreateProject();
  const remove = useDeleteProject();
  const apps = useRoseApps();
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = query.data?.find((p) => p.id === selected?.id) ?? selected;
  const createProject = async () => {
    if (!name.trim() || create.isPending) return;
    setError(null);
    try {
      setSelected(await create.mutateAsync(name.trim()));
      setName('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create project');
    }
  };
  const deleteProject = async () => {
    if (!deleting) return;
    setError(null);
    try {
      await remove.mutateAsync(deleting.id);
      setSelected(null);
      setDeleting(null);
    } catch {
      setDeleting(null);
      setError('Could not delete project. Try again.');
    }
  };
  return (
    <section aria-label="Projects" className="space-y-5 p-4 text-sm">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {current ? (
        <>
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="flex items-center gap-2 font-semibold"
          >
            <ArrowLeft size={16} />
            All projects
          </button>
          <RoseProjectSettingsPanel
            key={current.id}
            project={current}
            barExpanded={false}
            onClose={() => setSelected(null)}
            embedded
          />
          <div className="flex flex-wrap gap-4 border-t border-border pt-4">
            {apps?.onCreateAgentInProject && (
              <button
                type="button"
                onClick={() => {
                  apps.onCreateAgentInProject?.(current);
                  apps.closeApp();
                }}
                className="font-semibold"
              >
                New agent in this project
              </button>
            )}
            <button
              type="button"
              onClick={() => setDeleting(current)}
              className="flex items-center gap-2 text-destructive"
            >
              <Trash2 size={15} />
              Delete project
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted-foreground">
            Connect a repository, import your development environment, and keep its agents together.
          </p>
          <form
            aria-label="Create project"
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void createProject();
            }}
          >
            <input
              aria-label="Project name"
              placeholder="Project name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2"
            />
            <button
              type="submit"
              disabled={!name.trim() || create.isPending}
              className="flex items-center gap-1 rounded-lg bg-foreground px-3 text-background disabled:opacity-40"
            >
              <Plus size={16} />
              {create.isPending ? 'Creating…' : 'Create'}
            </button>
          </form>
          {query.isPending ? (
            <p role="status">Loading projects…</p>
          ) : query.isError ? (
            <div role="alert">
              <p>Could not load projects. Check your connection and try again.</p>
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="mt-2 font-semibold"
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              {query.data.length === 0 && <p>No projects yet.</p>}
              <div className="space-y-2">
                {query.data.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => setSelected(project)}
                    className="flex w-full items-start gap-3 rounded-xl border border-border p-3 text-left hover:bg-accent"
                  >
                    <FolderGit2 size={20} className="mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      <strong className="block break-words">{project.name}</strong>
                      <span className="block break-all text-muted-foreground">
                        {project.repoUrl ?? 'No repository connected'}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {project.githubConnected
                          ? 'Repository connected'
                          : 'Repository not verified'}{' '}
                        · {project.envFileCount} environment files
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <DeleteProjectDialog
        project={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void deleteProject()}
      />
    </section>
  );
}
