/**
 * STATE MACHINE: AgentSettingsDialog
 *
 * [CLOSED] <-- Dialog closed
 *     |
 *     v (open trigger)
 * [OPEN]
 *     |
 *     +--> [IDLE] <-- isDeleting: false
 *     |       |
 *     |       +--> (delete click)
 *     |       |       |
 *     |       |       v
 *     |       |   [CONFIRM_DELETE] <-- showDeleteSection: true, confirmEnabled: false
 *     |       |       |
 *     |       |       | (1.8s delay)
 *     |       |       v
 *     |       |   [CONFIRM_ENABLED] <-- confirmEnabled: true
 *     |       |       |
 *     |       |       +--> (confirm) --> [DELETING] <-- isDeleting: true
 *     |       |       +--> (cancel) --> [IDLE]
 *
 * States:
 * - isDeleting: boolean
 * - showDeleteSection: boolean
 * - confirmEnabled: boolean (enabled after 1.8s delay)
 */

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Settings, Loader2, Trash2, FileJson, DollarSign } from 'lucide-react';
import { type AgentDetail, deleteAgent, updateAgent, type ResponseSchemaField } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Progress } from '@/components/ui/progress';
import { useAppData, type Model } from '@/hooks/useAppData';

interface AgentSettingsDialogProps {
  agent: AgentDetail | null;
  onUpdate?: () => void;
  onDelete?: () => void;
}

function getModelContextWindow(model: string, models: Model[]): number {
  // Look up the actual context length from the models data
  const modelData = models.find((m) => m.id === model);
  if (modelData?.contextLength) {
    return modelData.contextLength;
  }

  // Fallback to default if model not found
  return 100000;
}

function formatCentsAsDollars(cents: number): string {
  const dollars = cents / 100;
  if (dollars === 0) return '$0.00';
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
}

function formatFieldType(type: ResponseSchemaField['type']): string {
  switch (type) {
    case 'str':
      return 'string';
    case 'int':
      return 'integer';
    case 'float':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'list[str]':
      return 'string[]';
    case 'list[int]':
      return 'integer[]';
    case 'file_pointer':
      return 'file';
    case 'list[file_pointer]':
      return 'file[]';
    default:
      return type;
  }
}

export default function AgentSettingsDialog({
  agent,
  onUpdate,
  onDelete,
}: AgentSettingsDialogProps) {
  const [open, setOpen] = useState(false);
  const [modalPosition, setModalPosition] = useState<{ bottom: number; right: number }>({
    bottom: 80,
    right: 16,
  });
  const { toast } = useToast();
  const { models } = useAppData();
  const { user: authUser } = useAuth();
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [showDeleteSection, setShowDeleteSection] = useState(false);
  const [confirmEnabled, setConfirmEnabled] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Price limit editing state (only for root agents)
  const [priceLimitInput, setPriceLimitInput] = useState('');
  const [isEditingPriceLimit, setIsEditingPriceLimit] = useState(false);
  const [isSavingPriceLimit, setIsSavingPriceLimit] = useState(false);

  useEffect(() => {
    // Reset delete states when agent changes
    setShowDeleteSection(false);
    setConfirmEnabled(false);
    // Reset price limit editing
    setIsEditingPriceLimit(false);
    if (agent?.price_limit_cents !== undefined) {
      setPriceLimitInput((agent.price_limit_cents / 100).toFixed(2));
    }
  }, [agent]);

  // Reset delete states when dialog closes
  useEffect(() => {
    if (!open) {
      setShowDeleteSection(false);
      setConfirmEnabled(false);
    }
  }, [open]);

  // Start 1.8s timer when delete section is shown
  useEffect(() => {
    if (showDeleteSection) {
      setConfirmEnabled(false);
      const timer = setTimeout(() => {
        setConfirmEnabled(true);
      }, 1800);
      return () => clearTimeout(timer);
    }
  }, [showDeleteSection]);

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
    if (!agent || !confirmEnabled) return;
    setIsDeleting(true);
    try {
      await deleteAgent(agent.agent_id);
      toast({
        title: 'Agent deleted',
        description: 'The agent and its workflow have been terminated',
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

  const handleSavePriceLimit = async () => {
    if (!agent) return;
    const newLimitCents = Math.round(parseFloat(priceLimitInput) * 100);
    if (isNaN(newLimitCents) || newLimitCents < 1) {
      toast({
        title: 'Invalid amount',
        description: 'Please enter a valid dollar amount (minimum $0.01)',
        variant: 'destructive',
      });
      return;
    }
    if (newLimitCents < (agent.tree_cost_cents || 0)) {
      toast({
        title: 'Limit too low',
        description: `New limit must be at least $${((agent.tree_cost_cents || 0) / 100).toFixed(2)} (current cost)`,
        variant: 'destructive',
      });
      return;
    }
    setIsSavingPriceLimit(true);
    try {
      await updateAgent(agent.agent_id, { price_limit_cents: newLimitCents });
      toast({
        title: 'Price limit updated',
        description: `New limit: $${(newLimitCents / 100).toFixed(2)}`,
      });
      setIsEditingPriceLimit(false);
      onUpdate?.();
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to update price limit',
        variant: 'destructive',
      });
    } finally {
      setIsSavingPriceLimit(false);
    }
  };

  // Ensure arrays are always defined
  const modelsList = Array.isArray(models) ? models : [];

  const maxWindow = agent ? getModelContextWindow(agent.model, modelsList) : 100000;
  const restartThreshold = Math.round(maxWindow * 0.8);
  const contextPercentage = agent
    ? Math.min(100, (agent.context_size / restartThreshold) * 100)
    : 0;

  // Format tree cost for display
  const treeCostDisplay = agent ? formatCentsAsDollars(agent.tree_cost_cents || 0) : '$0.00';

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
        <div
          className="p-6 max-h-[85vh] overflow-y-auto"
          style={{ backgroundColor: 'transparent' }}
        >
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
                    <span className="font-mono">
                      {totalTokensIn.toLocaleString()} / {totalTokensOut.toLocaleString()}
                    </span>
                  </div>

                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Cost</span>
                    <span className="font-mono">{treeCostDisplay}</span>
                  </div>

                  {/* Price Limit (only for root agents) */}
                  {!agent.parent_agent_id && (
                    <div className="space-y-1 pt-2 border-t border-dashed">
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Price Limit</span>
                        {!isEditingPriceLimit ? (
                          <button
                            onClick={() => setIsEditingPriceLimit(true)}
                            className="font-mono hover:underline text-primary"
                          >
                            ${((agent.price_limit_cents || 100) / 100).toFixed(2)}
                          </button>
                        ) : (
                          <div className="flex items-center gap-1">
                            <DollarSign className="h-3 w-3 text-muted-foreground" />
                            <Input
                              value={priceLimitInput}
                              onChange={(e) => setPriceLimitInput(e.target.value)}
                              className="w-20 h-6 text-xs font-mono px-1"
                              placeholder="1.00"
                              disabled={isSavingPriceLimit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSavePriceLimit();
                                if (e.key === 'Escape') {
                                  setIsEditingPriceLimit(false);
                                  setPriceLimitInput(
                                    ((agent.price_limit_cents || 100) / 100).toFixed(2),
                                  );
                                }
                              }}
                              autoFocus
                            />
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-xs"
                              onClick={handleSavePriceLimit}
                              disabled={isSavingPriceLimit}
                            >
                              {isSavingPriceLimit ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                'Save'
                              )}
                            </Button>
                          </div>
                        )}
                      </div>
                      {agent.tree_cost_cents !== undefined && agent.tree_cost_cents > 0 && (
                        <div className="flex justify-between text-xs">
                          <span className="text-muted-foreground">Tree Cost</span>
                          <span className="font-mono text-muted-foreground">
                            ${(agent.tree_cost_cents / 100).toFixed(2)}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Context Usage</span>
                      <span className="font-mono">{contextPercentage.toFixed(1)}%</span>
                    </div>
                    <Progress value={contextPercentage} className="h-2" />
                    <p className="text-xs text-muted-foreground">
                      {(agent.context_size || 0).toLocaleString()} /{' '}
                      {restartThreshold.toLocaleString()} context used
                    </p>
                  </div>

                  {/* Debug Info (Development + Admin) */}
                  {(import.meta.env.DEV ||
                    authUser?.id === '1f85ff25-6e29-4c1b-8739-f917bd101a30') && (
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
                  <p className="text-sm text-muted-foreground italic">Schema generating...</p>
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
                    <p className="text-sm text-red-600 dark:text-red-500 font-semibold text-center py-2">
                      Are you sure?
                    </p>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => {
                          setShowDeleteSection(false);
                          setConfirmEnabled(false);
                        }}
                        variant="outline"
                        className="flex-1"
                        disabled={isDeleting}
                      >
                        Cancel
                      </Button>
                      <Button
                        onClick={handleDeleteAgent}
                        disabled={isDeleting || !confirmEnabled}
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
                            {confirmEnabled ? 'Delete' : 'Wait...'}
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
