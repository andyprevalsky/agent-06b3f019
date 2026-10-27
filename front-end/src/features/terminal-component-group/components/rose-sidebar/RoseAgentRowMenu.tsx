/**
 * STATE MACHINE: RoseAgentRowMenu (Rose Desktop right-click menu, UI ledger row 37)
 *
 * Stateless; every item delegates to the parent.
 *
 * [CLOSED] --right-click an agent row--> [OPEN]
 * [OPEN] --any item--> parent handler --> [CLOSED]
 * [OPEN] --Copy ›--> [COPY SUBMENU OPEN] --Copy link | Copy agent ID--> [CLOSED]
 *
 * Order (boxes.dev thread-menu style: icon + label rows, dividers, destructive red):
 *   New agent in this branch · Archive agent · Mark unread · Mute notifications ·
 *   Pin/Unpin agent · Rename agent · Share agent · Delete agent ·
 *   Schedule a prompt… · Copy ›
 */

import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import {
  Archive,
  BellOff,
  CalendarClock,
  ChevronRight,
  Copy,
  GitBranch,
  Hash,
  Link2,
  Mail,
  Pencil,
  Pin,
  PinOff,
  Share,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';

export interface RoseAgentMenuActions {
  onNewAgentInBranch: () => void;
  onArchive: () => void;
  onMarkUnread: () => void;
  onMute: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
  onSchedulePrompt: () => void;
  onCopyLink: () => void;
  onCopyId: () => void;
}

/** z-[220] is the shared menu/popover layer (ui/context-menu, ui/popover): above
 * the dialog/sheet modal layer (210), so the menu shows over the mobile drawer. */
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
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  trailing?: ReactNode;
}) {
  return (
    <ContextMenuItem onSelect={onSelect} className={cn(ROW, destructive && DESTRUCTIVE)}>
      <Icon
        className={cn(
          'h-[17px] w-[17px] flex-none',
          destructive ? '' : 'text-[hsl(240_6%_45%)] dark:text-[#a3a39d]',
        )}
        strokeWidth={1.7}
      />
      <span>{label}</span>
      {trailing}
    </ContextMenuItem>
  );
}

function Divider() {
  return <ContextMenuSeparator className="mx-1.5 my-1 bg-gray-200/95 dark:bg-white/[0.07]" />;
}

function CopySubmenu({
  onCopyLink,
  onCopyId,
}: Pick<RoseAgentMenuActions, 'onCopyLink' | 'onCopyId'>) {
  return (
    <ContextMenuPrimitive.Sub>
      <ContextMenuPrimitive.SubTrigger
        className={cn(
          'relative flex w-full cursor-default select-none items-center outline-none',
          ROW,
          'data-[state=open]:bg-[hsl(240_10%_96%)] dark:data-[state=open]:bg-white/[0.06]',
        )}
      >
        <Copy
          className="h-[17px] w-[17px] flex-none text-[hsl(240_6%_45%)] dark:text-[#a3a39d]"
          strokeWidth={1.7}
        />
        <span>Copy</span>
        <ChevronRight className="ml-auto h-4 w-4 text-[hsl(240_6%_55%)] dark:text-[#a3a39d]" />
      </ContextMenuPrimitive.SubTrigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.SubContent className={MENU_SURFACE} style={NO_BLUR}>
          <Row icon={Link2} label="Copy link" onSelect={onCopyLink} />
          <Row icon={Hash} label="Copy agent ID" onSelect={onCopyId} />
        </ContextMenuPrimitive.SubContent>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Sub>
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
      <Row
        icon={GitBranch}
        label="New agent in this branch"
        onSelect={actions.onNewAgentInBranch}
        trailing={
          <span className="ml-auto pl-3 text-[11.5px] text-[hsl(240_6%_58%)] dark:text-[#a3a39d]">
            same E2B session
          </span>
        }
      />
      <Divider />
      <Row icon={Archive} label="Archive agent" onSelect={actions.onArchive} destructive />
      <Divider />
      <Row icon={Mail} label="Mark unread" onSelect={actions.onMarkUnread} />
      <Row icon={BellOff} label="Mute notifications" onSelect={actions.onMute} />
      <Row
        icon={isPinned ? PinOff : Pin}
        label={isPinned ? 'Unpin agent' : 'Pin agent'}
        onSelect={actions.onTogglePin}
      />
      <Row icon={Pencil} label="Rename agent" onSelect={actions.onRename} />
      <Row icon={Share} label="Share agent" onSelect={actions.onShare} />
      <Divider />
      <Row icon={Trash2} label="Delete agent" onSelect={actions.onDelete} destructive />
      <Row icon={CalendarClock} label="Schedule a prompt…" onSelect={actions.onSchedulePrompt} />
      <Divider />
      <CopySubmenu onCopyLink={actions.onCopyLink} onCopyId={actions.onCopyId} />
    </ContextMenuContent>
  );
}
