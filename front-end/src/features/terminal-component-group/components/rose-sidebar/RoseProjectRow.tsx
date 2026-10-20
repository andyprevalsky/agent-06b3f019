/**
 * STATE MACHINE: RoseProjectRow (Rose left bar project row, UI ledger rows 57/60)
 *
 *   [REST]  folder · name · [+ new agent here] · [⚙ settings]
 *   [REST] --right-click--> [MENU] Rename project | Project settings | Delete project (red)
 *   [MENU] --Rename--> [RENAMING] inline input --Enter (non-empty)--> onRename(name) --> [REST]
 *                                              --Escape | blur--> [REST]
 *   [MENU] --Delete--> onRequestDelete (parent confirms in a dialog)
 *
 * Shown only while the bar is expanded. Active (its settings open, or it holds
 * the selected agent) = rose color + semibold; no fills.
 *
 * NewProjectRow: [IDLE] "+ New project" --click--> [EDITING] inline input
 *   --Enter (non-empty)--> onCreate(name) --> [IDLE];  --Escape | blur--> [IDLE]
 */

import { Folder, Pencil, Plus, Settings as SettingsIcon, Trash2 } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { Project } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

import { ROSE_ACTIVE_COLOR } from './roseSidebarLayout';

const MENU_SURFACE =
  'z-[200] min-w-[236px] rounded-xl border border-gray-200/95 dark:border-white/[0.09] bg-white dark:bg-[#262624] dark:bg-[#2f2f2c] p-[5px] text-sm text-[hsl(240_15%_8%)] dark:text-[#ecece8] shadow-[0_16px_40px_rgba(20,20,40,0.16)]';
const MENU_ROW =
  'h-[34px] gap-[11px] rounded-[7px] px-[11px] py-0 text-sm focus:bg-[hsl(240_10%_96%)] dark:focus:bg-white/[0.06]';
const MENU_ICON = 'h-[17px] w-[17px] flex-none';
const ROW = 'flex h-[38px] flex-none items-center gap-3 whitespace-nowrap pl-[22px] pr-4 text-[13px]';
const ICON_BUTTON = 'flex-none text-[hsl(240_6%_55%)] dark:text-[#a3a39d] hover:text-[hsl(240_15%_8%)] dark:hover:text-[#ecece8]';

function InlineNameInput({
  label,
  initial,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && value.trim() !== '') onSubmit(value.trim());
  };
  return (
    <input
      aria-label={label}
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onCancel}
      className="min-w-0 flex-1 bg-transparent font-semibold text-[hsl(240_15%_8%)] dark:text-[#ecece8] outline-none"
    />
  );
}

export interface RoseProjectRowProps {
  project: Project;
  isActive: boolean;
  isRenaming: boolean;
  onCreateAgent: () => void;
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
    <ContextMenuContent data-testid="rose-project-menu" className={MENU_SURFACE} style={noBlur}>
      <ContextMenuItem onSelect={props.onStartRename} className={MENU_ROW}>
        <Pencil className={icon} strokeWidth={1.7} />
        Rename project
      </ContextMenuItem>
      <ContextMenuItem onSelect={props.onOpenSettings} className={MENU_ROW}>
        <SettingsIcon className={icon} strokeWidth={1.7} />
        Project settings
      </ContextMenuItem>
      <ContextMenuSeparator className="mx-1.5 my-1 bg-gray-200/95 dark:bg-white/[0.09]" />
      <ContextMenuItem
        onSelect={props.onRequestDelete}
        className={cn(MENU_ROW, 'text-[#e5484d] focus:text-[#e5484d]')}
      >
        <Trash2 className={MENU_ICON} strokeWidth={1.7} />
        Delete project
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

export default function RoseProjectRow(props: RoseProjectRowProps) {
  const { project, isActive } = props;
  return (
    <ContextMenu onOpenChange={props.onMenuOpenChange}>
      <ContextMenuTrigger asChild>
        <div
          data-testid={`rose-project-row-${project.id}`}
          className={cn(ROW, isActive ? 'font-semibold' : 'text-[hsl(240_8%_40%)] dark:text-[#a3a39d]')}
          style={isActive ? { color: ROSE_ACTIVE_COLOR } : undefined}
        >
          <Folder className="h-5 w-5 flex-none" strokeWidth={1.7} />
          {props.isRenaming ? (
            <InlineNameInput
              label={`Rename ${project.name}`}
              initial={project.name}
              onSubmit={props.onRename}
              onCancel={props.onCancelRename}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
          )}
          <button
            type="button"
            aria-label={`New agent in ${project.name}`}
            title={`New agent in ${project.name}`}
            onClick={props.onCreateAgent}
            className={ICON_BUTTON}
          >
            <Plus className="h-[15px] w-[15px]" strokeWidth={1.7} />
          </button>
          <button
            type="button"
            aria-label={`${project.name} project settings`}
            title="Project settings"
            onClick={props.onOpenSettings}
            className={cn(ICON_BUTTON, 'ml-1')}
          >
            <SettingsIcon className="h-[15px] w-[15px]" strokeWidth={1.7} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ProjectRowMenu {...props} />
    </ContextMenu>
  );
}

export function NewProjectRow({ onCreate }: { onCreate: (name: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);
  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={() => setIsEditing(true)}
        className="flex h-[30px] flex-none items-center whitespace-nowrap pl-[54px] text-left text-[13px] text-[hsl(240_8%_45%)] dark:text-[#a3a39d] hover:text-[hsl(240_15%_8%)] dark:hover:text-[#ecece8]"
      >
        + New project
      </button>
    );
  }
  return (
    <div className={ROW}>
      <Folder className="h-5 w-5 flex-none text-[hsl(240_8%_40%)] dark:text-[#a3a39d]" strokeWidth={1.7} />
      <InlineNameInput
        label="New project name"
        initial=""
        onSubmit={(name) => {
          setIsEditing(false);
          onCreate(name);
        }}
        onCancel={() => setIsEditing(false)}
      />
    </div>
  );
}
