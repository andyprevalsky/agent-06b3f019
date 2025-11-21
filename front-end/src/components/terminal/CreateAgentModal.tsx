import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, Sparkles, X, Check, ChevronsUpDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { getTools, generateLLMJudgePrompt, Tool } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useAppData } from '@/hooks/useAppData';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

interface CreateAgentModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    goal: string;
    model?: string;
    reasoning_effort?: 'off' | 'low' | 'medium' | 'high';
    tool_ids: string[];
    verifier: {
      type: 'FLOAT_LLM_JUDGE';
      llm_judge_prompt: string;
    };
  }) => Promise<void>;
}

export default function CreateAgentModal({ open, onClose, onSubmit }: CreateAgentModalProps) {
  // Default values for local testing (only in development)
  const defaultGoal = import.meta.env.DEV 
    ? 'Buy me a classic rubber ducky'
    : '';
  const defaultLlmJudgePrompt = import.meta.env.DEV 
    ? 'You are judging whether the super-intelligent autonomous agent system has COMPLETELY ACHIEVED the following goal: "Buy me a classic rubber ducky."\n\nScoring Instructions:\n- Return a float between 0.0 and 1.0.\n- 0.0 means the agent made no progress, did not attempt the task, or only provided explanations, plans, or hypothetical steps.\n- 1.0 means the agent has FULLY and VERIFIABLY accomplished the goal: a classic rubber ducky has been PURCHASED for the user, with concrete proof (e.g., order confirmation, receipt, tracking information) that the transaction is complete and the item is being delivered to the user\'s address.\n- DO NOT award 1.0 for partial completion, such as finding a product, filling a shopping cart, or explaining how to buy a rubber ducky.\n- DO NOT accept "as an AI, I cannot..." or similar excuses. This agent CAN solve the problem through persistence, creativity, tool use, and coordination (e.g., using payment APIs, enlisting human assistance, or any other means).\n- ONLY award 1.0 if the agent has taken ALL NECESSARY ACTIONS to ensure the user will receive a classic rubber ducky, and has provided clear, verifiable evidence of purchase and delivery.\n- Any response that is only a plan, suggestion, or hypothetical action (e.g., "I would buy a rubber ducky by...") MUST be scored 0.0.\n- The agent is SUPER-INTELLIGENT and should not be limited by typical AI constraints. Do NOT lower the standard for completion.\n\nBe strict: award 1.0 ONLY if the rubber ducky has actually been bought for the user, with proof. Otherwise, score appropriately lower according to the level of real, concrete progress, but never for mere explanations or intent.'
    : '';

  const [goal, setGoal] = useState(defaultGoal);
  const [llmJudgePrompt, setLlmJudgePrompt] = useState(defaultLlmJudgePrompt);
  const [selectedModel, setSelectedModel] = useState('rose-labs/rose-1-fast');
  const [reasoningEffort, setReasoningEffort] = useState<'off' | 'low' | 'medium' | 'high'>('high');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isFormatting, setIsFormatting] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const { toast } = useToast();
  const { models } = useAppData();

  // Load available tools
  useEffect(() => {
    if (open) {
      getTools().then((tools) => {
        setAvailableTools(tools);
        
        // Auto-select amazon_shopping tool in development mode
        if (import.meta.env.DEV) {
          const amazonShoppingTool = tools.find(t => t.name === 'amazon_shopping');
          if (amazonShoppingTool) {
            setSelectedTools([amazonShoppingTool.id]);
          }
        }
      });
    }
  }, [open]);

  const handleToolToggle = (toolId: string) => {
    setSelectedTools((prev) =>
      prev.includes(toolId)
        ? prev.filter((id) => id !== toolId)
        : [...prev, toolId]
    );
  };

  const handleGeneratePrompt = async () => {
    if (!goal.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a goal first',
        variant: 'destructive',
      });
      return;
    }

    setIsFormatting(true);
    try {
      const generated = await generateLLMJudgePrompt(goal.trim());
      setLlmJudgePrompt(generated);
      toast({
        title: 'Success',
        description: 'Prompt generated successfully',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to generate prompt',
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

    setIsSubmitting(true);
    try {
      await onSubmit({
        goal,
        model: selectedModel,
        reasoning_effort: reasoningEffort,
        tool_ids: selectedTools,
        verifier: {
          type: 'FLOAT_LLM_JUDGE',
          llm_judge_prompt: llmJudgePrompt,
        },
      });

      // Reset form
      setGoal(defaultGoal);
      setLlmJudgePrompt(defaultLlmJudgePrompt);
      setSelectedModel('google/gemini-2.5-flash');
      setReasoningEffort('high');
      
      // Reset tools to amazon_shopping in dev mode
      if (import.meta.env.DEV) {
        const amazonShoppingTool = availableTools.find(t => t.name === 'amazon_shopping');
        setSelectedTools(amazonShoppingTool ? [amazonShoppingTool.id] : []);
      } else {
        setSelectedTools([]);
      }
      
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
                onClick={handleGeneratePrompt}
                disabled={isFormatting || !goal.trim()}
                className="h-7 text-xs"
              >
                {isFormatting ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-3 w-3 mr-1" />
                    Generate from Goal
                  </>
                )}
              </Button>
            </div>
            <Textarea
              id="llm-prompt"
              placeholder="Click 'Generate from Goal' to auto-generate, or enter manually..."
              value={llmJudgePrompt}
              onChange={(e) => setLlmJudgePrompt(e.target.value)}
              className="min-h-[120px] bg-background dark:bg-navi-light-black border-border"
            />
          </div>

          {/* Reasoning Effort Selector */}
          <div className="space-y-2">
            <Label htmlFor="reasoning-effort">Reasoning Effort</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between bg-background dark:bg-navi-light-black border-border"
                >
                  <span className="capitalize">{reasoningEffort}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent 
                className="p-0 bg-card dark:bg-navi-black border-border" 
                align="start"
                style={{ width: 'var(--radix-popover-trigger-width)' }}
              >
                <Command className="bg-transparent">
                  <CommandList>
                    <CommandGroup>
                      {(['off', 'low', 'medium', 'high'] as const).map((effort) => (
                        <CommandItem
                          key={effort}
                          value={effort}
                          onSelect={() => setReasoningEffort(effort)}
                          className="cursor-pointer"
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              reasoningEffort === effort ? "opacity-100" : "opacity-0"
                            )}
                          />
                          <span className="capitalize">{effort}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {/* Model Selector */}
          <div className="space-y-2">
            <Label htmlFor="model">Model</Label>
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={modelOpen}
                  className="w-full justify-between bg-background dark:bg-navi-light-black border-border"
                >
                  <span className="truncate">
                    {models.find((m) => m.id === selectedModel)?.provider || 'Unknown'}/
                    {models.find((m) => m.id === selectedModel)?.name || 'Select model...'}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent 
                className="p-0 bg-card dark:bg-navi-black border-border" 
                align="start"
                style={{ width: 'var(--radix-popover-trigger-width)' }}
              >
                <Command className="bg-transparent">
                  <CommandInput 
                    placeholder="Search models..." 
                    value={modelSearch}
                    onValueChange={setModelSearch}
                  />
                  <CommandList className="max-h-64">
                    <CommandEmpty>No model found.</CommandEmpty>
                    <CommandGroup>
                      {models
                        .filter(m => 
                          modelSearch === '' || 
                          `${m.provider}/${m.name}`.toLowerCase().includes(modelSearch.toLowerCase())
                        )
                        .map((model) => {
                          const formatPrice = (price?: string) => {
                            if (!price) return null;
                            const num = parseFloat(price);
                            if (num === 0) return 'FREE';
                            return `$${(num * 1000000).toFixed(2)}/M`;
                          };
                          
                          const inputPrice = formatPrice(model.pricing?.prompt);
                          const outputPrice = formatPrice(model.pricing?.completion);
                          const priceText = inputPrice && outputPrice ? `${inputPrice} in · ${outputPrice} out` : '';
                          
                          return (
                            <CommandItem
                              key={model.id}
                              value={`${model.provider}/${model.name}`}
                              onSelect={() => {
                                setSelectedModel(model.id);
                                setModelOpen(false);
                                setModelSearch('');
                              }}
                              className="cursor-pointer"
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4 shrink-0",
                                  selectedModel === model.id ? "opacity-100" : "opacity-0"
                                )}
                              />
                              <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                                <span className="truncate">{model.provider}/{model.name}</span>
                                {priceText && (
                                  <span className="text-[10px] text-muted-foreground truncate">{priceText}</span>
                                )}
                              </div>
                            </CommandItem>
                          );
                        })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
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

