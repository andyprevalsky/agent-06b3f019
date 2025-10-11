import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Badge } from '@/components/ui/badge';
import { Settings, Loader2, Play, Pause, Check, ChevronsUpDown, X } from 'lucide-react';
import { AgentDetail, pauseAgent, resumeAgent, updateAgent, getTools, Tool } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Progress } from '@/components/ui/progress';
import { useModels } from '@/hooks/useModels';
import { cn } from '@/lib/utils';

interface AgentSettingsDialogProps {
  agent: AgentDetail;
  onUpdate?: () => void;
}

function getModelContextWindow(model: string): number {
  const contextWindows: Record<string, number> = {
    'anthropic/claude-sonnet-4.5': 200000,
    'anthropic/claude-4.5-haiku': 200000,
    'openai/gpt-4o': 128000,
    'openai/gpt-4o-mini': 128000,
    'openai/gpt-4-turbo': 128000,
  };
  return contextWindows[model] || 100000;
}

export default function AgentSettingsDialog({ agent, onUpdate }: AgentSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [verifierPrompt, setVerifierPrompt] = useState(agent.verifier?.llm_judge_prompt || '');
  const [selectedModel, setSelectedModel] = useState(agent.model);
  const [selectedTools, setSelectedTools] = useState<string[]>(agent.tools.map(t => t.id));
  const [availableTools, setAvailableTools] = useState<Tool[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [toolSearch, setToolSearch] = useState('');
  const { toast } = useToast();
  const { models = [] } = useModels();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  
  useEffect(() => {
    getTools().then(setAvailableTools).catch(console.error);
  }, []);
  
  useEffect(() => {
    setVerifierPrompt(agent.verifier?.llm_judge_prompt || '');
    setSelectedModel(agent.model);
    setSelectedTools(agent.tools.map(t => t.id));
  }, [agent]);

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
      JSON.stringify([...selectedTools].sort()) !== JSON.stringify(agent.tools.map(t => t.id).sort())
    );
  };

  const maxWindow = getModelContextWindow(agent.model);
  const restartThreshold = maxWindow * 0.8;
  const contextPercentage = Math.min(100, (agent.context_size / restartThreshold) * 100);

  const modelsList = models || [];
  const toolsList = availableTools || [];
  const selectedModelData = modelsList.find(m => m.id === selectedModel);
  const selectedToolsData = toolsList.filter(t => selectedTools.includes(t.id));
  const availableToolsFiltered = toolsList.filter(t => !selectedTools.includes(t.id));

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
          top: '5rem',
          right: '1rem',
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
                <span className="text-muted-foreground">Tokens Used</span>
                <span className="font-mono">{agent.token_count.toLocaleString()}</span>
              </div>
              
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Context Usage</span>
                  <span className="font-mono">{contextPercentage.toFixed(1)}%</span>
                </div>
                <Progress value={contextPercentage} className="h-2" />
                <p className="text-xs text-muted-foreground">
                  {agent.context_size.toLocaleString()} / {restartThreshold.toLocaleString()} tokens
                  (restarts at 100%)
                </p>
              </div>
            </div>
          </div>

          {/* Model Selection with Search */}
          <div className="space-y-2 pt-2 border-t">
            <Label>Model</Label>
            <Popover open={modelOpen} onOpenChange={setModelOpen}>
              <PopoverTrigger asChild>
                <Button
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
              <PopoverContent className="w-[400px] p-0 z-[60]" align="start">
                <Command>
                  <CommandInput 
                    placeholder="Search models..." 
                    value={modelSearch}
                    onValueChange={setModelSearch}
                  />
                  <CommandEmpty>No model found.</CommandEmpty>
                  <CommandGroup className="max-h-64 overflow-auto">
                    {modelsList.map((model) => (
                      <CommandItem
                        key={model.id}
                        value={`${model.provider}/${model.name}`}
                        onSelect={() => {
                          setSelectedModel(model.id);
                          setModelOpen(false);
                          setModelSearch('');
                        }}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            selectedModel === model.id ? "opacity-100" : "opacity-0"
                          )}
                        />
                        <span className="truncate">{model.provider}/{model.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
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
              <PopoverContent className="w-[400px] p-0 z-[60]" align="start">
                <Command>
                  <CommandInput 
                    placeholder="Search tools..." 
                    value={toolSearch}
                    onValueChange={setToolSearch}
                  />
                  <CommandEmpty>No tool found.</CommandEmpty>
                  <CommandGroup className="max-h-64 overflow-auto">
                    {availableToolsFiltered.map((tool) => (
                      <CommandItem
                        key={tool.id}
                        value={tool.name}
                        onSelect={() => {
                          setSelectedTools([...selectedTools, tool.id]);
                          setToolSearch('');
                        }}
                      >
                        <span className="truncate">{tool.name}</span>
                        {tool.description && (
                          <span className="ml-2 text-xs text-muted-foreground truncate">
                            {tool.description}
                          </span>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
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

