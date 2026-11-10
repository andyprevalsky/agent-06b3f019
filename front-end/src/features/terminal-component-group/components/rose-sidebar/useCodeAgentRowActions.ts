/**
 * STATE MACHINE: code-session row actions
 * IDLE -> Rename -> EDITING -> Save -> SAVING -> IDLE (persisted title)
 *                                             -> IDLE (error toast)
 * Copy writes the code task ID; neither action selects or renames its owner.
 * No subscriptions or polling. A save updates only cached pages for this root.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { renameCodeAgent, type CodeAgentListItem } from '@/lib/api/tree';

export function useCodeAgentRowActions(codeAgent: CodeAgentListItem) {
  const [editing, setEditing] = useState(false);
  const client = useQueryClient();
  const { toast } = useToast();
  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(codeAgent.code_agent_id);
      toast({ title: 'Agent ID copied' });
    } catch {
      toast({ title: 'Error', description: 'Failed to copy agent ID', variant: 'destructive' });
    }
  };
  const save = async (taskId: string, title: string) => {
    try {
      await renameCodeAgent(taskId, title);
      client.setQueriesData<CodeAgentListItem[]>(
        {
          queryKey: ['rose-code-agents'],
          predicate: (query) =>
            typeof query.queryKey[1] === 'string' &&
            query.queryKey[1].split(',').includes(codeAgent.root_agent_id),
        },
        (rows) => rows?.map((row) => (row.code_agent_id === taskId ? { ...row, title } : row)),
      );
      setEditing(false);
    } catch {
      toast({ title: 'Error', description: 'Failed to rename code agent', variant: 'destructive' });
    }
  };
  return { editing, setEditing, copyId, save };
}
