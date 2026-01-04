import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Settings, Loader2, Trash2, FileJson } from 'lucide-react';
import { AgentDetail, deleteAgent, ResponseSchemaField } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { useAppData, Model } from '@/hooks/useAppData';

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

function formatFieldType(type: ResponseSchemaField['type']): string {
  switch (type) {
    case 'str': return 'string';
    case 'int': return 'integer';
    case 'float': return 'number';
    case 'bool': return 'boolean';
    case 'list[str]': return 'string[]';
    case 'list[int]': return 'integer[]';
    default: return type;
  }
}

export default function AgentSettingsDialog({ agent, onUpdate, onDelete }: AgentSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [modalPosition, setModalPosition] = useState<{ bottom: number; right: number }>({ bottom: 80, right: 16 });
  const { toast } = useToast();
  const { models } = useAppData();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [showDeleteSection, setShowDeleteSection] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  
  useEffect(() => {
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
        bottom: window.innerHeight - rect.top + gap, // Position above the button
        right: window.innerWidth - rect.right,
      });
    }
  }, [open]);

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

  // Ensure arrays are always defined
  const modelsList = Array.isArray(models) ? models : [];
  
  const maxWindow = agent ? getModelContextWindow(agent.model, modelsList) : 100000;
  const restartThreshold = Math.round(maxWindow * 0.8);
  const contextPercentage = agent ? Math.min(100, (agent.context_size / restartThreshold) * 100) : 0;
  
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
          className="p-1.5 rounded-md hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent 
        className="p-0 border border-gray-300 dark:border-gray-700 shadow-lg [&>button]:hidden overflow-hidden"
        style={{ 
          position: 'fixed',
          bottom: `${modalPosition.bottom}px`,
          right: `${modalPosition.right}px`,
          top: 'auto',
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
          {/* Metrics */}
          <div className="space-y-3">
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

          {/* Output Schema Section */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <FileJson className="h-4 w-4 text-muted-foreground" />
              <Label>Output Schema</Label>
            </div>

            {agent.response_schema?.fields && agent.response_schema.fields.length > 0 ? (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                {agent.response_schema.fields.map((field, idx) => (
                  <div key={idx} className="text-sm">
                    <div className="flex items-center gap-2">
                      <code className="font-mono text-xs bg-background px-1.5 py-0.5 rounded">
                        {field.name}
                      </code>
                      <span className="text-muted-foreground text-xs">
                        {formatFieldType(field.type)}
                      </span>
                      {field.required && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-500 font-medium">
                          required
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 pl-1">
                      {field.description}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Schema generating...
              </p>
            )}
          </div>

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

