import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Settings, Loader2, Play, Pause, Check, ChevronsUpDown, X } from 'lucide-react';
import { AgentDetail, pauseAgent, resumeAgent, updateAgent } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Progress } from '@/components/ui/progress';
import { useAppData, Model } from '@/hooks/useAppData';
import { cn } from '@/lib/utils';

interface AgentSettingsDialogProps {
  agent: AgentDetail;
  onUpdate?: () => void;
}

function getModelContextWindow(model: string, models: Model[]): number {
  // Look up the actual context length from the models data
  const modelData = models.find(m => m.id === model);
  if (modelData?.contextLength) {
    return modelData.contextLength;
  }
  
  // Fallback to default if model not found
  return 100000;
}

function calculateCost(tokensIn: number, tokensOut: number, promptPrice?: string, completionPrice?: string): string {
  const promptPricePerToken = promptPrice ? parseFloat(promptPrice) : 0;
  const completionPricePerToken = completionPrice ? parseFloat(completionPrice) : 0;
  
  const cost = (tokensIn * promptPricePerToken) + (tokensOut * completionPricePerToken);
  
  if (cost === 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export default function AgentSettingsDialog({ agent, onUpdate }: AgentSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [verifierPrompt, setVerifierPrompt] = useState(agent.verifier?.llm_judge_prompt || '');
  const [selectedModel, setSelectedModel] = useState(agent.model);
  const [reasoningEffort, setReasoningEffort] = useState<'off' | 'low' | 'medium' | 'high'>(agent.reasoning_effort || 'low');
  const [selectedTools, setSelectedTools] = useState<string[]>(agent.tools.map(t => t.id));
  const [modelOpen, setModelOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [toolSearch, setToolSearch] = useState('');
  const [modalPosition, setModalPosition] = useState<{ top: number; right: number }>({ top: 80, right: 16 });
  const { toast } = useToast();
  const { models, modelsLoading, tools, toolsLoading } = useAppData();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const modelTriggerRef = React.useRef<HTMLButtonElement>(null);
  const toolTriggerRef = React.useRef<HTMLButtonElement>(null);
  const [modelTriggerWidth, setModelTriggerWidth] = useState<number>(0);
  const [toolTriggerWidth, setToolTriggerWidth] = useState<number>(0);
  
  useEffect(() => {
    setVerifierPrompt(agent.verifier?.llm_judge_prompt || '');
    setSelectedModel(agent.model);
    setReasoningEffort(agent.reasoning_effort || 'low');
    setSelectedTools(agent.tools.map(t => t.id));
  }, [agent]);

  useEffect(() => {
    if (open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const gap = 8; // Gap between button and modal
      setModalPosition({
        top: rect.bottom + gap,
        right: window.innerWidth - rect.right,
      });
    }
  }, [open]);

  useEffect(() => {
    if (modelOpen && modelTriggerRef.current) {
      setModelTriggerWidth(modelTriggerRef.current.offsetWidth);
    }
  }, [modelOpen]);

  useEffect(() => {
    if (toolOpen && toolTriggerRef.current) {
      setToolTriggerWidth(toolTriggerRef.current.offsetWidth);
    }
  }, [toolOpen]);

  const handlePauseResume = async () => {
    console.log('Pause/Resume clicked, current status:', agent.status);
    setIsUpdating(true);
    try {
      if (agent.status === 'PAUSED') {
        console.log('Resuming agent:', agent.agent_id);
        await resumeAgent(agent.agent_id);
        toast({ title: 'Agent resuming', description: 'The agent will resume shortly' });
      } else {
        console.log('Pausing agent:', agent.agent_id);
        await pauseAgent(agent.agent_id);
        toast({ title: 'Agent pausing', description: 'The agent will pause shortly' });
      }
      console.log('Operation successful, calling onUpdate');
      onUpdate?.();
    } catch (error) {
      console.error('Pause/Resume error:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Operation failed',
        variant: 'destructive',
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleSaveChanges = async () => {
    setIsUpdating(true);
    try {
      const updates: any = {};
      if (verifierPrompt !== agent.verifier?.llm_judge_prompt) {
        updates.verifier_prompt = verifierPrompt;
      }
      if (selectedModel !== agent.model) {
        updates.model = selectedModel;
      }
      if (reasoningEffort !== agent.reasoning_effort) {
        updates.reasoning_effort = reasoningEffort;
      }
      const currentToolIds = agent.tools.map(t => t.id).sort();
      const newToolIds = [...selectedTools].sort();
      if (JSON.stringify(currentToolIds) !== JSON.stringify(newToolIds)) {
        updates.tool_ids = selectedTools;
      }
      
      if (Object.keys(updates).length > 0) {
        await updateAgent(agent.agent_id, updates);
        toast({ title: 'Settings updated', description: 'Changes saved successfully' });
        onUpdate?.();
        setOpen(false);
      } else {
        toast({ title: 'No changes', description: 'Nothing to update' });
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update',
        variant: 'destructive',
      });
    } finally {
      setIsUpdating(false);
    }
  };
  
  const hasChanges = () => {
    return (
      verifierPrompt !== agent.verifier?.llm_judge_prompt ||
      selectedModel !== agent.model ||
      reasoningEffort !== agent.reasoning_effort ||
      JSON.stringify([...selectedTools].sort()) !== JSON.stringify(agent.tools.map(t => t.id).sort())
    );
  };

  // Ensure arrays are always defined
  const modelsList = Array.isArray(models) ? models : [];
  
  const maxWindow = getModelContextWindow(agent.model, modelsList);
  const restartThreshold = Math.round(maxWindow * 0.8);
  const contextPercentage = Math.min(100, (agent.context_size / restartThreshold) * 100);
  const toolsList = Array.isArray(tools) ? tools : [];
  const selectedModelData = modelsList.find(m => m?.id === selectedModel);
  const selectedToolsData = toolsList.filter(t => t && selectedTools.includes(t.id));
  const availableToolsFiltered = toolsList.filter(t => t && !selectedTools.includes(t.id));
  
  // Calculate cost based on current model pricing
  const currentModelData = modelsList.find(m => m?.id === agent.model);
  const estimatedCost = calculateCost(
    agent.tokens_in,
    agent.tokens_out,
    currentModelData?.pricing?.prompt,
    currentModelData?.pricing?.completion
  );

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <DialogTrigger asChild>
        <Button ref={triggerRef} variant="outline" size="icon">
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent 
        className="p-0 border border-gray-300 dark:border-gray-700 shadow-lg [&>button]:hidden overflow-hidden"
        style={{ 
          position: 'fixed',
          top: `${modalPosition.top}px`,
          right: `${modalPosition.right}px`,
          left: 'auto',
          transform: 'none',
          width: '420px',
          maxWidth: '90vw',
          maxHeight: '85vh',
          backgroundColor: 'transparent',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <div className="bg-[#EEEFF2]/80 dark:bg-[#1a1a1a]/80 p-6 max-h-[85vh] overflow-y-auto">
          <DialogHeader className="mb-4">
            <DialogTitle>Agent Settings</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-6">
            {/* Pause/Resume Control */}
            <div className="space-y-2">
            <Button
              onClick={handlePauseResume}
              disabled={isUpdating || !['ACTIVE', 'PAUSED'].includes(agent.status)}
              className="w-full"
              variant={agent.status === 'PAUSED' ? 'default' : 'outline'}
            >
              {isUpdating ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : agent.status === 'PAUSED' ? (
                <Play className="h-4 w-4 mr-2" />
              ) : (
                <Pause className="h-4 w-4 mr-2" />
              )}
              {agent.status === 'PAUSED' ? 'Resume' : 'Pause'}
            </Button>
          </div>

          {/* Metrics */}
          <div className="space-y-3 pt-2 border-t">
            <Label>Metrics</Label>
            
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Messages</span>
                <span className="font-mono">{agent.message_count}</span>
              </div>
              
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Tokens In/Out</span>
                <span className="font-mono">{agent.tokens_in.toLocaleString()} / {agent.tokens_out.toLocaleString()}</span>
              </div>
              
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Cost</span>
                <span className="font-mono">{estimatedCost}</span>
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Context Usage</span>
                  <span className="font-mono">{contextPercentage.toFixed(1)}%</span>
                </div>
                <Progress value={contextPercentage} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  {agent.context_size.toLocaleString()} / {restartThreshold.toLocaleString()} context used
                </p>
              </div>

              {/* Debug Info (Development Only) */}
              {import.meta.env.DEV && (
                <div className="space-y-2 pt-3 border-t border-dashed">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Agent ID</span>
                    <span className="font-mono text-[10px]">{agent.agent_id}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Reasoning Effort Selection */}
          <div className="space-y-2 pt-2 border-t">
            <Label>Reasoning Effort</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between font-normal"
                >
                  <span className="capitalize">{reasoningEffort}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 z-[60] bg-[#EEEFF2]/80 dark:bg-[#1a1a1a]/80 backdrop-blur-[12px]" align="start" style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
                <Command className="bg-transparent w-full">
                  <CommandList className="max-h-64 overflow-x-hidden w-full">
                    <CommandGroup className="overflow-x-hidden w-full">
                      {(['off', 'low', 'medium', 'high'] as const).map((effort) => (
                        <CommandItem
                          key={effort}
                          value={effort}
                          onSelect={() => setReasoningEffort(effort)}
                          className="cursor-pointer overflow-hidden w-full"
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4 shrink-0",
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

          {/* Model Selection with Search */}
          <div className="space-y-2 pt-2 border-t">
            <Label>Model</Label>
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild>
                <Button
                  ref={modelTriggerRef}
                  variant="outline"
                  role="combobox"
                  aria-expanded={modelOpen}
                  className="w-full justify-between font-normal"
                >
                  <span className="truncate">
                    {selectedModelData ? `${selectedModelData.provider}/${selectedModelData.name}` : 'Select model...'}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 z-[60] bg-[#EEEFF2]/80 dark:bg-[#1a1a1a]/80 backdrop-blur-[12px]" align="start" style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', width: modelTriggerWidth > 0 ? `${modelTriggerWidth}px` : 'auto' }}>
                <Command className="bg-transparent w-full">
                  <CommandInput 
                    placeholder="Search models..." 
                    value={modelSearch}
                    onValueChange={setModelSearch}
                  />
                  <CommandList className="max-h-64 overflow-x-hidden w-full">
                    <CommandEmpty>No model found.</CommandEmpty>
                    <CommandGroup className="overflow-x-hidden w-full">
                      {modelsList.map((model) => {
                        const formatPrice = (price?: string) => {
                          if (!price) return null;
                          const num = parseFloat(price);
                          if (num === 0) return 'FREE';
                          if (num < 0.000001) return `$${(num * 1000000).toFixed(2)}/M`;
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
                            className="cursor-pointer overflow-hidden w-full"
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

          {/* Tools Selection with Chips */}
          <div className="space-y-2 pt-2 border-t">
            <Label>Tools</Label>
            
            {/* Selected Tools Chips */}
            {selectedToolsData.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedToolsData.map((tool) => (
                  <Badge
                    key={tool.id}
                    variant="secondary"
                    className="pl-2 pr-1 py-1 gap-1"
                  >
                    {tool.name}
                    <button
                      onClick={() => setSelectedTools(selectedTools.filter(id => id !== tool.id))}
                      className="ml-1 hover:bg-muted rounded-sm"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            
            {/* Tool Search/Add */}
            <Popover open={toolOpen} onOpenChange={setToolOpen}>
              <PopoverTrigger asChild>
                <Button
                  ref={toolTriggerRef}
                  variant="outline"
                  role="combobox"
                  aria-expanded={toolOpen}
                  className="w-full justify-between font-normal"
                >
                  <span className="text-muted-foreground">
                    {selectedToolsData.length === 0 ? 'Add tools...' : 'Add more tools...'}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0 z-[60] bg-[#EEEFF2]/80 dark:bg-[#1a1a1a]/80 backdrop-blur-[12px]" align="start" style={{ backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', width: toolTriggerWidth > 0 ? `${toolTriggerWidth}px` : 'auto' }}>
                <Command className="bg-transparent w-full">
                  <CommandInput 
                    placeholder="Search tools..." 
                    value={toolSearch}
                    onValueChange={setToolSearch}
                  />
                  <CommandList className="max-h-64 overflow-x-hidden w-full">
                    <CommandEmpty>No tool found.</CommandEmpty>
                    <CommandGroup className="overflow-x-hidden w-full">
                      {availableToolsFiltered.map((tool) => (
                        <CommandItem
                          key={tool.id}
                          value={`${tool.name} ${tool.description || ''}`}
                          onSelect={() => {
                            setSelectedTools([...selectedTools, tool.id]);
                            setToolSearch('');
                          }}
                          className="cursor-pointer flex-col items-start overflow-hidden w-full"
                        >
                          <div className="font-medium truncate w-full">{tool.name}</div>
                          {tool.description && (
                            <div className="text-xs text-muted-foreground whitespace-normal break-words w-full">
                              {tool.description}
                            </div>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {/* Verifier Prompt */}
          <div className="space-y-2 pt-2 border-t">
            <Label htmlFor="verifier-prompt">Verifier Prompt</Label>
            <Textarea
              id="verifier-prompt"
              value={verifierPrompt}
              onChange={(e) => setVerifierPrompt(e.target.value)}
              className="min-h-[100px] text-sm"
              placeholder="LLM judge prompt..."
            />
          </div>

          {/* Save Button */}
          <Button
            onClick={handleSaveChanges}
            disabled={isUpdating || !hasChanges()}
            className="w-full"
          >
            {isUpdating ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : null}
            Save Changes
          </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

