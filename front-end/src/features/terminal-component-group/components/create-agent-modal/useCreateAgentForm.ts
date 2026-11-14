import { useCallback, useEffect, useState } from 'react';
import { generateLLMJudgePrompt, getTools, useToast, type Tool } from '../../hooks';
import type { CreateAgentSubmitData, ReasoningEffort } from './types';
import { useGithubRepoSelection } from './useGithubRepoSelection';

interface UseCreateAgentFormArgs {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateAgentSubmitData) => Promise<void>;
}

const DEFAULT_MODEL = 'rose-labs/rose-1-ultra';
const DEFAULT_EFFORT: ReasoningEffort = 'high';

/**
 * Centralizes all form state + side effects for CreateAgentModal.
 * Keeps the view components dumb: they take values + change handlers.
 */
export function useCreateAgentForm({ open, onClose, onSubmit }: UseCreateAgentFormArgs) {
  const { toast } = useToast();

  const [goal, setGoal] = useState('');
  const [llmJudgePrompt, setLlmJudgePrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(DEFAULT_EFFORT);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFormatting, setIsFormatting] = useState(false);
  const repo = useGithubRepoSelection(open);

  useEffect(() => {
    if (!open) return;
    void getTools().then((tools) => setAvailableTools(tools));
  }, [open]);

  const toggleTool = useCallback((toolId: string) => {
    setSelectedTools((prev) =>
      prev.includes(toolId) ? prev.filter((id) => id !== toolId) : [...prev, toolId],
    );
  }, []);

  const generatePrompt = useCallback(async () => {
    if (!goal.trim()) {
      toast({ title: 'Error', description: 'Please enter a goal first', variant: 'destructive' });
      return;
    }
    setIsFormatting(true);
    try {
      const generated = await generateLLMJudgePrompt(goal.trim());
      setLlmJudgePrompt(generated);
      toast({ title: 'Success', description: 'Prompt generated successfully' });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to generate prompt',
        variant: 'destructive',
      });
    } finally {
      setIsFormatting(false);
    }
  }, [goal, toast]);

  const submit = useCallback(async () => {
    if (!goal.trim()) {
      toast({ title: 'Error', description: 'Please enter a goal', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    try {
      const fields = { model: selectedModel, reasoning_effort: reasoningEffort };
      await onSubmit({ goal, ...fields, ...repo.requestField() });
      setGoal('');
      setSelectedModel(DEFAULT_MODEL);
      setReasoningEffort(DEFAULT_EFFORT);
      onClose();
    } catch (error) {
      const description = repo.describeSubmitError(error);
      toast({ title: 'Error', description, variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  }, [goal, onSubmit, selectedModel, reasoningEffort, repo, onClose, toast]);

  return {
    goal,
    setGoal,
    llmJudgePrompt,
    setLlmJudgePrompt,
    selectedModel,
    setSelectedModel,
    reasoningEffort,
    setReasoningEffort,
    selectedTools,
    toggleTool,
    availableTools,
    githubRepo: repo,
    isSubmitting,
    isFormatting,
    generatePrompt,
    submit,
  };
}
