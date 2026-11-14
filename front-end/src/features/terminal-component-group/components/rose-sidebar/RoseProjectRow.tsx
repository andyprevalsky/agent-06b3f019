/**
 * STATE MACHINE: RoseProjectRow (Rose left bar project row, UI ledger rows 57/60)
 *
 *   [REST]  icon · name · [+ new agent here] · [⚙ settings]
 *           every "+" (Home's too): tooltip and aria-label "Create Super Agent"
 *           icon = ProjectIcon: the GitHub repo owner's avatar when repoUrl is a
 *           GitHub repo, else (or after a load error) the folder (UI item 32)
 *   [REST] --folder-plus--> parent opens a one-level subfolder name editor
 *   [REST] --right-click--> [MENU] Rename folder | Folder settings | Delete folder (red)
 *   [MENU] --Rename--> [RENAMING] inline input --Enter (non-empty)--> onRename(name) --> [REST]
 *                                              --Escape | blur--> [REST]
 *   [MENU] --Delete--> onRequestDelete (parent confirms in a dialog)
 *
 * Shown in both bar widths: collapsed (64px) keeps only the icon at the agent
 * icons' x (name faded out, no buttons), expanded shows the full row. Active
 * (its settings open, or it holds the selected agent) = rose color + semibold.
 *
 * Clicking a project's icon toggles its contents; Home has the same control.
 * The composer labels the next agent's destination without decorating the icon.
 *
 * NewProjectRow: [IDLE] folder-plus · "New folder" (collapsed: icon only, same top
 *   slot, so expanding never shifts the rows below) --click--> [EDITING] inline input
 *   [EDITING] --Enter (non-empty)--> [CREATING] (POST /api/folders { name }; never a repo)
 *   [CREATING] --created | other failure (toast)--> [IDLE]
 *   [CREATING] --409 duplicate name--> [EDITING + inline error] (value kept)
 *   [EDITING + inline error] --type--> [EDITING] (error cleared)
 *   [EDITING] --Escape | blur--> [IDLE]
 */

import {
  Folder,
  FolderPlus,
  Home,
  Pencil,
  Plus,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Project } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

import ProjectIcon from './ProjectIcon';
import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';

const MENU_SURFACE =
  'z-[220] min-w-[236px] rounded-xl border border-gray-200/95 dark:border-white/[0.09] bg-white dark:bg-[#2f2f2c] p-[5px] text-sm text-[hsl(240_15%_8%)] dark:text-[#ecece8] shadow-[0_16px_40px_rgba(20,20,40,0.16)]';
const MENU_ROW =
  'h-[34px] gap-[11px] rounded-[7px] px-[11px] py-0 text-sm focus:bg-[hsl(240_10%_96%)] dark:focus:bg-white/[0.06]';
const MENU_ICON = 'h-[17px] w-[17px] flex-none';
const ROW =
  'flex h-[38px] flex-none items-center gap-3 whitespace-nowrap pl-[22px] pr-4 text-[13px]';
const ICON_BUTTON =
  'flex-none text-[hsl(240_6%_55%)] dark:text-[#a3a39d] hover:text-[hsl(240_15%_8%)] dark:hover:text-[#ecece8]';

function InlineNameInput({
  label,
  initial,
  onSubmit,
  onCancel,
  errorId,
  onEdit,
}: {
  label: string;
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  /** Id of the inline error describing this input; set while it is shown. */
  errorId?: string;
  onEdit?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Focus on the next tick, not via autoFocus: when Rename is chosen from the
  // context menu, the closing menu still holds (and then drops) focus in the
  // same commit, which would blur — i.e. cancel — an autoFocused input.
  useEffect(() => {
    const id = window.setTimeout(() => ref.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
    if (e.key === 'Enter' && value.trim() !== '') onSubmit(value.trim());
  };
  return (
    <input
      ref={ref}
      data-project-name-editor="true"
      aria-label={label}
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        onEdit?.();
      }}
      onKeyDown={onKeyDown}
      onBlur={onCancel}
      aria-invalid={errorId !== undefined}
      aria-describedby={errorId}
      className="min-w-0 flex-1 bg-transparent font-semibold text-[hsl(240_15%_8%)] dark:text-[#ecece8] outline-none"
    />
  );
}

export interface RoseProjectRowProps {
  project: Project;
  isActive: boolean;
  isRenaming: boolean;
  /** Collapsed rail keeps only the icon; defaults to expanded (mobile list). */
  isExpanded?: boolean;
  /** The next new agent is created in this project (its "+" was clicked). */
  isPending?: boolean;
  onCreateAgent: () => void;
  contentsOpen?: boolean;
  contentsToggleDisabled?: boolean;
  onToggleContents?: () => void;
  onCreateFolder?: () => void;
  onOpenSettings: () => void;
  onStartRename: () => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
  onRequestDelete: () => void;
  onMenuOpenChange: (open: boolean) => void;
}

function ProjectRowMenu(props: RoseProjectRowProps) {
  const noBlur = { backdropFilter: 'none', WebkitBackdropFilter: 'none' };
  const icon = cn(MENU_ICON, 'text-[hsl(240_6%_45%)] dark:text-[#a3a39d]');
  return (
    <ContextMenuContent
      data-testid="rose-project-menu"
      className={MENU_SURFACE}
      style={noBlur}
      // Keep focus where the chosen item put it: Rename focuses the inline input,
      // and returning focus to the row would blur (cancel) it immediately.
      onCloseAutoFocus={(e) => e.preventDefault()}
    >
      <ContextMenuItem onSelect={props.onStartRename} className={MENU_ROW}>
        <Pencil className={icon} strokeWidth={1.7} />
        Rename folder
      </ContextMenuItem>
      <ContextMenuItem onSelect={props.onOpenSettings} className={MENU_ROW}>
        <SettingsIcon className={icon} strokeWidth={1.7} />
        Folder settings
      </ContextMenuItem>
      <ContextMenuSeparator className="mx-1.5 my-1 bg-gray-200/95 dark:bg-white/[0.07]" />
      <ContextMenuItem
        onSelect={props.onRequestDelete}
        className={cn(MENU_ROW, 'text-[#e5484d] focus:text-[#e5484d]')}
      >
        <Trash2 className={MENU_ICON} strokeWidth={1.7} />
        Delete folder
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function RowName({ isExpanded, children }: { isExpanded: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'min-w-0 flex-1 truncate transition-opacity duration-200',
        isExpanded ? 'opacity-100' : 'opacity-0',
      )}
    >
      {children}
    </span>
  );
}

function rowTone(isActive: boolean) {
  return {
    className: isActive ? 'font-semibold' : 'text-[hsl(240_8%_40%)] dark:text-[#a3a39d]',
    style: isActive ? { color: ROSE_ACTIVE_COLOR } : undefined,
  };
}

/** Tooltip and accessible name of every group's "+" (Andy, 2026-10-28). */
const CREATE_SUPER_AGENT_LABEL = 'Create Super Agent';

function NewAgentHereButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={CREATE_SUPER_AGENT_LABEL}
          onClick={onClick}
          className={ICON_BUTTON}
        >
          <Plus className="h-[15px] w-[15px]" strokeWidth={1.7} />
        </button>
      </TooltipTrigger>
      <TooltipContent
        data-testid="rose-create-agent-tooltip"
        side="bottom"
        className="px-2 py-1 text-xs"
      >
        {CREATE_SUPER_AGENT_LABEL}
      </TooltipContent>
    </Tooltip>
  );
}

export default function RoseProjectRow(props: RoseProjectRowProps) {
  const { project, isActive } = props;
  const isExpanded = props.isExpanded ?? true;
  const isPending = props.isPending ?? false;
  const tone = rowTone(isActive);
  return (
    <ContextMenu onOpenChange={props.onMenuOpenChange}>
      <ContextMenuTrigger asChild>
        <div
          data-testid={`rose-project-row-${project.id}`}
          data-pending={isPending}
          className={cn(ROW, tone.className)}
          style={tone.style}
        >
          <button
            type="button"
            aria-label={`${props.contentsOpen === false ? 'Expand' : 'Collapse'} ${project.name} folder`}
            aria-expanded={props.contentsOpen !== false}
            aria-controls={`rose-project-group-${project.id}`}
            title={`${props.contentsOpen === false ? 'Expand' : 'Collapse'} ${project.name}`}
            onClick={props.onToggleContents}
            disabled={props.contentsToggleDisabled}
            className="flex-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted"
          >
            <ProjectIcon repoUrl={project.repoUrl} />
          </button>
          {props.isRenaming && isExpanded ? (
            <InlineNameInput
              label={`Rename ${project.name}`}
              initial={project.name}
              onSubmit={props.onRename}
              onCancel={props.onCancelRename}
            />
          ) : (
            <RowName isExpanded={isExpanded}>{project.name}</RowName>
          )}
          {isExpanded && (
            <>
              <NewAgentHereButton onClick={props.onCreateAgent} />
              {props.onCreateFolder && (
                <button
                  type="button"
                  aria-label={`New subfolder in ${project.name}`}
                  title="New subfolder"
                  onClick={props.onCreateFolder}
                  className={ICON_BUTTON}
                >
                  <FolderPlus className="h-[15px] w-[15px]" strokeWidth={1.7} />
                </button>
              )}
              <button
                type="button"
                aria-label={`${project.name} folder settings`}
                title="Folder settings"
                onClick={props.onOpenSettings}
                className={cn(ICON_BUTTON, 'ml-1')}
              >
                <SettingsIcon className="h-[15px] w-[15px]" strokeWidth={1.7} />
              </button>
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ProjectRowMenu {...props} />
    </ContextMenu>
  );
}

/** The Home project: every agent without a project; always last. */
export function HomeProjectRow({
  isExpanded,
  isActive,
  isPending,
  onCreateAgent,
  contentsOpen = true,
  contentsToggleDisabled = false,
  onToggleContents,
}: {
  isExpanded: boolean;
  isActive: boolean;
  isPending: boolean;
  contentsOpen?: boolean;
  contentsToggleDisabled?: boolean;
  onToggleContents?: () => void;
  /** Absent (e.g. the mobile list, which has its own New Super Agent): no "+". */
  onCreateAgent?: () => void;
}) {
  const tone = rowTone(isActive);
  return (
    <div
      data-testid="rose-home-project-row"
      data-pending={isPending}
      className={cn(ROW, tone.className)}
      style={tone.style}
    >
      <button
        type="button"
        aria-label={`${contentsOpen ? 'Collapse' : 'Expand'} Home`}
        aria-expanded={contentsOpen}
        aria-controls="rose-project-group-home"
        title={`${contentsOpen ? 'Collapse' : 'Expand'} Home`}
        onClick={onToggleContents}
        disabled={contentsToggleDisabled}
        className="flex-none rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted"
      >
        <Home className="h-5 w-5 flex-none" strokeWidth={1.7} />
      </button>
      <RowName isExpanded={isExpanded}>Home</RowName>
      {isExpanded && onCreateAgent !== undefined && <NewAgentHereButton onClick={onCreateAgent} />}
    </div>
  );
}

const NEW_PROJECT_ERROR_ID = 'rose-new-project-error';

export function NewProjectRow({
  onCreate,
  isExpanded = true,
}: {
  /** Resolves to an inline error (duplicate name) or null when the row can close. */
  onCreate: (name: string) => Promise<string | null>;
  /** Collapsed rail keeps the folder-plus icon in the same top slot (label faded). */
  isExpanded?: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setIsEditing(false);
    setError(null);
  };
  if (!isEditing) {
    return (
      <button
        type="button"
        aria-label="+ New folder"
        tabIndex={isExpanded ? 0 : -1}
        onClick={() => {
          setError(null);
          setIsEditing(true);
        }}
        className={cn(
          ROW,
          'w-full text-left text-[hsl(240_8%_45%)] dark:text-[#a3a39d] hover:text-[hsl(240_15%_8%)] dark:hover:text-[#ecece8]',
        )}
      >
        <FolderPlus className="h-5 w-5 flex-none" strokeWidth={1.7} />
        <RowName isExpanded={isExpanded}>New folder</RowName>
      </button>
    );
  }
  return (
    <div className="flex flex-none flex-col">
      <div className={ROW}>
        <Folder
          className="h-5 w-5 flex-none text-[hsl(240_8%_40%)] dark:text-[#a3a39d]"
          strokeWidth={1.7}
        />
        <InlineNameInput
          label="New folder name"
          initial=""
          errorId={error === null ? undefined : NEW_PROJECT_ERROR_ID}
          onEdit={() => setError(null)}
          onSubmit={(name) => {
            void onCreate(name).then((inlineError) => {
              if (inlineError === null) close();
              else setError(inlineError);
            });
          }}
          onCancel={close}
        />
      </div>
      {error !== null && (
        <p
          id={NEW_PROJECT_ERROR_ID}
          data-testid={NEW_PROJECT_ERROR_ID}
          role="alert"
          className="whitespace-normal pb-1 pl-[54px] pr-4 text-[12px] text-[#e5484d]"
        >
          {error}
        </p>
      )}
    </div>
  );
}
