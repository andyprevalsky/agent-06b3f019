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
 *   Archive agent | Pin/Unpin agent · Rename agent | Copy ›
 * (UI #26 removed New agent in this branch, Mark unread, Mute notifications,
 * Share agent, Delete agent and Schedule a prompt…; Archive agent calls the
 * same delete endpoint. The stock Agent Settings gear keeps Delete Agent; the
 * Rose Desktop query-box drawer's settings panel has none.)
 */

import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import {
  Archive,
  ChevronRight,
  Copy,
  Hash,
  Link2,
  Pencil,
  Pin,
  PinOff,
  type LucideIcon,
} from 'lucide-react';

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';

export interface RoseAgentMenuActions {
  onArchive: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onCopyLink: () => void;
  onCopyId: () => void;
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
}: {
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
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
      <Row icon={Archive} label="Archive agent" onSelect={actions.onArchive} destructive />
      <Divider />
      <Row
        icon={isPinned ? PinOff : Pin}
        label={isPinned ? 'Unpin agent' : 'Pin agent'}
        onSelect={actions.onTogglePin}
      />
      <Row icon={Pencil} label="Rename agent" onSelect={actions.onRename} />
      <Divider />
      <CopySubmenu onCopyLink={actions.onCopyLink} onCopyId={actions.onCopyId} />
    </ContextMenuContent>
  );
}
