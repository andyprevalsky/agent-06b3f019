import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, Sparkles, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { getTools, formatLLMJudgePrompt, Tool } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

interface CreateAgentModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    goal: string;
    tool_ids: string[];
    verifier: {
      type: 'FLOAT_LLM_JUDGE';
      llm_judge_prompt: string;
    };
  }) => Promise<void>;
}

export default function CreateAgentModal({ open, onClose, onSubmit }: CreateAgentModalProps) {
  const [goal, setGoal] = useState('');
  const [llmJudgePrompt, setLlmJudgePrompt] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFormatting, setIsFormatting] = useState(false);
  const { toast } = useToast();

  // Load available tools
  useEffect(() => {
    if (open) {
      getTools().then(setAvailableTools);
    }
  }, [open]);

  const handleToolToggle = (toolId: string) => {
    setSelectedTools((prev) =>
      prev.includes(toolId)
        ? prev.filter((id) => id !== toolId)
        : [...prev, toolId]
    );
  };

  const handleFormatPrompt = async () => {
    if (!llmJudgePrompt.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a prompt to format',
        variant: 'destructive',
      });
      return;
    }

    setIsFormatting(true);
    try {
      const formatted = await formatLLMJudgePrompt(llmJudgePrompt);
      setLlmJudgePrompt(formatted);
      toast({
        title: 'Success',
        description: 'Prompt formatted successfully',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to format prompt',
        variant: 'destructive',
      });
    } finally {
      setIsFormatting(false);
    }
  };

  const handleSubmit = async () => {
    if (!goal.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a goal',
        variant: 'destructive',
      });
      return;
    }

    if (!llmJudgePrompt.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter an LLM judge prompt',
        variant: 'destructive',
      });
      return;
    }

    if (selectedTools.length === 0) {
      toast({
        title: 'Error',
        description: 'Please select at least one tool',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await onSubmit({
        goal,
        tool_ids: selectedTools,
        verifier: {
          type: 'FLOAT_LLM_JUDGE',
          llm_judge_prompt: llmJudgePrompt,
        },
      });

      // Reset form
      setGoal('');
      setLlmJudgePrompt('');
      setSelectedTools([]);
      onClose();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create agent',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-card dark:bg-navi-black border-border">
        <DialogHeader>
          <DialogTitle>Create New Agent</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Goal Input */}
          <div className="space-y-2">
            <Label htmlFor="goal">Goal</Label>
            <Input
              id="goal"
              placeholder="What should this agent accomplish?"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className="bg-background dark:bg-navi-light-black border-border"
            />
          </div>

          {/* LLM Judge Prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="llm-prompt">LLM Judge Prompt</Label>
              <Button
                size="sm"
                variant="outline"
                onClick={handleFormatPrompt}
                disabled={isFormatting}
                className="h-7 text-xs"
              >
                {isFormatting ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    Formatting...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3 w-3 mr-1" />
                    Format Prompt
                  </>
                )}
              </Button>
            </div>
            <Textarea
              id="llm-prompt"
              placeholder="Enter the criteria for judging agent success..."
              value={llmJudgePrompt}
              onChange={(e) => setLlmJudgePrompt(e.target.value)}
              className="min-h-[120px] bg-background dark:bg-navi-light-black border-border"
            />
          </div>

          {/* Tool Selector */}
          <div className="space-y-2">
            <Label>Tools</Label>
            <div className="flex flex-wrap gap-2">
              {availableTools.map((tool) => {
                const isSelected = selectedTools.includes(tool.id);
                return (
                  <Badge
                    key={tool.id}
                    variant={isSelected ? 'default' : 'outline'}
                    className={`cursor-pointer transition-all ${
                      isSelected
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-secondary'
                    }`}
                    onClick={() => handleToolToggle(tool.id)}
                  >
                    {tool.name}
                    {isSelected && <X className="h-3 w-3 ml-1" />}
                  </Badge>
                );
              })}
            </div>
            {availableTools.length === 0 && (
              <p className="text-sm text-muted-foreground">Loading tools...</p>
            )}
          </div>

          {/* Submit Button */}
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Agent'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

