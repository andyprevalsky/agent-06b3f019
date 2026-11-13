/**
 * Report-bug flow for ReportBugDialog (its own control, outside Agent Settings).
 *
 * STATE:
 *   [IDLE] -- start --> [COMPOSING] -- cancel --> [IDLE]
 *      |                     |
 *      |                     +-- submit --> [SUBMITTING] -- ok --> [LAUNCHED]
 *      |                                        |
 *      |                                        +-- err --> [COMPOSING]
 *      +-- (agent change / panel close) --> reset to IDLE
 *
 * COMPOSING also accepts dragged or pasted screenshots (useBugReportScreenshots);
 * submit waits until every pending screenshot upload has finished. Screenshots
 * picked with the file control (useBugReportAttachments) show as removable
 * thumbnails and are appended to the description on submit.
 *
 * After launch we keep the boxes.dev link on-screen. Submit must not auto-open
 * it; Open / Copy stay as explicit user-gesture buttons.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { reportAgentBug, useToast, type AgentDetail } from '../../hooks';
import { useBugReportAttachments, type BugReportAttachment } from './useBugReportAttachments';
import { useBugReportScreenshots } from './useBugReportScreenshots';

interface UseReportBugOptions {
  agent: AgentDetail | null;
  open: boolean;
}

export interface LaunchedBugReport {
  name: string;
  url: string;
  run_id: string;
}

export interface UseReportBugResult {
  showComposer: boolean;
  launched: LaunchedBugReport | null;
  description: string;
  setDescription: (v: string) => void;
  isSubmitting: boolean;
  uploadingScreenshots: number;
  /** Returns false when none of the files is an image. */
  attachScreenshots: (files: File[], cursor: number | null) => boolean;
  /** Screenshots picked with the file control, shown as thumbnails. */
  attachments: BugReportAttachment[];
  addAttachments: (files: File[]) => void;
  removeAttachment: (id: number) => void;
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
  const { uploadingCount, resetUploads, attachScreenshots } = useBugReportScreenshots({
    agentId: agent?.agent_id ?? null,
    setDescription,
    generationRef: submitGenerationRef,
  });
  const {
    attachments,
    uploadingCount: uploadingAttachments,
    addAttachments,
    removeAttachment,
    clearAttachments,
    withAttachments,
  } = useBugReportAttachments(agent?.agent_id ?? null, submitGenerationRef);

  useEffect(() => {
    if (!open) {
      submitGenerationRef.current += 1;
      setShowComposer(false);
      setLaunched(null);
      setDescription('');
      setIsSubmitting(false);
      resetUploads();
      clearAttachments();
    }
  }, [open, resetUploads, clearAttachments]);

  useEffect(() => {
    submitGenerationRef.current += 1;
    setShowComposer(false);
    setLaunched(null);
    setDescription('');
    setIsSubmitting(false);
    resetUploads();
    clearAttachments();
  }, [agent?.agent_id, resetUploads, clearAttachments]);

  const start = useCallback(() => {
    setLaunched(null);
    setShowComposer(true);
  }, []);

  const cancel = useCallback(() => {
    setShowComposer(false);
    setDescription('');
    clearAttachments();
  }, [clearAttachments]);

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
      const result = await reportAgentBug(submittedAgentId, withAttachments(trimmed));
      if (submitGenerationRef.current !== generation) return;
      if (agent.agent_id !== submittedAgentId) return;
      setLaunched({ name: result.name, url: result.url, run_id: result.run_id });
      setShowComposer(false);
      setDescription('');
      clearAttachments();
      toast({
        title: 'Bug report launched',
        description: 'A boxes.dev agent is investigating. Tap Open below to follow it.',
      });
    } catch (error) {
      if (submitGenerationRef.current !== generation) return;
      toast({
        title: 'Could not report bug',
        description: error instanceof Error ? error.message : 'Failed to launch bug report agent',
        variant: 'destructive',
      });
    } finally {
      if (submitGenerationRef.current === generation) {
        setIsSubmitting(false);
      }
    }
  }, [agent, description, toast, withAttachments, clearAttachments]);

  return {
    showComposer,
    launched,
    description,
    setDescription,
    isSubmitting,
    uploadingScreenshots: uploadingCount + uploadingAttachments,
    attachScreenshots,
    attachments,
    addAttachments,
    removeAttachment,
    start,
    cancel,
    submit,
    copyLink,
    openLink,
    dismissLaunched,
  };
}
