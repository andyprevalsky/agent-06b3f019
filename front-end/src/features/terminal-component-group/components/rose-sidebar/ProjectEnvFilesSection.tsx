/**
 * STATE MACHINE: ProjectEnvFilesSection (project settings → Environment files)
 *
 *   search: '' --type--> rows filtered by path or description (case-insensitive)
 *   row: [COLLAPSED] --click ▸--> [EXPANDED] (description editor) --click ▾--> [COLLAPSED]
 *   trash --> row removed from the draft (saved with the panel's Save)
 *   + Add a file --> new empty row appended, expanded, path editable
 *
 * Draft state lives in useProjectSettingsForm; only search/expansion is local.
 */

import { ChevronRight, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { ProjectEnvFile } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';

const MUTED = 'text-[hsl(240_8%_45%)] dark:text-[#a3a39d]';
const MONO = 'font-mono text-[12.5px]';

function EnvFileRow({
  file,
  index,
  isExpanded,
  onToggle,
  onChange,
  onRemove,
}: {
  file: ProjectEnvFile;
  index: number;
  isExpanded: boolean;
  onToggle: () => void;
  onChange: (next: ProjectEnvFile) => void;
  onRemove: () => void;
}) {
  const label = file.path === '' ? `file ${index + 1}` : file.path;
  return (
    <div
      data-testid="project-env-file"
      className="border-b border-gray-100 dark:border-white/[0.09] py-[9px]"
    >
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${label}`}
          aria-expanded={isExpanded}
          onClick={onToggle}
          className={MUTED}
        >
          <ChevronRight
            className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-90')}
          />
        </button>
        <input
          aria-label={`Path of ${label}`}
          value={file.path}
          placeholder="path/to/.env"
          onChange={(e) => onChange({ ...file, path: e.target.value })}
          className={cn(MONO, 'min-w-0 flex-1 bg-transparent outline-none')}
        />
        <button
          type="button"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
          className="text-[hsl(240_6%_60%)] dark:text-[#a3a39d] hover:text-[#e5484d]"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      {isExpanded && (
        <input
          aria-label={`Description of ${label}`}
          value={file.description}
          placeholder="What this file is for"
          onChange={(e) => onChange({ ...file, description: e.target.value })}
          className={cn('mt-2 w-full bg-transparent pl-6 text-[12.5px] outline-none', MUTED)}
        />
      )}
    </div>
  );
}

export function ProjectEnvFilesSection({
  envFiles,
  onChange,
}: {
  envFiles: ProjectEnvFile[];
  onChange: (next: (files: ProjectEnvFile[]) => ProjectEnvFile[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const needle = query.trim().toLowerCase();
  const visible = envFiles
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => `${file.path} ${file.description}`.toLowerCase().includes(needle));
  const toggle = (index: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  return (
    <section aria-label="Environment files">
      <h3 className="mb-2 mt-[22px] text-[13px] font-semibold">
        Environment files <span className={cn('font-normal', MUTED)}>· {envFiles.length}</span>
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
      {visible.map(({ file, index }) => (
        <EnvFileRow
          key={index}
          file={file}
          index={index}
          isExpanded={expanded.has(index)}
          onToggle={() => toggle(index)}
          onChange={(next) => onChange((files) => files.map((f, i) => (i === index ? next : f)))}
          onRemove={() => {
            setExpanded(new Set());
            onChange((files) => files.filter((_, i) => i !== index));
          }}
        />
      ))}
      <button
        type="button"
        onClick={() => {
          setExpanded((prev) => new Set(prev).add(envFiles.length));
          onChange((files) => [...files, { path: '', description: '' }]);
        }}
        className="mt-2.5 font-semibold"
        style={{ color: ROSE_ACTIVE_COLOR }}
      >
        + Add a file
      </button>
    </section>
  );
}
