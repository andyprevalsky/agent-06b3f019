import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Bot, Loader2, Play, Pause, Check, ChevronsUpDown, X, Trash2 } from 'lucide-react';
import { AgentDetail, pauseAgent, resumeAgent, updateAgent, deleteAgent } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { useAppData, Model } from '@/hooks/useAppData';
import { cn } from '@/lib/utils';

interface AgentSettingsDialogProps {
  agent: AgentDetail | null;
  onUpdate?: () => void;
  onDelete?: () => void;
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

function calculateCost(tokensIn: number, tokensOut: number, toolCostCents: number, promptPrice?: string, completionPrice?: string): string {
  const promptPricePerToken = promptPrice ? parseFloat(promptPrice) : 0;
  const completionPricePerToken = completionPrice ? parseFloat(completionPrice) : 0;
  
  const llmCost = (tokensIn * promptPricePerToken) + (tokensOut * completionPricePerToken);
  const toolCost = toolCostCents / 100; // Convert cents to dollars
  const totalCost = llmCost + toolCost;
  
  if (totalCost === 0) return '$0.00';
  if (totalCost < 0.01) return `$${totalCost.toFixed(4)}`;
  return `$${totalCost.toFixed(2)}`;
}

export default function AgentSettingsDialog({ agent, onUpdate, onDelete }: AgentSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [verifierPrompt, setVerifierPrompt] = useState(agent?.verifier?.llm_judge_prompt || '');
  const [selectedModel, setSelectedModel] = useState(agent?.model || '');
  const [reasoningEffort, setReasoningEffort] = useState<'off' | 'low' | 'medium' | 'high'>(agent?.reasoning_effort || 'low');
  const [selectedTools, setSelectedTools] = useState<string[]>(agent?.tools.map(t => t.id) || []);
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
  const [showDeleteSection, setShowDeleteSection] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  
  useEffect(() => {
    if (agent) {
      setVerifierPrompt(agent.verifier?.llm_judge_prompt || '');
      setSelectedModel(agent.model);
      setReasoningEffort(agent.reasoning_effort || 'low');
      setSelectedTools(agent.tools.map(t => t.id));
    }
    // Reset delete states when agent changes
    setShowDeleteSection(false);
    setDeleteConfirmText('');
  }, [agent]);

  // Reset delete states when dialog closes
  useEffect(() => {
    if (!open) {
      setShowDeleteSection(false);
      setDeleteConfirmText('');
    }
  }, [open]);

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
      if (agent.status === 'PAUSED' || agent.status === 'OUT_OF_CREDITS') {
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
    if (!agent) return;
    setIsUpdating(true);
    try {
      const updates: any = {};
      if (verifierPrompt !== agent.verifier?.llm_judge_prompt) {
        updates.verifier_prompt = verifierPrompt;
      }
      // Model changing disabled
      // if (selectedModel !== agent.model) {
      //   updates.model = selectedModel;
      // }
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

  const handleDeleteAgent = async () => {
    if (!agent || deleteConfirmText !== 'I END MY GOAL') return;
    setIsDeleting(true);
    try {
      await deleteAgent(agent.agent_id);
      toast({ 
        title: 'Agent deleted', 
        description: 'The agent and its workflow have been terminated' 
      });
      setOpen(false);
      // Call onDelete to navigate back to main view
      onDelete?.();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete agent',
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };
  
  const hasChanges = () => {
    if (!agent) return false;
    return (
      verifierPrompt !== agent.verifier?.llm_judge_prompt ||
      // selectedModel !== agent.model || // Model changing disabled
      reasoningEffort !== agent.reasoning_effort ||
      JSON.stringify([...selectedTools].sort()) !== JSON.stringify(agent.tools.map(t => t.id).sort())
    );
  };

  // Ensure arrays are always defined
  const modelsList = Array.isArray(models) ? models : [];
  
  const maxWindow = agent ? getModelContextWindow(agent.model, modelsList) : 100000;
  const restartThreshold = Math.round(maxWindow * 0.8);
  const contextPercentage = agent ? Math.min(100, (agent.context_size / restartThreshold) * 100) : 0;
  const toolsList = Array.isArray(tools) ? tools : [];
  const selectedModelData = modelsList.find(m => m?.id === selectedModel);
  const selectedToolsData = toolsList.filter(t => t && selectedTools.includes(t.id));
  const availableToolsFiltered = toolsList.filter(t => t && !selectedTools.includes(t.id));
  
  // Calculate cost based on current model pricing + tool costs
  const currentModelData = agent ? modelsList.find(m => m?.id === agent.model) : null;
  const estimatedCost = agent ? calculateCost(
    agent.tokens_in,
    agent.tokens_out,
    agent.tool_cost_cents || 0,
    currentModelData?.pricing?.prompt,
    currentModelData?.pricing?.completion
  ) : '$0.00';
  
  // Calculate combined tokens (primary LLM + tools)
  const totalTokensIn = agent ? (agent.tokens_in || 0) + (agent.tool_tokens_in || 0) : 0;
  const totalTokensOut = agent ? (agent.tokens_out || 0) + (agent.tool_tokens_out || 0) : 0;

  return (
    <Dialog open={open} onOpenChange={setOpen} modal={false}>
      <DialogTrigger asChild>
        <button 
          ref={triggerRef} 
          className="w-[38px] h-[38px] flex items-center justify-center rounded-lg border border-border/50 dark:border-navi-light-black/50 shadow-sm hover:bg-white/10 transition-colors"
          style={{
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          <Bot className="h-4 w-4" />
        </button>
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
        <div className="p-6 max-h-[85vh] overflow-y-auto" style={{ backgroundColor: 'transparent' }}>
          <DialogHeader className="mb-4">
            <DialogTitle>Agent Settings</DialogTitle>
          </DialogHeader>
          
          {!agent ? (
            <div className="py-8 text-center">
              <p className="text-muted-foreground">create an agent to view agent settings</p>
            </div>
          ) : (
          <div className="space-y-6">
            {/* Pause/Resume Control */}
            <div className="space-y-2">
            <Button
              onClick={handlePauseResume}
              disabled={isUpdating || !['ACTIVE', 'PAUSED', 'OUT_OF_CREDITS'].includes(agent.status)}
              className="w-full"
              variant={['PAUSED', 'OUT_OF_CREDITS'].includes(agent.status) ? 'default' : 'outline'}
            >
              {isUpdating ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : ['PAUSED', 'OUT_OF_CREDITS'].includes(agent.status) ? (
                <Play className="h-4 w-4 mr-2" />
              ) : (
                <Pause className="h-4 w-4 mr-2" />
              )}
              {['PAUSED', 'OUT_OF_CREDITS'].includes(agent.status) ? 'Resume' : 'Pause'}
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
                <span className="font-mono">{totalTokensIn.toLocaleString()} / {totalTokensOut.toLocaleString()}</span>
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
                  {(agent.context_size || 0).toLocaleString()} / {restartThreshold.toLocaleString()} context used
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

          {/* Model Selection - Disabled as per requirements */}
          {/* <div className="space-y-2 pt-2 border-t">
            <Label>Model</Label>
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild>
                <Button
                  ref={modelTriggerRef}
                  variant="outline"
                  role="combobox"
                  aria-expanded={modelOpen}
                  className="w-full justify-between font-normal"
                  disabled
                >
                  <span className="truncate">
                    {selectedModelData ? `${selectedModelData.provider}/${selectedModelData.name}` : 'Select model...'}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
            </Popover>
          </div> */}

          {/* Tools Selection with Chips */}
          <div className="space-y-2 pt-2 border-t">
            <Label>Tools</Label>
            
            {/* Selected Tools Chips */}
            <div 
              className="relative overflow-hidden rounded-md transition-opacity duration-300"
              style={{
                opacity: selectedToolsData.length > 0 ? 1 : 0,
                height: selectedToolsData.length > 0 ? 'auto' : 0,
              }}
            >
              <div 
                className="flex gap-2 overflow-x-auto scrollbar-hide py-2 px-3 bg-white dark:bg-white/10"
                style={{
                  scrollbarWidth: 'none',
                  msOverflowStyle: 'none',
                }}
              >
                {selectedToolsData.map((tool) => (
                  <Badge
                    key={tool.id}
                    variant="secondary"
                    className="pl-2 pr-1 py-1 gap-1 shrink-0"
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
              {/* Left fade */}
              <div 
                className="absolute left-0 top-0 bottom-0 w-8 pointer-events-none bg-gradient-to-r from-white to-transparent dark:from-white/10 dark:to-transparent"
                style={{
                  opacity: selectedToolsData.length > 0 ? 1 : 0,
                  transition: 'opacity 300ms',
                }}
              />
              {/* Right fade */}
              <div 
                className="absolute right-0 top-0 bottom-0 w-8 pointer-events-none bg-gradient-to-l from-white to-transparent dark:from-white/10 dark:to-transparent"
                style={{
                  opacity: selectedToolsData.length > 0 ? 1 : 0,
                  transition: 'opacity 300ms',
                }}
              />
            </div>
            
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

          {/* Delete Agent Section */}
          <div className="space-y-3 pt-4 border-t border-red-500/30">
            {!showDeleteSection ? (
              <Button
                onClick={() => setShowDeleteSection(true)}
                variant="outline"
                className="w-full text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-500/30 hover:border-red-500/50 transition-colors"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Agent
              </Button>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="delete-confirm" className="text-sm text-red-600 dark:text-red-500 font-semibold">
                    Type: I END MY GOAL
                  </Label>
                  <Input
                    id="delete-confirm"
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder="I END MY GOAL"
                    className="text-sm border-red-500/30 focus-visible:ring-red-500"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      setShowDeleteSection(false);
                      setDeleteConfirmText('');
                    }}
                    variant="outline"
                    className="flex-1"
                    disabled={isDeleting}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleDeleteAgent}
                    disabled={isDeleting || deleteConfirmText !== 'I END MY GOAL'}
                    className="flex-1 bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isDeleting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Deleting...
                      </>
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4 mr-2" />
                        Delete
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>
          </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

