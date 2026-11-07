/**
 * STATE MACHINE: RoseAgentRowMenu (Rose Desktop right-click menu, UI ledger row 37)
 *
 * Stateless; every item delegates to the parent.
 *
 * [CLOSED] --right-click an agent row--> [OPEN]
 * [OPEN] --any item--> parent handler --> [CLOSED]
 * [OPEN] --Copy ›--> [COPY SUBMENU OPEN] --Copy link | Copy agent ID--> [CLOSED]
 * [OPEN] --Move to… ›--> [MOVE SUBMENU OPEN] (every project, its folders indented
 *   below it, then Home; the current location is checked and disabled)
 *   --pick a destination--> actions.move.onMove(target) --> [CLOSED]
 *   (the parent moves the row optimistically; see useAgentPlacementMoves)
 * Keyboard: ArrowRight/Enter opens a submenu, arrows move, Enter picks, Escape closes.
 *
 * Order (boxes.dev thread-menu style: icon + label rows, dividers, destructive red):
 *   Archive agent | Pin/Unpin agent · Rename agent · Move to… ›¹ | Copy ›
 *   ¹ only where the caller supplies `move` (the desktop bar).
 * (UI #26 removed New agent in this branch, Mark unread, Mute notifications,
 * Share agent, Delete agent and Schedule a prompt…; Archive agent calls the
 * same delete endpoint. The stock Agent Settings gear keeps Delete Agent; the
 * Rose Desktop query-box drawer's settings panel has none.)
 */

import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import {
  Archive,
  Check,
  ChevronRight,
  Copy,
  Folder,
  FolderInput,
  Hash,
  Home,
  Link2,
  Pencil,
  Pin,
  PinOff,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import type { Project } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

import type { AgentPlacement } from './useAgentPlacementMoves';

export interface AgentMoveMenu {
  /** Destinations in sidebar order (each project's folders follow it); Home last. */
  projects: Project[];
  current: AgentPlacement;
  onMove: (target: AgentPlacement) => void;
}

export interface RoseAgentMenuActions {
  onArchive: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onCopyLink: () => void;
  onCopyId: () => void;
  move?: AgentMoveMenu;
}

/** z-[220] is the shared menu/popover layer (ui/context-menu, ui/popover): above
 * the dialog/sheet modal tier (210/211), so the menu shows over the mobile drawer. */
const MENU_SURFACE =
  'z-[220] min-w-[236px] rounded-xl border border-gray-200/95 dark:border-white/[0.09] bg-white dark:bg-[#2f2f2c] p-[5px] text-sm text-[hsl(240_15%_8%)] dark:text-[#ecece8] shadow-[0_16px_40px_rgba(20,20,40,0.16)]';
const ROW =
  'h-[34px] gap-[11px] rounded-[7px] px-[11px] py-0 text-sm focus:bg-[hsl(240_10%_96%)] dark:focus:bg-white/[0.06] focus:text-[hsl(240_15%_8%)] dark:focus:text-[#ecece8]';
const DESTRUCTIVE = 'text-[#e5484d] focus:text-[#e5484d]';
const NO_BLUR = { backdropFilter: 'none', WebkitBackdropFilter: 'none' };

function Row({
  icon: Icon,
  label,
  onSelect,
  destructive = false,
  checked,
  inset = false,
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  /** Move destinations: the current location is checked and cannot be picked. */
  checked?: boolean;
  inset?: boolean;
}) {
  return (
    <ContextMenuItem
      onSelect={onSelect}
      disabled={checked === true}
      aria-current={checked === true ? 'location' : undefined}
      className={cn(ROW, destructive && DESTRUCTIVE, inset && 'pl-[33px]')}
    >
      <Icon
        className={cn(
          'h-[17px] w-[17px] flex-none',
          destructive ? '' : 'text-[hsl(240_6%_45%)] dark:text-[#a3a39d]',
        )}
        strokeWidth={1.7}
      />
      <span className={cn(checked !== undefined && 'min-w-0 flex-1 truncate')}>{label}</span>
      {checked === true && (
        <Check
          aria-hidden="true"
          className="h-4 w-4 flex-none text-[hsl(240_6%_45%)] dark:text-[#a3a39d]"
        />
      )}
    </ContextMenuItem>
  );
}

function Divider() {
  return <ContextMenuSeparator className="mx-1.5 my-1 bg-gray-200/95 dark:bg-white/[0.07]" />;
}

function Submenu({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <ContextMenuPrimitive.Sub>
      <ContextMenuPrimitive.SubTrigger
        className={cn(
          'relative flex w-full cursor-default select-none items-center outline-none',
          ROW,
          'data-[state=open]:bg-[hsl(240_10%_96%)] dark:data-[state=open]:bg-white/[0.06]',
        )}
      >
        <Icon
          className="h-[17px] w-[17px] flex-none text-[hsl(240_6%_45%)] dark:text-[#a3a39d]"
          strokeWidth={1.7}
        />
        <span>{label}</span>
        <ChevronRight className="ml-auto h-4 w-4 text-[hsl(240_6%_55%)] dark:text-[#a3a39d]" />
      </ContextMenuPrimitive.SubTrigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.SubContent
          className={cn(MENU_SURFACE, 'max-h-[420px] max-w-[300px] overflow-y-auto')}
          style={NO_BLUR}
        >
          {children}
        </ContextMenuPrimitive.SubContent>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Sub>
  );
}

function MoveSubmenu({ projects, current, onMove }: AgentMoveMenu) {
  const at = (project_id: string | null, folder_id: string | null) =>
    current.project_id === project_id && current.folder_id === folder_id;
  return (
    <Submenu icon={FolderInput} label="Move to…">
      {projects.map((project) => (
        <ContextMenuPrimitive.Group key={project.id} aria-label={project.name}>
          <Row
            icon={Folder}
            label={project.name}
            checked={at(project.id, null)}
            onSelect={() => onMove({ project_id: project.id, folder_id: null })}
          />
          {(project.folders ?? []).map((folder) => (
            <Row
              key={folder.id}
              icon={Folder}
              label={folder.name}
              inset
              checked={at(project.id, folder.id)}
              onSelect={() => onMove({ project_id: project.id, folder_id: folder.id })}
            />
          ))}
        </ContextMenuPrimitive.Group>
      ))}
      {projects.length > 0 && <Divider />}
      <Row
        icon={Home}
        label="Home"
        checked={at(null, null)}
        onSelect={() => onMove({ project_id: null, folder_id: null })}
      />
    </Submenu>
  );
}

export default function RoseAgentRowMenu({
  isPinned,
  actions,
}: {
  isPinned: boolean;
  actions: RoseAgentMenuActions;
}) {
  return (
    <ContextMenuContent data-testid="rose-agent-menu" className={MENU_SURFACE} style={NO_BLUR}>
      <Row icon={Archive} label="Archive agent" onSelect={actions.onArchive} destructive />
      <Divider />
      <Row
        icon={isPinned ? PinOff : Pin}
        label={isPinned ? 'Unpin agent' : 'Pin agent'}
        onSelect={actions.onTogglePin}
      />
      <Row icon={Pencil} label="Rename agent" onSelect={actions.onRename} />
      {actions.move !== undefined && <MoveSubmenu {...actions.move} />}
      <Divider />
      <Submenu icon={Copy} label="Copy">
        <Row icon={Link2} label="Copy link" onSelect={actions.onCopyLink} />
        <Row icon={Hash} label="Copy agent ID" onSelect={actions.onCopyId} />
      </Submenu>
    </ContextMenuContent>
  );
}
