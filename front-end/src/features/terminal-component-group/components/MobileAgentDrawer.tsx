/**
 * STATE MACHINE: MobileAgentDrawer
 *
 * OPEN STATE:
 * [CLOSED] --tap trigger--> [OPEN]
 * [OPEN] --select agent / create agent / overlay tap / Esc / close--> [CLOSED]
 *
 * Mobile-only (trigger is `md:hidden`) slide-over that surfaces the SAME
 * SidebarAgentList the desktop AppSidebar renders — the desktop sidebar is
 * `hidden md:flex`, so below the md breakpoint the agent list is otherwise
 * unreachable. Selecting an agent or creating one closes the sheet.
 *
 * SYSTEM CONTEXT:
 * mobile user tap -> TerminalHeader -> MobileAgentDrawer.onSelectAgent
 * -> useTerminalAgents.handleSelectAgent (same handler the desktop rail uses)
 *
 * Desktop is unaffected: the trigger never renders (>= md) so the sheet has
 * no entry point.
 */

import { useState } from 'react';
import { Menu, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

import SidebarAgentList from './SidebarAgentList';
import type { Agent } from '../hooks';

interface MobileAgentDrawerProps {
  agents: Agent[];
  isLoadingAgents: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onCreateAgent: () => void;
  onResumeAgent: (agentId: string) => Promise<void>;
  resumingAgentId: string | null;
}

export default function MobileAgentDrawer({
  agents,
  isLoadingAgents,
  selectedAgentId,
  onSelectAgent,
  onCreateAgent,
  onResumeAgent,
  resumingAgentId,
}: MobileAgentDrawerProps) {
  const [open, setOpen] = useState(false);

  const handleSelectAgent = (agentId: string | null) => {
    onSelectAgent(agentId);
    setOpen(false);
  };

  const handleCreateAgent = () => {
    onCreateAgent();
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open agents menu"
          className="md:hidden flex h-8 w-8 items-center justify-center rounded-lg hover:bg-muted transition-colors"
        >
          <Menu className="h-5 w-5 text-muted-foreground" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="flex w-[min(320px,85vw)] flex-col p-0">
        <SheetTitle className="px-4 pt-4 text-base">Agents</SheetTitle>
        <SheetDescription className="sr-only">Your active and recent agents</SheetDescription>
        <div className="p-3">
          <Button onClick={handleCreateAgent} className="w-full">
            <Plus className="mr-2 h-4 w-4" />
            Create Agent
          </Button>
        </div>
        <SidebarAgentList
          agents={agents}
          isLoadingAgents={isLoadingAgents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
          onResumeAgent={onResumeAgent}
          resumingAgentId={resumingAgentId}
          isCollapsed={false}
        />
      </SheetContent>
    </Sheet>
  );
}
