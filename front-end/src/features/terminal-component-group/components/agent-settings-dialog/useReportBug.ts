/**
 * Report-bug flow for AgentSettingsDialog.
 *
 * STATE:
 *   [IDLE] -- start --> [COMPOSING] -- cancel --> [IDLE]
 *      |                     |
 *      |                     +-- submit --> [SUBMITTING] -- ok --> [DONE]
 *      |                                        |
 *      |                                        +-- err --> [COMPOSING]
 *      +-- (agent change / dialog close) --> reset to IDLE
 */

import { useCallback, useEffect, useState } from 'react';
import { reportAgentBug, useToast, type AgentDetail } from '../../hooks';

interface UseReportBugOptions {
  agent: AgentDetail | null;
  open: boolean;
}

export interface UseReportBugResult {
  showComposer: boolean;
  description: string;
  setDescription: (v: string) => void;
  isSubmitting: boolean;
  start: () => void;
  cancel: () => void;
  submit: () => Promise<void>;
}

export function useReportBug({ agent, open }: UseReportBugOptions): UseReportBugResult {
  const { toast } = useToast();
  const [showComposer, setShowComposer] = useState(false);
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setShowComposer(false);
      setDescription('');
      setIsSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    setShowComposer(false);
    setDescription('');
    setIsSubmitting(false);
  }, [agent?.agent_id]);

  const start = useCallback(() => setShowComposer(true), []);
  const cancel = useCallback(() => {
    setShowComposer(false);
    setDescription('');
  }, []);

  const submit = useCallback(async () => {
    if (!agent) return;
    const trimmed = description.trim();
    if (trimmed === '') {
      toast({
        title: 'Description required',
        description: 'Describe the bug before submitting.',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await reportAgentBug(agent.agent_id, trimmed);
      toast({
        title: 'Bug report launched',
        description: result.name,
      });
      if (typeof window !== 'undefined') {
        window.open(result.url, '_blank', 'noopener,noreferrer');
      }
      setShowComposer(false);
      setDescription('');
    } catch (error) {
      toast({
        title: 'Could not report bug',
        description: error instanceof Error ? error.message : 'Failed to launch cloud agent',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [agent, description, toast]);

  return {
    showComposer,
    description,
    setDescription,
    isSubmitting,
    start,
    cancel,
    submit,
  };
}
