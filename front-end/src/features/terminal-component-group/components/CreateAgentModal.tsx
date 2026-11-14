/**
 * STATE MACHINE: CreateAgentModal
 *
 * [CLOSED] <-- open: false
 *     |
 *     v (open=true)
 * [OPEN]
 *     |
 *     +--> [EDITING] <-- isSubmitting: false
 *     |       |
 *     |       +--> goal: string (required)
 *     |       +--> selectedModel: string
 *     |       +--> reasoningEffort: 'off'|'low'|'medium'|'high'
 *     |       +--> selectedTools: string[]
 *     |       +--> githubRepoRef: '' (inherit) | connected canonical ref
 *     |       |
 *     |       | (submit, goal non-empty)
 *     |       v
 *     |   [SUBMITTING] <-- isSubmitting: true
 *     |       |
 *     |       +--> (success) --> close modal (onClose)
 *     |       +--> (error)   --> toast error --> [EDITING]
 *     |       +--> (repo not connected) --> inline repo error --> [EDITING]
 *
 * All state transitions, side effects, and validation live in
 * ./create-agent-modal/useCreateAgentForm.ts. This component is a thin view.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormActions } from './create-agent-modal/FormActions';
import { GithubRepoSelect } from './create-agent-modal/GithubRepoSelect';
import { GoalInput } from './create-agent-modal/GoalInput';
import { JudgePromptInput } from './create-agent-modal/JudgePromptInput';
import { ModelSelect } from './create-agent-modal/ModelSelect';
import { ReasoningEffortSelect } from './create-agent-modal/ReasoningEffortSelect';
import { ToolPicker } from './create-agent-modal/ToolPicker';
import { useCreateAgentForm } from './create-agent-modal/useCreateAgentForm';
import type { CreateAgentSubmitData } from './create-agent-modal/types';
import { useAppData } from '../hooks';

interface CreateAgentModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: CreateAgentSubmitData) => Promise<void>;
}

export default function CreateAgentModal({ open, onClose, onSubmit }: CreateAgentModalProps) {
  const { models } = useAppData();
  const form = useCreateAgentForm({ open, onClose, onSubmit });

  const handleGenerate = () => {
    void form.generatePrompt();
  };
  const handleSubmit = () => {
    void form.submit();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-card dark:bg-navi-black border-border">
        <DialogHeader>
          <DialogTitle>Create New Agent</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <GoalInput goal={form.goal} onChange={form.setGoal} />

          <JudgePromptInput
            value={form.llmJudgePrompt}
            onChange={form.setLlmJudgePrompt}
            goal={form.goal}
            isFormatting={form.isFormatting}
            onGenerate={handleGenerate}
          />

          <ReasoningEffortSelect value={form.reasoningEffort} onChange={form.setReasoningEffort} />

          <ModelSelect
            models={models}
            selectedModel={form.selectedModel}
            onChange={form.setSelectedModel}
          />

          <GithubRepoSelect
            repos={form.githubRepo.githubRepos}
            value={form.githubRepo.githubRepoRef}
            onChange={form.githubRepo.setGithubRepoRef}
            loadError={form.githubRepo.githubReposError}
            error={form.githubRepo.githubRepoRefError}
          />

          <ToolPicker
            tools={form.availableTools}
            selectedTools={form.selectedTools}
            onToggle={form.toggleTool}
          />

          <FormActions
            isSubmitting={form.isSubmitting}
            onCancel={onClose}
            onSubmit={handleSubmit}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
