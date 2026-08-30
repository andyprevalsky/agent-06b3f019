/**
 * Report-bug flow for AgentSettingsDialog.
 *
 * STATE:
 *   [IDLE] -- start --> [COMPOSING] -- cancel --> [IDLE]
 *      |                     |
 *      |                     +-- submit --> [SUBMITTING] -- ok --> [LAUNCHED]
 *      |                                        |
 *      |                                        +-- err --> [COMPOSING]
 *      +-- (agent change / dialog close) --> reset to IDLE
 *
 * After launch we keep the deep link on-screen. API-created Cursor agents
 * often do not appear in the native mobile "rose" inbox (source:api vs
 * source:mobile), and window.open after await is blocked on iOS — so Open /
 * Copy must stay as explicit user-gesture buttons.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { reportAgentBug, useToast, type AgentDetail } from '../../hooks';

interface UseReportBugOptions {
  agent: AgentDetail | null;
  open: boolean;
}

export interface LaunchedBugReport {
  name: string;
  url: string;
  cursor_agent_id: string;
  launch_source: 'scm' | 'api';
}

export interface UseReportBugResult {
  showComposer: boolean;
  launched: LaunchedBugReport | null;
  description: string;
  setDescription: (v: string) => void;
  isSubmitting: boolean;
  start: () => void;
  cancel: () => void;
  submit: () => Promise<void>;
  copyLink: () => Promise<void>;
  openLink: () => void;
  dismissLaunched: () => void;
}

export function useReportBug({ agent, open }: UseReportBugOptions): UseReportBugResult {
  const { toast } = useToast();
  const [showComposer, setShowComposer] = useState(false);
  const [launched, setLaunched] = useState<LaunchedBugReport | null>(null);
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Bumped on dialog close / agent switch so in-flight submits cannot apply
  // stale results to a different agent or a closed dialog.
  const submitGenerationRef = useRef(0);

  useEffect(() => {
    if (!open) {
      submitGenerationRef.current += 1;
      setShowComposer(false);
      setLaunched(null);
      setDescription('');
      setIsSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    submitGenerationRef.current += 1;
    setShowComposer(false);
    setLaunched(null);
    setDescription('');
    setIsSubmitting(false);
  }, [agent?.agent_id]);

  const start = useCallback(() => {
    setLaunched(null);
    setShowComposer(true);
  }, []);

  const cancel = useCallback(() => {
    setShowComposer(false);
    setDescription('');
  }, []);

  const dismissLaunched = useCallback(() => {
    setLaunched(null);
  }, []);

  const openLink = useCallback(() => {
    if (launched === null) return;
    if (typeof window === 'undefined') return;
    window.open(launched.url, '_blank', 'noopener,noreferrer');
  }, [launched]);

  const copyLink = useCallback(async () => {
    if (launched === null) return;
    try {
      await navigator.clipboard.writeText(launched.url);
      toast({ title: 'Link copied', description: launched.url });
    } catch {
      toast({
        title: 'Could not copy',
        description: launched.url,
        variant: 'destructive',
      });
    }
  }, [launched, toast]);

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

    const generation = submitGenerationRef.current;
    const submittedAgentId = agent.agent_id;
    setIsSubmitting(true);
    try {
      const result = await reportAgentBug(submittedAgentId, trimmed);
      if (submitGenerationRef.current !== generation) return;
      if (agent.agent_id !== submittedAgentId) return;
      const launchSource = result.launch_source === 'api' ? 'api' : 'scm';
      setLaunched({
        name: result.name,
        url: result.url,
        cursor_agent_id: result.cursor_agent_id,
        launch_source: launchSource,
      });
      setShowComposer(false);
      setDescription('');
      toast({
        title: 'Bug report launched',
        description:
          launchSource === 'scm'
            ? 'Check your Cursor mobile inbox (or Open below).'
            : 'Open the link below (API launch — enable Filter → Source → API if missing).',
      });
      // Best-effort: may be blocked after await on mobile Safari.
      if (typeof window !== 'undefined') {
        window.open(result.url, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      if (submitGenerationRef.current !== generation) return;
      toast({
        title: 'Could not report bug',
        description: error instanceof Error ? error.message : 'Failed to launch cloud agent',
        variant: 'destructive',
      });
    } finally {
      if (submitGenerationRef.current === generation) {
        setIsSubmitting(false);
      }
    }
  }, [agent, description, toast]);

  return {
    showComposer,
    launched,
    description,
    setDescription,
    isSubmitting,
    start,
    cancel,
    submit,
    copyLink,
    openLink,
    dismissLaunched,
  };
}
