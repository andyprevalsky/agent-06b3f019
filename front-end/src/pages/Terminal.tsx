import { useState, useEffect, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Plus, LogOut, Settings as SettingsIcon, BarChart3, Menu, X, Bot, Gift, Copy, Check } from 'lucide-react';
import { supabase, signOut, getCurrentUser, initializeRealtime } from '@/lib/supabase';
import { subscribeToAgent, unsubscribe } from '@/lib/realtime';
import {
  getAllAgents,
  getAgent,
  createAgent as createAgentAPI,
  postMessage as postMessageAPI,
  resumeAgent,
  checkAndRespondToAttentionRequest,
  getMyInviteCode,
  InviteCodeInfo,
  Agent,
  AgentDetail,
  Message,
  CreateAgentPayload,
} from '@/lib/api';
import CreateAgentModal from '@/components/terminal/CreateAgentModal';
import AgentListItem from '@/components/terminal/AgentListItem';
import MessageBubble from '@/components/terminal/MessageBubble';
import BrowserViewPanel from '@/components/terminal/BrowserViewPanel';
import AsciiLoader from '@/components/terminal/AsciiLoader';
import QueryInput from '@/components/terminal/QueryInput';
import AgentSettingsDialog from '@/components/terminal/AgentSettingsDialog';
import AttentionInbox from '@/components/terminal/AttentionInbox';
import Settings from '@/pages/Settings';
import UsageDisplay from '@/components/UsageDisplay';
import PhoneAuthModal from '@/components/auth/PhoneAuthModal';
import { useToast } from '@/hooks/use-toast';
import { useAppData, Model } from '@/hooks/useAppData';
import { cn } from '@/lib/utils';
import { RealtimeChannel } from '@supabase/supabase-js';
import { colorPalette, frameSequence, getTileColorsForFrame } from '@/lib/tileAnimation';
import SmallTileAnimationCanvas from '@/components/terminal/SmallTileAnimationCanvas';

function getModelContextWindow(model: string, models: Model[]): number {
  // Look up the actual context length from the models data
  const modelData = models.find(m => m.id === model);
  if (modelData?.contextLength) {
    return modelData.contextLength;
  }
  
  // Fallback to default if model not found
  return 100000;
}

function getContextPercentage(agent: AgentDetail, models: Model[]): number {
  const maxWindow = getModelContextWindow(agent.model, models);
  const restartThreshold = Math.round(maxWindow * 0.8);
  return Math.min(100, (agent.context_size / restartThreshold) * 100);
}

function deduplicateToolMessages(messages: Message[]): Message[] {
  // Sort messages by timestamp FIRST to ensure correct deduplication order
  const sortedMessages = [...messages].sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Track the latest message AND first timestamp for each tool_call_id
  const toolMessageMap = new Map<string, { message: Message; firstTimestamp: string }>();
  const nonToolMessages: Message[] = [];

  sortedMessages.forEach((message) => {
    if (message.role === 'TOOL') {
      // All tool messages must have metadata with toolCallId
      const toolCallId = message.metadata?.toolCallId;
      
      if (!toolCallId) {
        console.error('Tool message missing toolCallId in metadata:', message);
        nonToolMessages.push(message);
        return;
      }
      
      const existing = toolMessageMap.get(toolCallId);
      
      if (existing) {
        // Update with latest message but keep the first timestamp
        toolMessageMap.set(toolCallId, {
          message: message,
          firstTimestamp: existing.firstTimestamp
        });
      } else {
        // First occurrence - store both message and timestamp
        toolMessageMap.set(toolCallId, {
          message: message,
          firstTimestamp: message.timestamp
        });
      }
    } else {
      nonToolMessages.push(message);
    }
  });

  // Combine non-tool messages with deduplicated tool messages
  // Use the latest message but with the original (first) timestamp
  const deduplicatedToolMessages = Array.from(toolMessageMap.values()).map(({ message, firstTimestamp }) => ({
    ...message,
    timestamp: firstTimestamp
  }));

  const deduplicatedMessages = [...nonToolMessages, ...deduplicatedToolMessages];
  deduplicatedMessages.sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return deduplicatedMessages;
}

// Group browser messages into panels with their sub-actions
function groupBrowserMessages(messages: Message[]): { messages: Message[]; browserPanels: Map<string, { initMessage: Message; actions: Message[]; currentBrowserUrl: string }> } {
  const browserPanels = new Map<string, { initMessage: Message; actions: Message[]; currentBrowserUrl: string }>();
  const nonBrowserMessages: Message[] = [];
  
  // Debug: Count browser messages (have task_id)
  const browserMessages = messages.filter(m => m.metadata?.task_id);
  const nonScreenshotBrowser = browserMessages.filter(m => !m.metadata?.title?.includes('Screenshot'));
  if (nonScreenshotBrowser.length > 0) {
    console.log('🟢 [Group] Grouping browser messages:', {
      totalMessages: messages.length,
      browserMessages: browserMessages.length,
      nonScreenshot: nonScreenshotBrowser.length,
      titles: nonScreenshotBrowser.map(m => m.metadata?.title),
      messageIds: nonScreenshotBrowser.map(m => m.message_id.slice(0, 12)),
      uniqueTaskIds: [...new Set(browserMessages.map(m => m.metadata?.task_id))].length
    });
  }

  messages.forEach((message) => {
    const taskId = message.metadata?.task_id;
    const browserUrl = message.metadata?.browser_url || '';

    // Only treat as browser message if task_id is present
    if (taskId) {
      // This is a browser-related message (has task_id metadata)
      const existing = browserPanels.get(taskId);
      
      if (existing) {
        // Already have a panel for this task - add as action (create new array to trigger React re-render)
        const newActions = [...existing.actions, message];
        // Update currentBrowserUrl if this message has a new one (for resume)
        const latestBrowserUrl = browserUrl || existing.currentBrowserUrl;
        browserPanels.set(taskId, {
          initMessage: existing.initMessage,
          actions: newActions,
          currentBrowserUrl: latestBrowserUrl
        });
        console.log('🔵 [Group] Added action to existing panel:', {
          taskId: taskId.slice(0, 20),
          title: message.metadata?.title,
          messageId: message.message_id.slice(0, 12),
          totalActions: newActions.length,
          actionTitles: newActions.map(a => a.metadata?.title)
        });
      } else {
        // First message with this task_id - create panel
        browserPanels.set(taskId, {
          initMessage: message,
          actions: [],
          currentBrowserUrl: browserUrl
        });
        console.log('🟢 [Group] Created new panel:', {
          taskId: taskId.slice(0, 20),
          title: message.metadata?.title,
          messageId: message.message_id.slice(0, 12)
        });
      }
    } else {
      // Regular message (not browser-related)
      nonBrowserMessages.push(message);
    }
  });

  // Combine browser panels into the message stream
  // Insert each panel at the position of its init message
  const combinedMessages: Message[] = [];
  const processedTaskIds = new Set<string>();

  messages.forEach((message) => {
    const taskId = message.metadata?.task_id;

    // If this is the first browser message with this task_id
    if (taskId && !processedTaskIds.has(taskId)) {
      processedTaskIds.add(taskId);
      // Add a special marker message for the browser panel
      combinedMessages.push({
        ...message,
        metadata: {
          ...message.metadata,
          _browserPanel: true, // Special flag to render BrowserViewPanel
          _taskId: taskId
        }
      });
    } else if (!taskId) {
      // Regular non-browser message
      combinedMessages.push(message);
    }
    // Skip subsequent browser action messages (they're rendered inside the panel)
  });

  return { messages: combinedMessages, browserPanels };
}

// Component for displaying invite code content inside popover
function InviteCodeContent() {
  const { toast } = useToast();
  const [inviteInfo, setInviteInfo] = useState<InviteCodeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadInviteCode();
  }, []);

  const loadInviteCode = async () => {
    try {
      setLoading(true);
      const info = await getMyInviteCode();
      setInviteInfo(info);
    } catch (error: any) {
      console.error('Error loading invite code:', error);
      toast({
        title: "Error",
        description: error.message || "Failed to load invite code",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!inviteInfo) return;

    try {
      await navigator.clipboard.writeText(inviteInfo.inviteCode.toString());
      setCopied(true);
      toast({
        title: "Copied!",
        description: "Invite code copied to clipboard",
      });
      
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to copy to clipboard",
        variant: "destructive",
      });
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-4">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-400"></div>
      </div>
    );
  }

  if (!inviteInfo) {
    return (
      <div className="text-center text-navi-black/70 text-sm">
        Failed to load invite code
      </div>
    );
  }

  return (
    <>
      <div className="relative">
        <div 
          className="w-full px-4 py-3 bg-[#EEEFF2] border border-gray-300 rounded-lg text-navi-black text-center text-2xl font-mono tracking-widest cursor-pointer hover:bg-[#e8e9ec] transition-colors"
          onClick={handleCopy}
        >
          {inviteInfo.inviteCode.toString().padStart(6, '0')}
        </div>
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-gray-300/50 transition-colors"
          aria-label="Copy invite code"
        >
          {copied ? (
            <Check className="w-4 h-4 text-green-600" />
          ) : (
            <Copy className="w-4 h-4 text-gray-500" />
          )}
        </button>
      </div>

      <div className="text-center">
        <p className="text-lg font-semibold text-navi-black">
          {inviteInfo.usesRemaining} Use{inviteInfo.usesRemaining !== 1 ? 's' : ''} Left
        </p>
      </div>
    </>
  );
}

// Opening messages for reveal animation [message, pauseDurationMs]
const OPENING_MESSAGES: [string, number][] = [
  ["Hello!", 1800],
  ["We're Rose.", 1800],
  ["A massive network of over 10,000 AIs.", 3800],
  ["We work together to form a super intelligent system.", 2500],
  ["Our purpose is to make your dreams come true.", 2500],
  ["What is the first goal you have?", 0] // Last message stays visible
];

export default function Terminal() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [user, setUser] = useState<any>(null);

  // View state - which pane to show
  const [currentView, setCurrentView] = useState<'agents' | 'settings'>('agents');
  
  // Sidebar state
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Browser fullscreen state - shared across all browser panels
  const [anyBrowserFullscreen, setAnyBrowserFullscreen] = useState(false);

  // Agent list state
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isFirstLoad, setIsFirstLoad] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [inviteCodeModalOpen, setInviteCodeModalOpen] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [resumingAgentId, setResumingAgentId] = useState<string | null>(null);
  const [inviteModalPosition, setInviteModalPosition] = useState({ top: 0, right: 0 });
  
  // Selected agent state
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<AgentDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingAgent, setIsLoadingAgent] = useState(false);
  
  // Message input state
  const [messageInput, setMessageInput] = useState(
    import.meta.env.DEV 
      ? `Go to render.com and start a new instance`
      : ''
  );
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [selectedModel, setSelectedModel] = useState('google/gemini-2.5-flash');
  
  // Models and tools from cached context
  const { models, modelsLoading } = useAppData();
  
  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const isReconnectingRef = useRef<boolean>(false);
  const loginButtonRef = useRef<HTMLButtonElement>(null);
  const queryInputRef = useRef<HTMLDivElement>(null);
  const giftButtonRef = useRef<HTMLButtonElement>(null);
  
  // Message buffer queue - messages wait here before being displayed
  const [messageBuffer, setMessageBuffer] = useState<Message[]>([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const [currentAnimatingId, setCurrentAnimatingId] = useState<string | null>(null);
  const isInitialLoadRef = useRef<boolean>(false);
  const [forceResubscribe, setForceResubscribe] = useState<number>(0);

  // Opening messages reveal animation
  const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
  const [animationPhase, setAnimationPhase] = useState<'revealing' | 'paused' | 'fading'>('revealing');
  const [revealProgress, setRevealProgress] = useState(0);
  const [isTypingComplete, setIsTypingComplete] = useState(false);
  
  // Dot animation for "Loading AI Network"
  const [loadingDots, setLoadingDots] = useState('.');
  const [isLoadingNetwork, setIsLoadingNetwork] = useState(false);
  
  // Popular goals carousel
  const popularGoals = [
    "Cure cancer",
    "Make me a master painter",
    "Get me socks",
    "Make sure my birthday is amazing",
    "Get me 5 new friends",
    "End world hunger",
    "Make sure I accomplish my body goals",
    "Get me into Stanford",
    "Optimize my nutrition",
    "Raise me 1 million dollars",
    "Find me my first 10 customers",
    "Make sure my startup succeeds",
    "Make me happy",
    "Get me a boyfriend",
    "Get me a girlfriend",
    "Make sure my parents are taken care of",
    "Make sure I am a good friend",
    "Maximize my luck surface area",
  ];
  const [tickerOffset, setTickerOffset] = useState(0);
  const tickerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(Date.now());

  // Tile animation state
  const [currentFrame, setCurrentFrame] = useState(0);
  const [animationComplete, setAnimationComplete] = useState(false);
  const [animationResetKey, setAnimationResetKey] = useState(0); // Key to force reset SmallTileAnimationCanvas
  const FRAME_DURATION_MS = 45; // ~45ms per frame = 1 second total for 22 frames
  const tileAnimationRef = useRef<NodeJS.Timeout | null>(null);

  // Reveal animation for opening messages on page load
  useEffect(() => {
    // Only run on initial page load when no agents selected and not loading network
    if (selectedAgentId || isLoadingNetwork || isTypingComplete) return;
    
    // If all messages shown, mark as complete
    if (currentMessageIndex >= OPENING_MESSAGES.length) {
      setIsTypingComplete(true);
      return;
    }
    
    const [currentMessage, pauseDuration] = OPENING_MESSAGES[currentMessageIndex];
    
    // Handle revealing phase - animate from 0 to 100
    if (animationPhase === 'revealing') {
      if (revealProgress < 100) {
        const timer = setTimeout(() => {
          setRevealProgress(prev => Math.min(100, prev + 2)); // Increment by 2% each frame
        }, 20); // 50fps animation
        return () => clearTimeout(timer);
      } else {
        // Done revealing, pause before fading
        // If this is the last message, keep it displayed and mark as complete
        if (currentMessageIndex === OPENING_MESSAGES.length - 1) {
          setIsTypingComplete(true);
          return;
        }
        setAnimationPhase('paused');
      }
    }
    
    // Handle pause phase - use the specific pause duration for this message
    if (animationPhase === 'paused') {
      const timer = setTimeout(() => {
        setAnimationPhase('fading');
      }, pauseDuration);
      return () => clearTimeout(timer);
    }
    
    // Handle fading phase
    if (animationPhase === 'fading') {
      const timer = setTimeout(() => {
        // Move to next message and reset
        setCurrentMessageIndex(prev => prev + 1);
        setAnimationPhase('revealing');
        setRevealProgress(0);
      }, 300); // Fade duration
      return () => clearTimeout(timer);
    }
    
  }, [currentMessageIndex, animationPhase, revealProgress, selectedAgentId, isLoadingNetwork, isTypingComplete]);
  
  // Dot animation for "Loading AI Network"
  useEffect(() => {
    if (!isLoadingNetwork) return;
    
    const dotSequence = ['.', '..', '...'];
    let currentIndex = 0;
    
    const interval = setInterval(() => {
      currentIndex = (currentIndex + 1) % dotSequence.length;
      setLoadingDots(dotSequence[currentIndex]);
    }, 500); // Change dots every 500ms
    
    return () => clearInterval(interval);
  }, [isLoadingNetwork]);
  
  // Reset loading network state when agent is fully loaded with messages
  useEffect(() => {
    if (selectedAgentId && !isLoadingAgent && agentDetail?.status !== 'STARTING_UP') {
      setIsLoadingNetwork(false);
    }
  }, [selectedAgentId, isLoadingAgent, agentDetail?.status]);
  
  // Rotate popular goals carousel like a stock ticker with constant motion
  useEffect(() => {
    if (selectedAgentId) {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      return;
    }

    const animate = () => {
      const now = Date.now();
      const deltaTime = now - lastTimeRef.current;
      lastTimeRef.current = now;

      setTickerOffset(prev => {
        if (!tickerRef.current) return prev;
        
        // Calculate how much to move (pixels per millisecond * deltaTime)
        const pixelsPerSecond = 30; // Adjust speed here
        const newOffset = prev + (pixelsPerSecond * deltaTime) / 1000;
        
        // Get the width of one complete set of goals
        const singleSetWidth = tickerRef.current.scrollWidth / 3;
        
        // Reset when we've scrolled past one full set
        if (newOffset >= singleSetWidth) {
          return newOffset - singleSetWidth;
        }
        
        return newOffset;
      });

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [selectedAgentId]);

  // Tile animation - pause 1 second, then play once through all frames
  useEffect(() => {
    if (animationComplete) return;

    // Pause for 0.8 seconds before starting animation
    const startDelay = setTimeout(() => {
      tileAnimationRef.current = setInterval(() => {
        setCurrentFrame((prev) => {
          const nextFrame = prev + 1;
          if (nextFrame >= frameSequence.length) {
            // Animation complete - stop on last frame
            setAnimationComplete(true);
            if (tileAnimationRef.current) {
              clearInterval(tileAnimationRef.current);
            }
            return frameSequence.length - 1;
          }
          return nextFrame;
        });
      }, FRAME_DURATION_MS);
    }, 800);

    return () => {
      clearTimeout(startDelay);
      if (tileAnimationRef.current) {
        clearInterval(tileAnimationRef.current);
      }
    };
  }, [FRAME_DURATION_MS, animationComplete]);

  // Check authentication and set up auth state listener
  useEffect(() => {
    checkAuth();
    
    // Listen for auth state changes and update realtime connection and user state
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        await supabase.realtime.setAuth(session.access_token);
        setUser(session.user);
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
      }
    });
    
    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const checkAuth = async () => {
    try {
      const currentUser = await getCurrentUser();
      if (!currentUser) {
        navigate('/');
        return;
      }
      setUser(currentUser);
      
      // Initialize realtime with auth token after authentication
      await initializeRealtime();
    } catch (error) {
      navigate('/');
    }
  };

  // Load agents on mount
  useEffect(() => {
    if (user) {
      loadAgents();
    }
  }, [user]);

  // Poll agents every 10 seconds
  useEffect(() => {
    if (!user) return;

    const intervalId = setInterval(() => {
      loadAgents();
    }, 10000); // 10 seconds

    return () => {
      clearInterval(intervalId);
    };
  }, [user]);

  // Subscribe to realtime updates when agent is selected
  useEffect(() => {
    if (!selectedAgentId || !user) return;

    // Prevent concurrent reconnection attempts
    if (isReconnectingRef.current) {
      console.log('⏳ Reconnection already in progress, skipping...');
      return;
    }

    isReconnectingRef.current = true;

    // Clean up previous channel
    if (channelRef.current) {
      console.log('🧹 Unsubscribing from previous channel');
      channelRef.current.unsubscribe();
      channelRef.current = null;
    }

    // Clear any pending reconnection timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Async setup for realtime with auth
    const setupRealtime = async () => {
      try {
        // Subscribe to agent channel using clean subscription pattern
        const channel = await subscribeToAgent(selectedAgentId, {
          onInsert: (payload) => {
            // Handle message inserts - data is in payload.record
            const data = payload.payload?.record;
            if (!data) return;
            
            const message: Message = {
              message_id: data.id,
              timestamp: data.timestamp,
              text: data.text,
              role: data.role,
              metadata: data.metadata,
            };
            
            // Add to buffer queue - it will be displayed when ready
            setMessageBuffer((prev) => [...prev, message]);
          },
          onUpdate: (payload) => {
            // Handle agent updates - data is in payload.record
            const updated = payload.record || payload.payload?.record;
            if (!updated) return;
            
            // Update agent detail in state directly (no refetch = no flicker)
            setAgentDetail((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                progress: updated.progress ?? prev.progress,
                status: updated.status ?? prev.status,
                status_message: updated.statusMessage ?? prev.status_message,
                model: updated.model ?? prev.model,
                token_count: updated.tokenCount ?? prev.token_count,
                tokens_in: updated.tokensIn ?? prev.tokens_in,
                tokens_out: updated.tokensOut ?? prev.tokens_out,
                context_size: updated.contextSize ?? prev.context_size,
                message_count: updated.messageCount ?? prev.message_count,
                updated_at: updated.updatedAt ?? prev.updated_at,
              };
            });
            // Also refresh agents list to update sidebar
            loadAgents();
          },
        });

        channelRef.current = channel;
        
        // Reset reconnection state on successful subscription
        reconnectAttemptRef.current = 0;
        isReconnectingRef.current = false;
        
        // Refetch messages to catch any that were created before subscription
        try {
          const data = await getAgent(selectedAgentId);
          setMessages(data.messages);
          setAgentDetail(data.agent);
        } catch (error) {
          console.error('Failed to refetch messages after subscription:', error);
        }
      } catch (error) {
        console.error('Failed to subscribe to agent channel:', error);
        isReconnectingRef.current = false;
        scheduleReconnect();
      }

      // Helper function to schedule reconnection with exponential backoff
      function scheduleReconnect() {
        // Don't reconnect if we've switched agents or logged out
        if (!selectedAgentId || !user) return;

        // Clear any existing timeout
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
        }

        // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
        const attempt = reconnectAttemptRef.current;
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        
        reconnectAttemptRef.current += 1;

        reconnectTimeoutRef.current = window.setTimeout(() => {
          // Trigger re-subscription by updating the force counter
          setForceResubscribe(prev => prev + 1);
        }, delay);
      }

      return () => {
        isReconnectingRef.current = false;
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        unsubscribe(channelRef.current);
        channelRef.current = null;
      };
    };

    // Call the async setup function
    setupRealtime();
  }, [selectedAgentId, user, forceResubscribe]);

  // Handle tab visibility changes - reconnect when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && selectedAgentId) {
        // Tab became visible
        console.log('👀 Tab became visible, ensuring fresh connection...');
        
        // Wait a bit to ensure browser has resumed network activity
        setTimeout(() => {
          if (selectedAgentId) {
            console.log('🔄 Forcing reconnection after tab visibility change');
            setForceResubscribe(prev => prev + 1);
          }
        }, 1000);
      } else if (document.hidden) {
        console.log('😴 Tab hidden - connection may be suspended by browser');
      }
    };

    const handleFocus = () => {
      if (selectedAgentId) {
        console.log('🎯 Window focused, ensuring connection is alive...');
        // Check connection health when window gets focus
        setTimeout(() => {
          if (selectedAgentId) {
            setForceResubscribe(prev => prev + 1);
          }
        }, 500);
      }
    };

    // Listen for visibility changes and focus events
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [selectedAgentId]);

  // Snap to bottom when messages change (only if user was already near bottom)
  // BUT: Don't scroll for browser action messages - those only scroll their own panel
  useEffect(() => {
    if (!messagesEndRef.current) return;

    // Check if the last message added was a browser action
    // Browser actions should only scroll their panel, not the main chat
    const lastMessage = messages[messages.length - 1];
    const isBrowserAction = lastMessage?.metadata?.browser_url;
    
    if (isBrowserAction) {
      console.log('📜 [Scroll] Skipping main chat scroll - browser action should scroll panel only');
      return;
    }

    // Skip auto-scroll if there's an active or paused browser panel
    // Check if any message has task_id without being completed
    const hasActiveBrowser = messages.some(msg => {
      const taskId = msg.metadata?.task_id;
      if (!taskId) return false;
      
      // Find the last message for this task_id
      const taskMessages = messages.filter(m => m.metadata?.task_id === taskId);
      const lastTaskMessage = taskMessages[taskMessages.length - 1];
      const actionType = lastTaskMessage?.metadata?.action_type;
      
      // Browser task is active if it exists and is not completed/error
      const isComplete = actionType === 'task_complete' || actionType === 'error';
      return !isComplete;
    });
    
    if (hasActiveBrowser) {
      console.log('📜 [Scroll] Skipping auto-scroll (active browser panel)');
      return;
    }

    // Find the radix scroll area viewport
    const scrollContainer = messagesEndRef.current.closest('[data-radix-scroll-area-viewport]');
    if (!scrollContainer) return;

    // If this is an initial load, SNAP to bottom instantly (no smooth scroll)
    if (isInitialLoadRef.current) {
      // Use requestAnimationFrame to ensure DOM has fully updated
      requestAnimationFrame(() => {
        // Force instant snap by setting scrollTop directly
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        isInitialLoadRef.current = false; // Reset flag after scrolling
      });
      return;
    }

    // Calculate distance from bottom
    const scrollHeight = scrollContainer.scrollHeight;
    const scrollTop = scrollContainer.scrollTop;
    const clientHeight = scrollContainer.clientHeight;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    // Only snap to bottom if user was already near bottom (within 500px)
    // This preserves scroll position if user is reading old messages
    // Larger threshold prevents new messages from pushing user out of auto-scroll
    if (distanceFromBottom < 500) {
      console.log('📜 [Scroll] Auto-scrolling main chat to bottom');
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [messages]);

  // Handler for when animation completes
  const handleAnimationComplete = () => {
    setIsAnimating(false);
    setCurrentAnimatingId(null);
  };

  // Process message buffer - pull one message at a time and display it
  useEffect(() => {
    // Only process if: buffer has messages AND we're not currently animating
    if (messageBuffer.length > 0 && !isAnimating) {
      const nextMessage = messageBuffer[0];
      
      // Add to displayed messages
      setMessages((prev) => [...prev, nextMessage]);
      
      // Remove from buffer
      setMessageBuffer((prev) => prev.slice(1));
      
      // Check if this message should animate
      let shouldAnimate = false;
      
      // ASSISTANT messages always animate
      if (nextMessage.role === 'ASSISTANT') {
        shouldAnimate = true;
      }
      
      // TOOL messages animate if they are FINISHED, have a message, AND are NOT sub-agent tools
      // Browser actions also animate - just inside their panel instead of main chat
      if (nextMessage.role === 'TOOL') {
        const isSubAgentTool = !!nextMessage.metadata?.subAgentId;
        const isBrowserAction = !!nextMessage.metadata?.browser_url;
        const status = nextMessage.metadata?.toolStatus;
        const message = nextMessage.text || '';
        
        // All tool messages (including browser actions) animate and block the buffer
        if (!isSubAgentTool && status === 'FINISHED' && message.trim().length > 0) {
          shouldAnimate = true;
        }
      }
      
      if (shouldAnimate) {
        setIsAnimating(true);
        setCurrentAnimatingId(nextMessage.message_id);
      }
    }
  }, [messageBuffer, isAnimating]);

  // Check if we should show the loader (agent is thinking)
  const [showThinkingLoader, setShowThinkingLoader] = useState(false);
  
  useEffect(() => {
    // Don't show loader if:
    // - No agent detail
    // - Agent is not active (paused, completed, failed)
    // - We have messages in the buffer waiting to display
    // - We're currently animating a message
    if (!agentDetail || 
        agentDetail.status === 'COMPLETED' || 
        agentDetail.status === 'FAILED' || 
        agentDetail.status === 'PAUSED' ||
        messageBuffer.length > 0 ||
        isAnimating) {
      setShowThinkingLoader(false);
      return;
    }

    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      setShowThinkingLoader(false);
      return;
    }

    // Check if last message is a tool with IN_PROGRESS status
    if (lastMessage.role === 'TOOL') {
      const status = lastMessage.metadata?.toolStatus;
      if (status === 'IN_PROGRESS') {
        setShowThinkingLoader(false);
        return;
      }
    }

    // Track when we last saw this message (use local time to avoid clock sync issues)
    let lastSeenTime = Date.now();

    // Check every 100ms to ensure we don't miss the threshold
    const checkThreshold = () => {
      const timeSinceWeFirstSawMessage = Date.now() - lastSeenTime;
      const shouldShow = timeSinceWeFirstSawMessage > 500;
      setShowThinkingLoader(shouldShow);
    };

    // Check immediately
    checkThreshold();

    // Then check every 100ms
    const interval = setInterval(checkThreshold, 100);
    
    return () => clearInterval(interval);
  }, [messages, agentDetail, isAnimating, messageBuffer]);

  const loadAgents = async () => {
    try {
      // Only show loading state on first load
      if (isFirstLoad) {
        setIsLoadingAgents(true);
      }
      const fetchedAgents = await getAllAgents();
      setAgents(fetchedAgents);
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load agents',
        variant: 'destructive',
      });
    } finally {
      if (isFirstLoad) {
        setIsLoadingAgents(false);
        setIsFirstLoad(false);
      }
    }
  };

  const loadAgentDetail = async (agentId: string) => {
    try {
      setIsLoadingAgent(true);
      const data = await getAgent(agentId);
      setAgentDetail(data.agent);
      setMessages(data.messages); // Already in chronological order (oldest first)
      setSelectedModel(data.agent.model); // Sync UI model with agent's actual model
      
      // Mark this as an initial load so we can scroll to bottom
      isInitialLoadRef.current = true;
      
      // Clear animation state and buffer when loading a different agent
      setIsAnimating(false);
      setCurrentAnimatingId(null);
      setMessageBuffer([]);
      
      // Reset reconnection state when switching agents
      reconnectAttemptRef.current = 0;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to load agent details',
        variant: 'destructive',
      });
    } finally {
      setIsLoadingAgent(false);
    }
  };

  const handleSelectAgent = (agentId: string) => {
    setCurrentView('agents');
    setSelectedAgentId(agentId);
    loadAgentDetail(agentId);
    setIsSidebarOpen(false);
  };

  const handleCreateAgent = async (data: CreateAgentPayload) => {
    const newAgent = await createAgentAPI(data);
    await loadAgents();
    setCurrentView('agents');
    setSelectedAgentId(newAgent.agent_id);
    loadAgentDetail(newAgent.agent_id);
  };

  const handleResumeAgent = async (agentId: string) => {
    try {
      setResumingAgentId(agentId);
      await resumeAgent(agentId);
      
      // If this is the currently selected agent, reload its details
      if (agentId === selectedAgentId) {
        await loadAgentDetail(agentId);
      }
      
      // Refresh the agents list to show updated status
      await loadAgents();
      
      toast({
        title: 'Success',
        description: 'Agent resumed',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to resume agent',
        variant: 'destructive',
      });
    } finally {
      setResumingAgentId(null);
    }
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim()) return;

    // Check if user is logged in before attempting any API calls
    console.log('user', user);
    if (!user) {
      console.log('User not logged in, opening login modal');
      setLoginModalOpen(true);
      toast({
        title: 'Authentication required',
        description: 'Please log in to continue',
      });
      return;
    }

    try {
      setIsSendingMessage(true);
      
      // If no agent selected, create a new agent
      if (!selectedAgentId) {
        // Trigger loading network animation
        setIsLoadingNetwork(true);
        
        const newAgent = await createAgentAPI({
          goal: messageInput,
          model: selectedModel,
          verifier: {
            type: 'FLOAT_LLM_JUDGE',
            llm_judge_prompt: `You are judging whether the agent has achieved the following goal: "${messageInput}"\n\nScoring Instructions:\n- Return a float between 0.0 and 1.0.\n- 0.0 means no progress or only explanations/plans.\n- 1.0 means the goal is FULLY accomplished with verifiable proof.\n- Do not award 1.0 for partial completion.\n- The agent has access to tools and can solve problems through persistence and creativity.`,
          },
        });
        await loadAgents();
        setCurrentView('agents');
        setSelectedAgentId(newAgent.agent_id);
        await loadAgentDetail(newAgent.agent_id);
        setMessageInput(''); // Clear input after agent is loaded
        toast({
          title: 'Agent created',
          description: 'Your new agent has been created and is starting',
        });
        return;
      }
      
      // Check if there's a pending attention request for this agent and respond to it
      const respondedToRequest = await checkAndRespondToAttentionRequest(
        selectedAgentId,
        messageInput
      );
      
      if (respondedToRequest) {
        toast({
          title: 'Response sent',
          description: 'The agent will continue with your response',
        });
        setMessageInput('');
        return;
      }
      
      // Normal message flow
      await postMessageAPI(selectedAgentId, messageInput);
      // Don't add message here - let Realtime subscription handle it to avoid duplicates
      setMessageInput('');
    } catch (error: any) {
      // Check if it's an authentication error
      if (error.message === 'Not authenticated' || error.message?.includes('401') || error.message?.includes('Unauthorized')) {
        setLoginModalOpen(true);
        toast({
          title: 'Authentication required',
          description: 'Please log in to continue',
        });
      } else {
        toast({
          title: 'Error',
          description: selectedAgentId ? 'Failed to send message' : 'Failed to create agent',
          variant: 'destructive',
        });
      }
    } finally {
      setIsSendingMessage(false);
    }
  };


  const handleLogout = async () => {
    try {
      await signOut();
      navigate('/');
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to log out',
        variant: 'destructive',
      });
    }
  };

  const handleCreateNewAgent = () => {
    setCurrentView('agents');
    setSelectedAgentId(null);
    setAgentDetail(null); // Clear agent detail to reset completed status
    setMessages([]);
    setMessageInput('');
    setIsSidebarOpen(false);
    
    // Reset animation state to replay like on page load
    setCurrentFrame(0);
    setAnimationComplete(false);
    setAnimationResetKey(prev => prev + 1); // Force SmallTileAnimationCanvas to remount and clear everColoredTiles
    
    // Reset opening messages animation
    setCurrentMessageIndex(0);
    setAnimationPhase('revealing');
    setRevealProgress(0);
    setIsTypingComplete(false);
    setIsLoadingNetwork(false);
  };

  const sortedAgents = [...agents].sort((a, b) => {
    // Completed agents go to the bottom
    if (a.status === 'COMPLETED' && b.status !== 'COMPLETED') return 1;
    if (a.status !== 'COMPLETED' && b.status === 'COMPLETED') return -1;
    // Paused agents go to the bottom (but above completed)
    if (a.status === 'PAUSED' && b.status !== 'PAUSED') return 1;
    if (a.status !== 'PAUSED' && b.status === 'PAUSED') return -1;
    // Otherwise sort by progress (descending)
    return b.progress - a.progress;
  });

  // Memoize deduplicated messages to prevent unnecessary re-renders
  const { displayedMessages, browserPanels } = useMemo(() => {
    const deduplicated = deduplicateToolMessages(messages.filter((m) => m.role !== 'SYSTEM'));
    const grouped = groupBrowserMessages(deduplicated);
    return { displayedMessages: grouped.messages, browserPanels: grouped.browserPanels };
  }, [messages]);

  // Get system messages
  const systemMessages = messages.filter((m) => m.role === 'SYSTEM');

  // Calculate pattern offset dynamically based on viewport
  const [patternOffset, setPatternOffset] = useState({ x: 0, y: 0 });
  
  useEffect(() => {
    const updatePatternOffset = () => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Large tile corners are at (50% - 214.5px, 40% - 214.5px)
      // Pattern needs grid lines to hit exactly at those positions
      const tileX = viewportWidth * 0.5 - 214.5;
      const tileY = viewportHeight * 0.4 - 214.5;
      
      // Pattern offset: grid lines at px + k*143, we want one at tileX
      // So px = tileX mod 143 (handling negatives correctly)
      const x = ((tileX % 143) + 143) % 143;
      const y = ((tileY % 143) + 143) % 143;
      
      setPatternOffset({ x, y });
    };
    
    updatePatternOffset();
    window.addEventListener('resize', updatePatternOffset);
    return () => window.removeEventListener('resize', updatePatternOffset);
  }, []);

  // Calculate tile colors based on current animation frame - simple and direct
  const tileColors = useMemo(() => {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const frameName = frameSequence[currentFrame];
    return getTileColorsForFrame(frameName, viewportWidth, viewportHeight, 143, 429);
  }, [currentFrame]);


  return (
    <div className="h-screen w-screen flex flex-col bg-background dark:bg-navi-black relative overflow-hidden">
      {/* Background Pattern - z-[3] renders tile borders above animation canvases (z-[2]) */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none z-[3]" xmlns="http://www.w3.org/2000/svg" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
        <defs>
          {/* Navi gradient for top corners */}
          <linearGradient id="navi-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#FE7503" />
            <stop offset="20%" stopColor="#FC585C" />
            <stop offset="40%" stopColor="#FD5776" />
            <stop offset="60%" stopColor="#E062CC" />
            <stop offset="80%" stopColor="#A76CED" />
            <stop offset="100%" stopColor="#7A6BEC" />
          </linearGradient>
          
          <pattern id="grid-pattern" x={patternOffset.x} y={patternOffset.y} width="143" height="143" patternUnits="userSpaceOnUse">
            {/* Small tile square outline - transparent background to show animated colors */}
            <rect x="0" y="0" width="143" height="143" fill="transparent" stroke="rgb(229, 231, 235)" strokeWidth="1" className="dark:stroke-gray-800" />
            
            {/* Corner diamonds with concave (inward curved) sides */}
            <path d="M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" />
            <path d="M 143,-11 Q 143,0 154,0 Q 143,0 143,11 Q 143,0 132,0 Q 143,0 143,-11 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" />
            <path d="M 0,132 Q 0,143 11,143 Q 0,143 0,154 Q 0,143 -11,143 Q 0,143 0,132 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" />
            <path d="M 143,132 Q 143,143 154,143 Q 143,143 143,154 Q 143,143 132,143 Q 143,143 143,132 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" />
          </pattern>
          
          {/* Mask to hide small tiles inside large tile area */}
          <mask id="large-tile-mask">
            <rect x="-5000" y="-5000" width="10000" height="10000" fill="white" />
            {/* Black out the interior of the large tile (slightly inset to preserve boundary corners) */}
            <rect x="50%" y="40%" width="426.8" height="426.8" style={{ transform: 'translate(-213.4px, -213.4px)' }} fill="black" />
          </mask>
        </defs>
        
        {/* Animated tiles overlay - render first (background layer) */}
        {Array.from(tileColors.entries()).map(([key, colorId]) => {
          const [row, col] = key.split(',').map(Number);
          const color = colorPalette[colorId];
          
          const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
          const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;
          const centerX = viewportWidth / 2;
          const centerY = viewportHeight * 0.4;
          const tileSize = 143;
          const largeTileSize = 429;
          const largeTileHalf = largeTileSize / 2;
          
          const tilesLeft = Math.floor((centerX - largeTileHalf) / tileSize);
          const tilesUp = Math.floor((centerY - largeTileHalf) / tileSize);
          const gridOriginX = centerX - largeTileHalf - (tilesLeft * tileSize);
          const gridOriginY = centerY - largeTileHalf - (tilesUp * tileSize);
          
          const x = gridOriginX + col * tileSize;
          const y = gridOriginY + row * tileSize;
          
          return (
            <rect
              key={key}
              x={x}
              y={y}
              width={tileSize}
              height={tileSize}
              fill={colorId === 0 ? 'transparent' : color.hex}
              style={{
                // TEMP DEBUG: Remove transition to see instant changes
                // transition: 'fill 0.3s ease-in-out'
              }}
            />
          );
        })}
        
        {/* Small tiles pattern everywhere except inside large tile - render on top of animated colors */}
        <rect x="-5000" y="-5000" width="10000" height="10000" fill="url(#grid-pattern)" mask="url(#large-tile-mask)" />
        
        {/* Large tile border (3x3 size = 429x429) aligned with small tile grid */}
        {/* Pattern offset ensures corners land exactly on grid intersections */}
        <rect x="50%" y="40%" width="429" height="429" style={{ transform: 'translate(-214.5px, -214.5px)' }} fill="none" stroke="rgb(229, 231, 235)" strokeWidth="1" className="dark:stroke-gray-800" />
        
        {/* Large tile corner diamonds with concave sides (shared with surrounding small tiles) */}
        {/* Top-left corner with circle and perfectly smooth geometric diamond shape */}
        <circle cx="0" cy="0" r="25" fill="none" stroke="rgb(229, 231, 235)" strokeWidth="1" className="dark:stroke-gray-800" style={{ transform: 'translate(calc(50% - 214.5px), calc(40% - 214.5px))' }} />
        <path d="M 0.5,-12 L 0.5,-6 C 0.5,-4 2,-2 4,-1 L 6,-0.5 L 12,-0.5 L 12,0.5 L 6,0.5 L 4,1 C 2,2 0.5,4 0.5,6 L 0.5,12 L -0.5,12 L -0.5,6 C -0.5,4 -2,2 -4,1 L -6,0.5 L -12,0.5 L -12,-0.5 L -6,-0.5 L -4,-1 C -2,-2 -0.5,-4 -0.5,-6 L -0.5,-12 Z" fill="url(#navi-gradient)" style={{ transform: 'translate(calc(50% - 214.5px), calc(40% - 214.5px))' }} />
        
        {/* Top-right corner with circle and perfectly smooth geometric diamond shape */}
        <circle cx="0" cy="0" r="25" fill="none" stroke="rgb(229, 231, 235)" strokeWidth="1" className="dark:stroke-gray-800" style={{ transform: 'translate(calc(50% + 214.5px), calc(40% - 214.5px))' }} />
        <path d="M 0.5,-12 L 0.5,-6 C 0.5,-4 2,-2 4,-1 L 6,-0.5 L 12,-0.5 L 12,0.5 L 6,0.5 L 4,1 C 2,2 0.5,4 0.5,6 L 0.5,12 L -0.5,12 L -0.5,6 C -0.5,4 -2,2 -4,1 L -6,0.5 L -12,0.5 L -12,-0.5 L -6,-0.5 L -4,-1 C -2,-2 -0.5,-4 -0.5,-6 L -0.5,-12 Z" fill="url(#navi-gradient)" style={{ transform: 'translate(calc(50% + 214.5px), calc(40% - 214.5px))' }} />
        
        {/* Bottom corners keep original styling */}
        <path d="M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" style={{ transform: 'translate(calc(50% - 214.5px), calc(40% + 214.5px))' }} />
        <path d="M 0,-11 Q 0,0 11,0 Q 0,0 0,11 Q 0,0 -11,0 Q 0,0 0,-11 Z" fill="rgb(229, 231, 235)" className="dark:fill-gray-800" style={{ transform: 'translate(calc(50% + 214.5px), calc(40% + 214.5px))' }} />
      </svg>

      {/* Small Tile Animations Canvas Overlay */}
      <SmallTileAnimationCanvas 
        key={animationResetKey}
        enabled={true} 
        tileAnimationComplete={animationComplete}
        currentFrame={currentFrame}
        tileColors={tileColors}
        selectedAgentId={selectedAgentId}
      />

      {/* Floating Blur Header */}
      <header 
        className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center justify-between px-1 py-1 rounded-2xl border border-border/50 dark:border-navi-light-black/50 shadow-lg"
        style={{
          width: '320px',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <div className="flex items-center space-x-1">
          <button 
            onClick={handleCreateNewAgent}
            className="flex items-center space-x-2.5 px-1 cursor-pointer hover:opacity-80 transition-opacity"
          >
            <div
              className="w-8 h-8 rounded-lg flex-shrink-0"
              style={{
                background:
                  'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
              }}
            ></div>
            <span className="text-base font-semibold tracking-tight">Rose</span>
          </button>
        </div>
        
        {/* Research Button - Absolutely centered in viewport */}
        <a
          href="/"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Research
        </a>
        
        {/* Attention Inbox */}
        <AttentionInbox onSelectAgent={setSelectedAgentId} />
      </header>

      {/* Hamburger Menu Button - Top Left - Sibling to Header */}
      <div 
        className="absolute top-4 z-50"
        style={{
          left: 'calc(50% - 448px - 38px - 16px)', // QueryBox is 896px wide (448px from center), button is 38px, gap is 16px
        }}
      >
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="w-[38px] h-[38px] flex items-center justify-center rounded-lg border border-border/50 dark:border-navi-light-black/50 shadow-lg hover:bg-white/10 transition-colors"
          style={{
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
          aria-label="Toggle menu"
        >
          {isSidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Gift Button - To the left of Agent Settings - Sibling to Header */}
      <div 
        className="absolute top-4 z-50"
        style={{
          left: 'calc(50% + 448px + 16px)', // QueryBox right edge + gap
        }}
      >
        <button
          ref={giftButtonRef}
          onClick={() => {
            if (user) {
              if (!inviteCodeModalOpen && giftButtonRef.current) {
                const rect = giftButtonRef.current.getBoundingClientRect();
                setInviteModalPosition({
                  top: rect.bottom + 8,
                  right: window.innerWidth - rect.right,
                });
              }
              setInviteCodeModalOpen(!inviteCodeModalOpen);
            }
          }}
          disabled={!user}
          className={cn(
            "w-[38px] h-[38px] flex items-center justify-center rounded-lg bg-navi-black border border-navi-light-black shadow-lg transition-all duration-200",
            user 
              ? "hover:bg-navi-light-black cursor-pointer opacity-100" 
              : "cursor-not-allowed opacity-50"
          )}
          aria-label="Invite Code"
        >
          <Gift className="w-5 h-5 text-white" />
        </button>
      </div>

      {/* Invite Code Modal - Fixed positioning - Sibling to Header */}
      {inviteCodeModalOpen && user && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-[55]"
            onClick={() => setInviteCodeModalOpen(false)}
          />

          {/* Popover content */}
          <div 
            className="fixed z-[60] w-[320px] border border-gray-300 rounded-lg shadow-lg overflow-hidden"
            style={{ 
              top: `${inviteModalPosition.top}px`,
              right: `${inviteModalPosition.right}px`,
              backgroundColor: 'transparent',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(12px)',
            }}
          >
            <div className="p-5 space-y-4">
              <div className="text-center mb-2">
                <p className="text-sm font-medium text-navi-black">
                  Your Invite Code
                </p>
                <p className="text-xs text-navi-black/70 mt-1">
                  Share this code with friends to invite them to Navi
                </p>
              </div>

              <InviteCodeContent />
            </div>
          </div>
        </>
      )}

      {/* Agent Settings Button - Top Right - Sibling to Header */}
      <div 
        className="absolute top-4 z-50"
        style={{
          left: 'calc(50% + 448px + 16px + 38px + 12px)', // QueryBox right edge + gap + gift button + gap
        }}
      >
        <AgentSettingsDialog 
          agent={agentDetail} 
          onUpdate={() => selectedAgentId && loadAgentDetail(selectedAgentId)}
          onDelete={() => {
            setCurrentView('agents');
            setSelectedAgentId(null);
            setMessages([]);
            loadAgents();
          }}
        />
      </div>

      <div className="h-screen flex items-center justify-center z-[4]">
        {/* Overlay */}
        {isSidebarOpen && (
          <div 
            className="absolute inset-0 bg-black/20 z-[55] transition-opacity duration-300"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}
        
        {/* Left Sidebar - Positioned Absolute */}
        <aside 
          className={cn(
            "absolute top-0 left-0 h-full w-64 border-r border-border/50 dark:border-navi-light-black/50 flex flex-col z-[60] shadow-2xl transition-transform duration-300 ease-in-out bg-white/80 dark:bg-navi-black/80",
            isSidebarOpen ? "translate-x-0" : "-translate-x-full"
          )}
          style={{
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
          }}
        >
          {/* Create Agent Button */}
          <div className="p-3">
              <Button
              onClick={handleCreateNewAgent}
              className="w-full"
              size="lg"
            >
              <Plus className="h-4 w-4 mr-2" />
              Create Agent
            </Button>
          </div>

          {/* Agent List */}
          <ScrollArea className="flex-1">
            <div className="px-3 py-2 space-y-1">
              {isLoadingAgents && agents.length === 0 ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : sortedAgents.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  No agents yet
                </div>
              ) : (
                sortedAgents.map((agent) => (
                  <AgentListItem
                    key={agent.agent_id}
                    agent={agent}
                    isSelected={selectedAgentId === agent.agent_id}
                    onClick={() => handleSelectAgent(agent.agent_id)}
                    onResume={handleResumeAgent}
                    isResuming={resumingAgentId === agent.agent_id}
                  />
                ))
              )}
            </div>
          </ScrollArea>

          {/* Usage Visualization */}
          <div className="px-4 py-3">
            <UsageDisplay />
          </div>

          {/* Bottom Actions - with border top */}
          <div className="border-t border-border dark:border-navi-light-black">
            <div className="p-3 space-y-1">
              {/* Settings Button */}
              <button
                onClick={() => {
                  setCurrentView('settings');
                  setSelectedAgentId(null);
                  setIsSidebarOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-navi-white-dark dark:hover:bg-navi-light-light-black"
              >
                <SettingsIcon className="h-4 w-4" />
                <span>Settings</span>
              </button>

              {/* Usage Button */}
              <button
                onClick={() => {
                  navigate('/usage');
                  setIsSidebarOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-navi-white-dark dark:hover:bg-navi-light-light-black"
              >
                <BarChart3 className="h-4 w-4" />
                <span>Usage</span>
              </button>
            </div>
          </div>

          {/* Logout - Separate border */}
          <div className="border-t border-border dark:border-navi-light-black">
            <div className="p-3">
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-navi-white-dark dark:hover:bg-navi-light-light-black"
              >
                <LogOut className="h-4 w-4" />
                <span>Logout</span>
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content - Centered */}
        <main className="flex flex-col relative max-w-5xl w-full h-screen">
          {/* Breadcrumb for sub-agents - Below Header */}
          {selectedAgentId && agentDetail?.parent_agent_id && agentDetail?.parent_goal && (
            <div className="absolute top-20 left-0 right-0 z-40 px-6">
              <div className="max-w-4xl mx-auto">
                <button
                  onClick={() => {
                    if (agentDetail.parent_agent_id) {
                      handleSelectAgent(agentDetail.parent_agent_id);
                    }
                  }}
                  className="px-4 py-2 rounded-lg text-sm flex items-center gap-2 border border-gray-200/50 dark:border-gray-700/50 bg-white/80 dark:bg-gray-800/80 shadow-lg"
                  style={{
                    backdropFilter: 'blur(12px)',
                    WebkitBackdropFilter: 'blur(12px)',
                  }}
                >
                  <span className="truncate max-w-[200px] text-gray-600 dark:text-gray-400">{agentDetail.parent_goal}</span>
                  <span className="text-gray-400 dark:text-gray-500">›</span>
                  <span className="font-medium truncate max-w-[200px] text-gray-800 dark:text-gray-200">{agentDetail.goal}</span>
                </button>
              </div>
            </div>
          )}

          {/* System Messages - Top Right */}
          {selectedAgentId && systemMessages.length > 0 && (
            <div className="absolute top-4 right-28 max-w-md z-10">
              <div className="bg-card dark:bg-navi-light-black border border-border dark:border-navi-light-light-black rounded-lg p-4 shadow-lg">
                <h3 className="text-sm font-semibold mb-2">System Messages</h3>
                <ScrollArea className="max-h-48">
                  <div className="space-y-2">
                    {systemMessages.map((msg) => (
                      <div
                        key={msg.message_id}
                        className="text-xs p-2 bg-blue-500/10 dark:bg-blue-500/20 border border-blue-500/30 rounded"
                      >
                        <p>{msg.text}</p>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </div>
          )}

          {/* Main Content Area */}
          {currentView === 'settings' ? (
            // Settings View
            <Settings />
          ) : (
            <>
            <ScrollArea 
              className="flex-1 px-6 relative" 
              style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                justifyContent: 'center',
              }}
            >
              {/* Blur Background Overlay - sits behind messages but in front of ASCII loader */}
              <div 
                className="absolute inset-0 pointer-events-none ease-in-out"
                style={{
                  backdropFilter: selectedAgentId ? 'blur(20px)' : 'blur(0px)',
                  WebkitBackdropFilter: selectedAgentId ? 'blur(20px)' : 'blur(0px)',
                  maskImage: 'linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%)',
                  zIndex: 15,
                  transition: 'backdrop-filter 1.8s ease-in-out, -webkit-backdrop-filter 1.8s ease-in-out',
                }}
              />
              
              {/* Top padding to clear header */}
              <div className="h-24" />
              
              {/* Spacer for breadcrumb when viewing sub-agent */}
              {selectedAgentId && agentDetail?.parent_agent_id && agentDetail?.parent_goal && (
                <div className="h-14" />
              )}
              
              {/* ASCII Loader - Always visible, transitions to background when messages appear */}
              <div 
                className="absolute inset-0 flex items-center justify-center pointer-events-none transition-all duration-700 ease-in-out"
                style={{
                  opacity: (!selectedAgentId || displayedMessages.length === 0) ? 1 : 0.2,
                  transform: (!selectedAgentId || displayedMessages.length === 0) ? 'translateY(0)' : 'translateY(8px)',
                  zIndex: 18,
                  height: '100vh',
                }}
              >
                <div className="text-center space-y-6" style={{ marginBottom: '20vh' }}>
                  <AsciiLoader showWarmingUp={false} size="large" variant="engine" />
                  {(!selectedAgentId || displayedMessages.length === 0) && (
                    <div className="-mt-3">
                      {!selectedAgentId || isLoadingAgent || (selectedAgentId && agentDetail?.status === 'STARTING_UP') ? (
                        // No agent selected states OR loading agent OR agent starting up
                        isLoadingNetwork || isLoadingAgent || (selectedAgentId && agentDetail?.status === 'STARTING_UP') ? (
                          // Loading AI Network with animated dots
                          <p className="text-muted-foreground">
                            Loading AI Network{loadingDots}
                          </p>
                        ) : (
                          // Opening messages reveal animation - gradient sweep
                          <div className="relative min-w-[600px] h-8 flex items-center justify-center">
                            <p 
                              className="text-muted-foreground absolute inset-0 flex items-center justify-center"
                              style={{
                                WebkitMaskImage: animationPhase === 'revealing'
                                  ? `linear-gradient(90deg, 
                                      rgba(0,0,0,1) 0%, 
                                      rgba(0,0,0,1) ${Math.max(0, revealProgress - 20)}%, 
                                      rgba(0,0,0,0.5) ${revealProgress}%, 
                                      rgba(0,0,0,0) ${Math.min(100, revealProgress + 10)}%)`
                                  : animationPhase === 'fading'
                                  ? 'linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 100%)'
                                  : 'linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 100%)',
                                maskImage: animationPhase === 'revealing'
                                  ? `linear-gradient(90deg, 
                                      rgba(0,0,0,1) 0%, 
                                      rgba(0,0,0,1) ${Math.max(0, revealProgress - 20)}%, 
                                      rgba(0,0,0,0.5) ${revealProgress}%, 
                                      rgba(0,0,0,0) ${Math.min(100, revealProgress + 10)}%)`
                                  : animationPhase === 'fading'
                                  ? 'linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 100%)'
                                  : 'linear-gradient(90deg, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 100%)',
                                filter: animationPhase === 'revealing'
                                  ? `brightness(${0.3 + (revealProgress / 100) * 0.7})`
                                  : 'brightness(1)',
                                opacity: animationPhase === 'fading' ? 0 : 1,
                                transition: animationPhase === 'fading' ? 'opacity 0.3s ease-out' : 'none',
                              }}
                            >
                              {OPENING_MESSAGES[currentMessageIndex][0]}
                            </p>
                          </div>
                        )
                      ) : null}
                    </div>
                  )}
                </div>
              </div>
              
              {/* Messages - Always rendered */}
              <div 
                className="max-w-4xl mx-auto space-y-4 pb-32 relative z-20 transition-opacity duration-700 ease-in-out"
                style={{
                  opacity: displayedMessages.length > 0 ? 1 : 0,
                }}
              >
                {displayedMessages.map((message) => {
                  // Check if this is a browser panel message
                  if (message.metadata?._browserPanel) {
                    const taskId = message.metadata._taskId as string;
                    const panelData = browserPanels.get(taskId);
                    
                    if (!panelData) {
                      return null;
                    }

                    const mappedActions = panelData.actions.map((action) => ({
                      id: action.message_id,
                      title: action.metadata?.title || 'Browser action',
                      message: action.text,
                      status: action.metadata?.toolStatus || 'FINISHED',
                      timestamp: action.timestamp,
                      action_type: action.metadata?.action_type,
                      auxiliary: action.metadata?.auxiliary
                    }));
                    
                    // The last action should ALWAYS animate (whenever panel re-renders with new action)
                    // But ONLY if this is the message currently being processed from buffer
                    const lastAction = panelData.actions[panelData.actions.length - 1];
                    const isThisMessageAnimating = message.message_id === currentAnimatingId;
                    const isLastActionAnimating = lastAction && lastAction.message_id === currentAnimatingId;
                    const shouldAnimate = isLastActionAnimating || isThisMessageAnimating;
                    
                    return (
                      <BrowserViewPanel
                        key={message.message_id}
                        taskId={taskId}  // Use stable task_id as ID
                        browserUrl={panelData.currentBrowserUrl}  // Current browser URL (may change on resume)
                        actions={mappedActions}
                        shouldAnimate={shouldAnimate}
                        onAnimationComplete={handleAnimationComplete}
                        isAnyBrowserFullscreen={anyBrowserFullscreen}
                        onFullscreenToggle={setAnyBrowserFullscreen}
                      />
                    );
                  }
                  
                  // Regular message
                  return (
                    <MessageBubble 
                      key={message.message_id} 
                      message={message}
                      shouldType={message.message_id === currentAnimatingId}
                      onTypingComplete={handleAnimationComplete}
                      onNavigateToAgent={handleSelectAgent}
                    />
                  );
                })}
                
                {/* Show paused text when agent is paused */}
                {agentDetail?.status === 'PAUSED' && (
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8" />
                    <p className="text-sm text-muted-foreground">agent is paused</p>
                  </div>
                )}
                
                {/* Show completed text when agent is complete */}
                {agentDetail?.status === 'COMPLETED' && (
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8" />
                    <p className="text-sm text-muted-foreground">your goal is complete</p>
                  </div>
                )}
                
                {/* Show small ASCII loader when agent is thinking */}
                {showThinkingLoader && (
                  <div className="flex gap-3">
                    <div className="flex-shrink-0 w-8" />
                    <AsciiLoader showWarmingUp={false} size="icon" fitContainer />
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>
          </ScrollArea>

          {/* Message Input - Always visible */}
          <div 
            ref={queryInputRef}
            className="pb-6 transition-opacity duration-300 ease-in-out"
            style={{
              // Only fade for FAILED status, not COMPLETED (since we show a prominent button)
              opacity: agentDetail && agentDetail.status === 'FAILED' ? 0.8 : 1
            }}
          >
            {/* Popular Goals Carousel - Only visible when no agent selected */}
            {!selectedAgentId && (
              <div className="mb-4">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground whitespace-nowrap flex-shrink-0">Popular Goals</span>
                  <div className="relative flex-1 overflow-hidden">
                    <div 
                      ref={tickerRef}
                      className="flex gap-2"
                      style={{
                        transform: `translateX(-${tickerOffset}px)`
                      }}
                    >
                      {/* Render goals three times for seamless loop */}
                      {[...popularGoals, ...popularGoals, ...popularGoals].map((goal, i) => (
                        <button
                          key={i}
                          onClick={() => {
                            setMessageInput(goal);
                          }}
                          className="px-3 py-1 text-xs bg-secondary hover:bg-secondary/80 rounded-full whitespace-nowrap flex-shrink-0"
                        >
                          {goal}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            <QueryInput
              value={messageInput}
              onChange={setMessageInput}
              onSubmit={handleSendMessage}
              disabled={isSendingMessage}
              placeholder={selectedAgentId ? "Type your message..." : "Enter any goal"}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              availableModels={models}
              modelsLoading={modelsLoading}
              contextPercentage={agentDetail ? getContextPercentage(agentDetail, models) : 0}
              contextSize={agentDetail?.context_size || 0}
              restartThreshold={agentDetail ? Math.round(getModelContextWindow(agentDetail.model, models) * 0.8) : 100000}
              showModelSelector={!selectedAgentId}
              agentCompleted={selectedAgentId !== null && agentDetail?.status === 'COMPLETED'}
              onCreateNewAgent={handleCreateNewAgent}
            />
          </div>
          </>
          )}
        </main>
      </div>

      {/* Create Agent Modal */}
      <CreateAgentModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onSubmit={handleCreateAgent}
      />

      {/* Login Modal */}
      <PhoneAuthModal
        open={loginModalOpen}
        onOpenChange={setLoginModalOpen}
        triggerRef={queryInputRef}
      />
    </div>
  );
}

