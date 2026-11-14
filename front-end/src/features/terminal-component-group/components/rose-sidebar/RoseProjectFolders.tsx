/**
 * STATE MACHINE: project -> folders (one level) -> agents.
 * [LIST] --project folder-plus--> [NEW NAME] --save--> [LIST + folder]
 * [FOLDER OPEN] <--> [FOLDER CLOSED]; filtering temporarily opens matching folders.
 * [LIST] --folder menu--> [RENAME | DELETE CONFIRM] --success--> [LIST]
 * Failed writes retain the editor/confirmation and show an inline error.
 * Deletion removes only the container: its agents return to the project root.
 * Folder "+" selects (project, folder); project "+" selects (project, null).
 */
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Plus,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  deleteProjectFolder,
  moveProjectFolder,
  saveProjectFolder,
  type Project,
  type ProjectFolder,
} from '@/lib/api/projects';
import { cn } from '@/lib/utils';
import type { Agent } from '../../hooks';
import { PROJECTS_QUERY_KEY } from './useProjects';
import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';

const folderGroupKey = (id: string) => `folder:${id}`;
const FOLDER_DRAG_TYPE = 'application/x-rose-project-folder';

export function FolderAgentCount({ count, active }: { count: number; active: boolean }) {
  return (
    <span
      role="img"
      aria-label={`${count} ${count === 1 ? 'agent' : 'agents'}`}
      title={`${count} ${count === 1 ? 'agent' : 'agents'}`}
      className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center"
      style={active ? { color: ROSE_ACTIVE_COLOR } : undefined}
    >
      <Folder aria-hidden="true" className="h-6 w-6" strokeWidth={1.4} />
      <span
        aria-hidden="true"
        data-testid="folder-agent-count"
        className={cn(
          'absolute bottom-[4px] left-1/2 -translate-x-1/2 px-[1px] font-semibold tabular-nums leading-[9px] text-foreground',
          count >= 100 ? 'text-[8px] tracking-[-0.3px]' : 'text-[9px]',
        )}
      >
        {count > 999 ? '999+' : count}
      </span>
    </span>
  );
}

function FolderNameEditor({
  initial = '',
  onSave,
  onCancel,
}: {
  initial?: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => input.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const submit = async () => {
    if (!value.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      await onSave(value.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save subfolder.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="py-1 pl-[38px] pr-4">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          aria-label={initial ? 'Rename subfolder' : 'New subfolder name'}
          maxLength={100}
          placeholder="Subfolder name"
          value={value}
          disabled={saving}
          aria-invalid={Boolean(error)}
          onChange={(e) => {
            setValue(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !saving) {
              e.stopPropagation();
              onCancel();
            }
          }}
          className="min-w-0 flex-1 rounded border border-input bg-transparent px-2 py-1 text-[13px] outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="submit"
          disabled={saving || !value.trim()}
          className="text-xs font-medium disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          aria-label="Cancel subfolder editing"
          disabled={saving}
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </form>
      {error && (
        <p role="alert" className="pt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function FolderGroup({
  folder,
  agents,
  project,
  expanded,
  filtering,
  selectedAgentId,
  pending,
  onCreateAgent,
  onMenuOpenChange,
  renderAgents,
  index,
  folderCount,
  reordering,
  dragging,
  dropEdge,
  onMove,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  folder: ProjectFolder;
  agents: Agent[];
  project: Project;
  expanded: boolean;
  filtering: boolean;
  selectedAgentId: string | null;
  pending: boolean;
  onCreateAgent: (project: Project, folderId?: string | null) => void;
  onMenuOpenChange: (open: boolean) => void;
  renderAgents: (agents: Agent[], key: string) => ReactNode;
  index: number;
  folderCount: number;
  reordering: boolean;
  dragging: boolean;
  dropEdge?: 'before' | 'after';
  onMove: (direction: -1 | 1) => void;
  onDragStart: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (menu || renaming || deleting) onMenuOpenChange(true);
    return () => {
      if (menu || renaming || deleting) onMenuOpenChange(false);
    };
  }, [menu, renaming, deleting, onMenuOpenChange]);
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true });
  const selected = agents.some((a) => a.agent_id === selectedAgentId);
  useEffect(() => {
    if (selected || pending) setOpen(true);
  }, [selected, pending]);
  const shown = filtering || open;
  if (renaming)
    return (
      <FolderNameEditor
        initial={folder.name}
        onCancel={() => setRenaming(false)}
        onSave={async (name) => {
          await saveProjectFolder(project.id, name, folder.id);
          await refresh();
          setRenaming(false);
        }}
      />
    );
  return (
    <div data-testid={`rose-folder-${folder.id}`}>
      <div
        data-pending={pending}
        draggable={!filtering && !reordering && !busy && !menu}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={cn(
          'group flex h-[34px] items-center gap-1 pr-4 text-[13px]',
          expanded ? 'pl-[30px]' : 'pl-[22px]',
          pending && 'bg-primary/5',
          dragging && 'opacity-40',
          dropEdge === 'before' && 'shadow-[inset_0_2px_0_hsl(var(--primary))]',
          dropEdge === 'after' && 'shadow-[inset_0_-2px_0_hsl(var(--primary))]',
        )}
        style={selected || pending ? { color: ROSE_ACTIVE_COLOR } : undefined}
      >
        <button
          type="button"
          aria-label={`${shown ? 'Collapse' : 'Expand'} subfolder ${folder.name}`}
          aria-expanded={shown}
          onClick={() => setOpen(!shown)}
          title={folder.name}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-muted-foreground hover:text-foreground"
        >
          {expanded && (shown ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
          <FolderAgentCount count={agents.length} active={selected || pending} />
          {expanded && (
            <>
              <span
                className={cn(
                  'min-w-0 flex-1 truncate',
                  (selected || pending) && 'font-medium text-foreground',
                )}
              >
                {folder.name}
              </span>
            </>
          )}
        </button>
        {expanded && (
          <>
            <button
              type="button"
              aria-label={`Create Super Agent in ${folder.name}`}
              title={`Create Super Agent in ${folder.name}`}
              onClick={() => onCreateAgent(project, folder.id)}
              className="ml-1 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <Plus size={14} />
            </button>
            <Popover open={menu} onOpenChange={setMenu}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={`${folder.name} subfolder options`}
                  className="rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal size={14} />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="z-[230] w-44 p-1"
                role="menu"
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                {[
                  {
                    label: 'Move up',
                    direction: -1 as const,
                    disabled: index === 0,
                    Icon: ArrowUp,
                  },
                  {
                    label: 'Move down',
                    direction: 1 as const,
                    disabled: index === folderCount - 1,
                    Icon: ArrowDown,
                  },
                ].map(({ label, direction, disabled, Icon }) => (
                  <button
                    key={label}
                    type="button"
                    role="menuitem"
                    disabled={disabled || reordering || filtering}
                    className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
                    onClick={() => {
                      setMenu(false);
                      onMove(direction);
                    }}
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  role="menuitem"
                  className="w-full rounded px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setMenu(false);
                    setRenaming(true);
                  }}
                >
                  Rename subfolder
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="w-full rounded px-3 py-2 text-left text-sm text-destructive hover:bg-muted"
                  onClick={() => {
                    setMenu(false);
                    setError('');
                    setDeleting(true);
                  }}
                >
                  Delete subfolder
                </button>
              </PopoverContent>
            </Popover>
          </>
        )}
      </div>
      {shown && (
        <div className={expanded ? 'ml-3 border-l border-border/50' : undefined}>
          {agents.length
            ? renderAgents(agents, folderGroupKey(folder.id))
            : expanded && (
                <p className="py-1.5 pl-[54px] text-xs text-muted-foreground">No agents yet</p>
              )}
        </div>
      )}
      <Dialog
        open={deleting}
        onOpenChange={(value) => {
          if (!busy) setDeleting(value);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete subfolder “{folder.name}”?</DialogTitle>
            <DialogDescription>
              Its agents stay in {project.name}, outside any folder.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              className="bg-destructive text-destructive-foreground"
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await deleteProjectFolder(project.id, folder.id);
                  await refresh();
                  setDeleting(false);
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Could not delete subfolder.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Deleting…' : 'Delete subfolder'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function RoseProjectFolders({
  project,
  agents,
  creating,
  onCancelCreate,
  expanded,
  filtering,
  selectedAgentId,
  pendingGroupKey,
  onCreateAgent,
  onMenuOpenChange,
  renderAgents,
}: {
  project: Project;
  agents: Agent[];
  creating: boolean;
  onCancelCreate: () => void;
  expanded: boolean;
  filtering: boolean;
  selectedAgentId: string | null;
  pendingGroupKey?: string | null;
  onCreateAgent: (project: Project, folderId?: string | null) => void;
  onMenuOpenChange: (open: boolean) => void;
  renderAgents: (agents: Agent[], key: string) => ReactNode;
}) {
  const cache = useQueryClient();
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);
  const [reordering, setReordering] = useState(false);
  const reorderInFlight = useRef(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(
    null,
  );
  const [orderError, setOrderError] = useState('');
  useEffect(() => {
    if (creating) onMenuOpenChange(true);
    return () => {
      if (creating) onMenuOpenChange(false);
    };
  }, [creating, onMenuOpenChange]);
  const savedFolders = project.folders ?? [];
  const rank = new Map(optimisticOrder?.map((id, index) => [id, index]));
  const folders = optimisticOrder
    ? [...savedFolders].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
    : savedFolders;
  const reorder = async (ids: string[], movedId: string) => {
    if (reorderInFlight.current || filtering) return;
    if (ids.every((id, index) => folders[index]?.id === id)) return;
    reorderInFlight.current = true;
    setReordering(true);
    setOrderError('');
    setOptimisticOrder(ids);
    try {
      await cache.cancelQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true });
      const nextFolders = await moveProjectFolder(
        project.id,
        movedId,
        ids[ids.indexOf(movedId) + 1] ?? null,
      );
      cache.setQueryData<Project[]>(PROJECTS_QUERY_KEY, (current) =>
        current?.map((row) => (row.id === project.id ? { ...row, folders: nextFolders } : row)),
      );
      void cache.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true });
    } catch (err) {
      setOrderError(err instanceof Error ? err.message : 'Could not reorder subfolders.');
      void cache.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true });
    } finally {
      setOptimisticOrder(null);
      setReordering(false);
      reorderInFlight.current = false;
    }
  };
  const endDrag = () => {
    setDraggedId(null);
    setDropTarget(null);
  };
  const byFolder = new Map(folders.map((folder) => [folder.id, [] as Agent[]]));
  const root: Agent[] = [];
  for (const agent of agents)
    ((agent.folder_id && byFolder.get(agent.folder_id)) || root).push(agent);
  return (
    <>
      {creating && expanded && (
        <FolderNameEditor
          onCancel={onCancelCreate}
          onSave={async (name) => {
            await saveProjectFolder(project.id, name);
            await cache.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true });
            onCancelCreate();
          }}
        />
      )}
      {renderAgents(root, project.id)}
      {orderError && (
        <p role="alert" className="px-5 py-1 text-xs text-destructive">
          {orderError}
        </p>
      )}
      {folders.map((folder, index) => {
        const rows = byFolder.get(folder.id)!;
        if (filtering && !rows.length) return null;
        return (
          <FolderGroup
            key={folder.id}
            folder={folder}
            agents={rows}
            project={project}
            expanded={expanded}
            filtering={filtering}
            selectedAgentId={selectedAgentId}
            pending={pendingGroupKey === folderGroupKey(folder.id)}
            onCreateAgent={onCreateAgent}
            onMenuOpenChange={onMenuOpenChange}
            renderAgents={renderAgents}
            index={index}
            folderCount={folders.length}
            reordering={reordering}
            dragging={draggedId === folder.id}
            dropEdge={dropTarget?.id === folder.id ? dropTarget.edge : undefined}
            onMove={(direction) => {
              const ids = folders.map((row) => row.id);
              const target = index + direction;
              if (target < 0 || target >= ids.length) return;
              [ids[index], ids[target]] = [ids[target], ids[index]];
              void reorder(ids, folder.id);
            }}
            onDragStart={(event) => {
              if (filtering || reorderInFlight.current) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id);
              setDraggedId(folder.id);
            }}
            onDragEnd={endDrag}
            onDragOver={(event) => {
              if (!draggedId || draggedId === folder.id || filtering || reordering) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const rect = event.currentTarget.getBoundingClientRect();
              setDropTarget({
                id: folder.id,
                edge: event.clientY >= rect.top + rect.height / 2 ? 'after' : 'before',
              });
            }}
            onDrop={(event) => {
              if (!draggedId || draggedId === folder.id || filtering || reordering) return;
              event.preventDefault();
              const ids = folders.map((row) => row.id).filter((id) => id !== draggedId);
              const rect = event.currentTarget.getBoundingClientRect();
              const offset = event.clientY >= rect.top + rect.height / 2 ? 1 : 0;
              ids.splice(ids.indexOf(folder.id) + offset, 0, draggedId);
              endDrag();
              void reorder(ids, draggedId);
            }}
          />
        );
      })}
    </>
  );
}
