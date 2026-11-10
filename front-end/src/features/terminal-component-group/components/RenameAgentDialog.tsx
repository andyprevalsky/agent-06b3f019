/**
 * STATE MACHINE: RenameAgentDialog
 *
 * [CLOSED] --agent prop set--> [EDITING]
 * [EDITING] --submit non-empty--> [SAVING] --resolve--> [CLOSED] (parent refreshes list)
 *                                          --reject---> [EDITING] (error toast)
 * [EDITING] --Cancel / Esc / empty submit--> [CLOSED]
 *
 * The input seeds from the agent's current display name (title ?? goal) and is
 * re-seeded whenever a different agent is opened.
 */

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

import { AGENT_TITLE_MAX_CHARS, agentDisplayName } from './agentDisplayName';
import type { Agent } from '../hooks';

interface RenameAgentDialogProps {
  /** Non-null opens the dialog for that agent. */
  agent: Pick<Agent, 'agent_id' | 'title' | 'goal'> | null;
  onClose: () => void;
  onSubmit: (agentId: string, title: string) => Promise<void>;
}

export default function RenameAgentDialog({ agent, onClose, onSubmit }: RenameAgentDialogProps) {
  const [value, setValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Re-seed whenever a different agent is opened.
  useEffect(() => {
    if (agent !== null) setValue(agentDisplayName(agent));
  }, [agent]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (agent === null) return;
    const trimmed = value.trim();
    if (trimmed === '') return;
    setIsSaving(true);
    try {
      await onSubmit(agent.agent_id, trimmed);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={agent !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            aria-label="Agent name"
            value={value}
            autoFocus
            maxLength={AGENT_TITLE_MAX_CHARS}
            onChange={(event) => setValue(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={isSaving}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || value.trim() === ''}>
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
