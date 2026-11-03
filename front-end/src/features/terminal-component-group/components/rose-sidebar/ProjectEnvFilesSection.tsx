/**
 * STATE MACHINE: ProjectEnvFilesSection (project settings → Environment files)
 *
 * Its own resource, saved immediately (not part of the panel's Save draft):
 *   GET    /api/projects/:id/env-files          rows (values are never returned)
 *   DELETE /api/projects/:id/env-files/:fileId  trash
 *   POST   /api/projects/:id/env-files          + Add a file { path, description?, content? }
 * Header count = project.envFileCount (refetched after every add/delete).
 *
 *   list: [LOADING] --ok--> [ROWS] | --fail--> [LOAD ERROR] (muted text)
 *   search: '' --type--> rows filtered by path, description or variable name
 *   row: [COLLAPSED] --click ▸--> [EXPANDED] (variable NAMES only) --click ▾--> [COLLAPSED]
 *   trash: [ROW] --click--> [DELETING] --ok--> row gone | --fail--> [ROW] + error
 *   add: [IDLE] --"+ Add a file"--> [FORM] (path, description, dotenv paste)
 *        [FORM] --Cancel--> [IDLE];  --Add file (path set)--> [ADDING]
 *        [ADDING] --ok--> [IDLE] (new row listed) | --fail--> [FORM] + error
 */

import { ChevronRight, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import type { NewProjectEnvFile, ProjectEnvFile } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';
import {
  useCreateProjectEnvFile,
  useDeleteProjectEnvFile,
  useProjectEnvFiles,
} from './useProjects';

const MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';
const MONO = 'font-mono text-[12.5px]';
const ERROR = 'text-[#e5484d]';
const INPUT =
  'w-full rounded-[9px] border border-[#eef0f3] dark:border-white/[0.09] bg-transparent px-3 py-2 outline-none placeholder:text-[hsl(240_6%_60%)] dark:placeholder:text-[#a3a39d]';

function matches(file: ProjectEnvFile, needle: string): boolean {
  if (needle === '') return true;
  const haystack = [file.path, file.description ?? '', ...file.variables.map((v) => v.name)];
  return haystack.some((text) => text.toLowerCase().includes(needle));
}

function EnvFileRow({
  file,
  isExpanded,
  isDeleting,
  onToggle,
  onRemove,
}: {
  file: ProjectEnvFile;
  isExpanded: boolean;
  isDeleting: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      data-testid="project-env-file"
      className="border-b border-gray-100 dark:border-white/[0.07] py-[9px]"
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${file.path}`}
          aria-expanded={isExpanded}
          onClick={onToggle}
          className={MUTED}
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')}
          />
        </button>
        <span className="min-w-0 flex-1">
          <span className={cn(MONO, 'block truncate')}>{file.path}</span>
          {file.description !== null && file.description !== '' && (
            <span className={cn('block text-[12px]', MUTED)}>{file.description}</span>
          )}
        </span>
        <button
          type="button"
          aria-label={`Remove ${file.path}`}
          disabled={isDeleting}
          onClick={onRemove}
          className="text-[hsl(240_6%_60%)] dark:text-[#a3a39d] hover:text-[#e5484d] disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {isExpanded &&
        (file.variables.length === 0 ? (
          <p className={cn('mt-2 pl-6 text-[12px]', MUTED)}>No variables</p>
        ) : (
          <ul aria-label={`Variables in ${file.path}`} className="mt-2 flex flex-col gap-1 pl-6">
            {file.variables.map((variable) => (
              <li key={variable.name} className="text-[12px]">
                <span className={MONO}>{variable.name}</span>
                {variable.description !== undefined && variable.description !== '' && (
                  <span className={MUTED}> · {variable.description}</span>
                )}
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function AddEnvFileForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const create = useCreateProjectEnvFile(projectId);
  const canAdd = path.trim() !== '' && !create.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canAdd) return;
    const file: NewProjectEnvFile = { path: path.trim() };
    if (description.trim() !== '') file.description = description.trim();
    if (content.trim() !== '') file.content = content;
    create.mutate(file, { onSuccess: onDone });
  };
  return (
    <form
      aria-label="Add an environment file"
      onSubmit={submit}
      className="mt-2.5 flex flex-col gap-2"
    >
      <input
        aria-label="File path"
        autoFocus
        value={path}
        placeholder="path/to/.env"
        onChange={(e) => setPath(e.target.value)}
        className={cn(INPUT, MONO)}
      />
      <input
        aria-label="File description"
        value={description}
        placeholder="What this file is for"
        onChange={(e) => setDescription(e.target.value)}
        className={INPUT}
      />
      <textarea
        aria-label="Paste .env contents"
        value={content}
        rows={5}
        spellCheck={false}
        placeholder="KEY=value"
        onChange={(e) => setContent(e.target.value)}
        className={cn(INPUT, 'resize-y font-mono text-[11.5px] leading-[1.55]')}
      />
      <div className="flex items-center justify-end gap-3">
        {create.isError && <span className={ERROR}>Could not add the file</span>}
        <button type="button" onClick={onDone} className={MUTED}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canAdd}
          className="font-semibold disabled:opacity-40"
          style={{ color: ROSE_ACTIVE_COLOR }}
        >
          {create.isPending ? 'Adding…' : 'Add file'}
        </button>
      </div>
    </form>
  );
}

export function ProjectEnvFilesSection({
  projectId,
  envFileCount,
}: {
  projectId: string;
  envFileCount: number;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const files = useProjectEnvFiles(projectId);
  const remove = useDeleteProjectEnvFile(projectId);
  const needle = query.trim().toLowerCase();
  const visible = (files.data ?? []).filter((file) => matches(file, needle));
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <section aria-label="Environment files">
      <h3 className="mb-2 mt-[22px] text-[13px] font-semibold">
        Environment files <span className={cn('font-normal', MUTED)}>· {envFileCount}</span>
      </h3>
      <p className={MUTED}>Workspaces get these files with managed values.</p>
      <label className="mb-1 mt-2 flex items-center gap-2 rounded-[9px] border border-[#eef0f3] dark:border-white/[0.09] px-3 py-2">
        <Search className="h-3.5 w-3.5 text-[hsl(240_6%_60%)] dark:text-[#a3a39d]" />
        <input
          type="search"
          aria-label="Search environment files"
          placeholder="Search by name, file or description"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full bg-transparent outline-none placeholder:text-[hsl(240_6%_60%)] dark:placeholder:text-[#a3a39d]"
        />
      </label>
      {files.isError && <p className={MUTED}>Could not load environment files</p>}
      {visible.map((file) => (
        <EnvFileRow
          key={file.id}
          file={file}
          isExpanded={expanded.has(file.id)}
          isDeleting={remove.isPending && remove.variables === file.id}
          onToggle={() => toggle(file.id)}
          onRemove={() => remove.mutate(file.id)}
        />
      ))}
      {remove.isError && <p className={cn('mt-2', ERROR)}>Could not remove the file</p>}
      {isAdding ? (
        <AddEnvFileForm projectId={projectId} onDone={() => setIsAdding(false)} />
      ) : (
        <button
          type="button"
          onClick={() => setIsAdding(true)}
          className="mt-2.5 font-semibold"
          style={{ color: ROSE_ACTIVE_COLOR }}
        >
          + Add a file
        </button>
      )}
    </section>
  );
}
