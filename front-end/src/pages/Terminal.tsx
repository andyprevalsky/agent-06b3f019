/**
 * STATE MACHINE: Terminal (Main App View)
 *
 * HIGH-LEVEL VIEW STATES:
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                      currentView                                    │
 * │  'agents' | 'integrations' | 'settings' | 'usage' | 'network'      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * AGENT SELECTION FLOW:
 * ┌──────────────────┐     selectAgent(id)    ┌──────────────────────┐
 * │  NO_AGENT        │ ────────────────────> │  AGENT_SELECTED      │
 * │  selectedAgentId │                        │  selectedAgentId=id  │
 * │  = null          │ <──────────────────── │  messages, agentDetail│
 * └──────────────────┘    handleCreateNewAgent └──────────────────────┘
 *
 * OPENING ANIMATION (when NO_AGENT):
 * [REVEALING] --> revealProgress=100 --> [PAUSED] --> pauseDuration --> [FADING]
 *      ^                                                                    |
 *      └──────────── currentMessageIndex++ ────────────────────────────────┘
 *      ...until isTypingComplete=true (last message shown)
 *
 * MESSAGE SENDING FLOW:
 * ┌────────────────┐                      ┌─────────────────────┐
 * │  IDLE          │ ──── submit ───────> │  SENDING            │
 * │  isSendingMsg  │                      │  isSendingMessage   │
 * │  = false       │ <─── success/error ─ │  = true             │
 * └────────────────┘                      └─────────────────────┘
 *
 * AGENT STATUS (from agentDetail.status):
 * - STARTING_UP: Show "Loading AI Network..."
 * - ACTIVE: Show messages, can pause
 * - PAUSED: Can resume or send message
 * - COMPLETED: Show completion UI
 * - FAILED: Dimmed input
 * - OUT_OF_CREDITS: Show credit modal
 * - COST_LIMIT_REACHED: Show cost limit modal (resumable)
 *
 * MODAL STATES:
 * - createModalOpen: Create agent modal
 * - loginModalOpen: Phone auth modal
 * - showCreditModal: Subscription modal
 * - showCostLimitModal: Cost limit modal
 *
 * DRIPPINESS CONTROLS (persisted to localStorage):
 * - backgroundColors, blur, shadowIntensity, borderColor (0-100 each)
 */

import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react';
import { motion } from 'framer-motion';
import { useNavigate, Link } from 'react-router-dom';
import * as amplitude from '@amplitude/analytics-browser';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Plus, LogOut, Settings as SettingsIcon, BarChart3, Menu, X, Bot, Copy, Check, Plug, Network } from 'lucide-react';
import AppSidebar from '@/components/terminal/AppSidebar';
import { supabase, signOut, initializeRealtime, clearStoredSession } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
// Realtime subscription now handled by AgentContext
import {
  getAllAgents,
  getAgent,
  createAgent as createAgentAPI,
  postMessage as postMessageAPI,
  resumeAgent,
  pauseAgent,
  checkAndRespondToAttentionRequest,
  getMyInviteCode,
  fetchAncestors,
  findBlueprintByGoal,
  submitBlueprintFeedback,
  InviteCodeInfo,
  Agent,
  AgentDetail,
  Message,
  CreateAgentPayload,
  AncestorNode,
  BlueprintFeedback,
  FilePointer,
} from '@/lib/api';
import { getClientSource } from '@/lib/clientSource';
import CreateAgentModal from '@/components/terminal/CreateAgentModal';
import AgentListItem from '@/components/terminal/AgentListItem';
import MessageBubble from '@/components/terminal/MessageBubble';
import { MarkdownText } from '@/components/terminal/MarkdownText';
import AsciiLoader from '@/components/terminal/AsciiLoader';
import { PlanChip } from '@/components/terminal/PlanChip';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import QueryInput from '@/components/terminal/QueryInput';
import AttentionInbox from '@/components/terminal/AttentionInbox';
import Settings from '@/pages/Settings';
import Integrations from '@/pages/Integrations';
import Usage from '@/pages/Usage';
import UsageDisplay from '@/components/UsageDisplay';
import SubscriptionModal from '@/components/SubscriptionModal';
import CostLimitModal from '@/components/terminal/CostLimitModal';
import NetworkView from '@/components/terminal/NetworkView';
import PhoneAuthModal from '@/components/auth/PhoneAuthModal';
import { useToast } from '@/hooks/use-toast';
import { useAppData, Model } from '@/hooks/useAppData';
import { cn } from '@/lib/utils';
// RealtimeChannel now in AgentContext
import { colorPalette, frameSequence, getTileColorsForFrame } from '@/lib/tileAnimation';
import SmallTileAnimationCanvas from '@/components/terminal/SmallTileAnimationCanvas';
import { QUICK_QUERY_EVENT, type QuickLauncherPayload } from '@/lib/quickQuery';
import { AgentProvider, useAgentContext } from '@/contexts/AgentContext';
import { MessageList } from '@/components/terminal/MessageList';

const BrowserStatusBarCarousel = lazy(() => import('@/components/terminal/BrowserStatusBarCarousel'));

/**
 * StreamingMarkdown - Renders text with fade-in animation for each chunk
 * Each delta fades in like MarkdownText words do
 */
function StreamingMarkdown({ text }: { text: string }) {
  const prevTextRef = useRef('');
  const [chunks, setChunks] = useState<string[]>([]);
  
  useEffect(() => {
    if (text.length > prevTextRef.current.length) {
      // New content arrived - extract the delta
      const delta = text.slice(prevTextRef.current.length);
      setChunks(prev => [...prev, delta]);
      prevTextRef.current = text;
    } else if (text !== prevTextRef.current) {
      // Text changed completely (rare) - reset
      setChunks([text]);
      prevTextRef.current = text;
    }
  }, [text]);
  
  return (
    <span className="text-sm text-muted-foreground">
      {chunks.map((chunk, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
        >
          {chunk}
        </motion.span>
      ))}
    </span>
  );
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
        const isAttention = !!message.metadata?.isUserAttentionMessage;
        toolMessageMap.set(toolCallId, {
          // For attention messages, keep the original message_id so animation ties to first arrival
          message: isAttention
            ? { ...message, message_id: existing.message.message_id }
            : message,
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

// Collapse consecutive "Starting up a browser" messages into a single message with count
// NOTE: This function is kept for potential future use but is currently unused
function collapseBrowserStartupMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let browserStartupGroup: Message[] = [];
  
  const flushGroup = () => {
    if (browserStartupGroup.length === 0) return;
    
    if (browserStartupGroup.length === 1) {
      // Single message, keep as-is
      result.push(browserStartupGroup[0]);
    } else {
      // Multiple messages, collapse into one with count
      const firstMessage = browserStartupGroup[0];
      result.push({
        ...firstMessage,
        metadata: {
          ...firstMessage.metadata,
          title: `Starting up ${browserStartupGroup.length} browsers`,
          _collapsedCount: browserStartupGroup.length,
        },
      });
    }
    browserStartupGroup = [];
  };
  
  for (const message of messages) {
    const isStartingBrowser = 
      message.role === 'TOOL' && 
      message.metadata?.title === 'Starting up a browser';
    
    if (isStartingBrowser) {
      browserStartupGroup.push(message);
    } else {
      // Flush any accumulated browser startup messages before adding this one
      flushGroup();
      result.push(message);
    }
  }
  
  // Flush any remaining browser startup messages at the end
  flushGroup();
  
  return result;
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

// Non-linear mapping functions for increased sensitivity around slider positions 1%, 2%, 28%
// Blur: More precision around slider 1% (maps to ~1px blur)
function mapBlurSlider(slider: number): number {
  // Compress range around 1%: 0-5% slider maps to 0-2px (more precision)
  if (slider <= 5) {
    return (slider / 5) * 2; // 0-5% slider -> 0-2px (1% slider ≈ 0.4px)
  }
  // Rest maps normally: 5-100% slider -> 2-12px
  return 2 + ((slider - 5) / 95) * 10;
}

// Colors: More precision around slider 2% 
function mapColorsSlider(slider: number): number {
  // Compress range around 2%: 0-10% slider maps to 0-5% actual
  if (slider <= 10) {
    return (slider / 10) * 5; // 0-10% slider -> 0-5% (2% slider = 1% actual)
  }
  // Rest maps normally: 10-100% slider -> 5-100%
  return 5 + ((slider - 10) / 90) * 95;
}

// Shadow: More precision around slider 28%
function mapShadowSlider(slider: number): number {
  // Compress range around 28%: 20-40% slider maps to 20-35% actual (more precision)
  if (slider <= 20) {
    return (slider / 20) * 20; // 0-20% slider -> 0-20%
  }
  if (slider <= 40) {
    return 20 + ((slider - 20) / 20) * 15; // 20-40% slider -> 20-35% (28% slider ≈ 26% actual)
  }
  // Rest maps normally: 40-100% slider -> 35-100%
  return 35 + ((slider - 40) / 60) * 65;
}

// Inner component that uses the AgentContext
function TerminalContent({ loadAgentsRef }: { loadAgentsRef?: React.MutableRefObject<(() => void) | null> }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  
  // Auth state from hook - isAuthenticated is TRUE for both JWT users AND anonymous users (Supabase native)
  const { user: authUser, isFullySignedIn, isAuthenticated, isAnonymous, refreshAuthState, loading: authLoading } = useAuth();

  // User is considered "logged in" for Terminal features when fully signed in (non-anonymous)
  // For features like invite codes, we need a non-anonymous user
  const user = isFullySignedIn ? authUser : null;
  // Both JWT and anonymous users can submit goals (anonymous users have real Supabase sessions)
  const canSubmitGoals = isAuthenticated;
  
  // Get context values - agent state comes from context
  const {
    agent: agentDetail,
    setAgent: setAgentDetail,
    selectedAgentId,
    setSelectedAgentId: setSelectedAgentIdContext,
    messages,
    setMessages,
    streamingBubbles: contextStreamingBubbles,
    streamingPlan: contextStreamingPlan,
    streamingAttention: contextStreamingAttention,
    isLoadingAgent,
    forceResubscribe: forceResubscribeContext,
    isChatMode,
  } = useAgentContext();

  // View state - which pane to show
  const [currentView, setCurrentView] = useState<'agents' | 'integrations' | 'settings' | 'usage' | 'network'>('agents');
  

  // Agent list state
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoadingAgents, setIsLoadingAgents] = useState(true);
  const [isFirstLoad, setIsFirstLoad] = useState(true);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [showCreditModal, setShowCreditModal] = useState(false);
  const [showCostLimitModal, setShowCostLimitModal] = useState(false);
  const [pendingPriceLimitCents, setPendingPriceLimitCents] = useState(100); // Default $1.00 for new agents
  const [resumingAgentId, setResumingAgentId] = useState<string | null>(null);
  const clientSource = useMemo(() => getClientSource(), []);
  
  // Pause state
  const [isPausing, setIsPausing] = useState(false);
  
  // Browser fullscreen state
  const [isAnyBrowserFullscreen, setIsAnyBrowserFullscreen] = useState(false);

  // Ancestor chain for breadcrumb navigation
  const [ancestors, setAncestors] = useState<AncestorNode[]>([]);
  
  // Message input state - onboarding prefill takes priority over DEV default
  const [messageInput, setMessageInput] = useState(() => {
    // Check for onboarding prefill first (takes priority)
    const onboardingPrefill = localStorage.getItem('onboarding_prefill_query');
    if (onboardingPrefill) {
      // Clear it after reading so it only applies once
      localStorage.removeItem('onboarding_prefill_query');
      return onboardingPrefill;
    }
    // Fall back to DEV default if no prefill
    return import.meta.env.DEV ? 'go to twitter.com and make a post, Hello World' : '';
  });
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [selectedModel, setSelectedModel] = useState('rose-labs/rose-1-lite');
  
  // Models and tools from cached context
  const { models, modelsLoading } = useAppData();
  
  // Refs (realtime refs removed - now handled by AgentContext)
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const loginButtonRef = useRef<HTMLButtonElement>(null);
  const queryInputRef = useRef<HTMLDivElement>(null);
  const pendingSubmitAfterLoginRef = useRef<boolean>(false);
  const autoSubmitInFlightRef = useRef<boolean>(false);
  const messageInputRef = useRef<string>('');
  
  // Buffer state is now in MessageList, streaming state is in AgentContext
  // These refs are kept for scroll behavior
  const isInitialLoadRef = useRef<boolean>(false);
  
  // Use streaming state from context
  const streamingBubbles = contextStreamingBubbles;
  const streamingPlan = contextStreamingPlan;
  const streamingAttention = contextStreamingAttention;

  // Sync selectedModel when agent detail changes (loaded from context)
  useEffect(() => {
    if (agentDetail?.model) {
      setSelectedModel(agentDetail.model);
      isInitialLoadRef.current = true;
    }
  }, [agentDetail?.model]);

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
    "Maximize my luck surface area",
    "Save children in Gaza",
    "Raise me 1 million dollars",
    "Get me socks",
    "Mitigate the impending climate crisis",
    "Make sure I accomplish my body goals",
    "Ensure my friends are well supported",
    "Get me 5 new friends",
    "End world hunger",
    "Optimize my nutrition",
    "Get me a girlfriend",
    "Make me a master painter",
    "Get me into Stanford",
    "Make sure my birthday is amazing",
    "Find me my first 10 customers",
    "Make sure my startup succeeds",
    "Make me happy",
    "Get me a boyfriend",
    "Cure cancer",
    "Make sure my parents are taken care of",
  ];
  const [tickerOffset, setTickerOffset] = useState(0);
  const tickerRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(Date.now());

  // Separate drippiness controls (0-100, persisted to localStorage)
  const [backgroundColors, setBackgroundColors] = useState(() => {
    const saved = localStorage.getItem('drippiness-bg-colors');
    return saved ? Number(saved) : 3; // Default to 3% (from screenshot)
  });
  const [blur, setBlur] = useState(() => {
    const saved = localStorage.getItem('drippiness-blur');
    return saved ? Number(saved) : 10; // Default to 10% (from screenshot)
  });
  const [shadowIntensity, setShadowIntensity] = useState(() => {
    const saved = localStorage.getItem('drippiness-shadow');
    return saved ? Number(saved) : 16; // Default to 16% (from screenshot)
  });
  const [borderColor, setBorderColor] = useState(() => {
    const saved = localStorage.getItem('drippiness-border');
    return saved ? Number(saved) : 23; // Default to 23% (from screenshot)
  });

  // Persist to localStorage
  useEffect(() => {
    localStorage.setItem('drippiness-bg-colors', backgroundColors.toString());
  }, [backgroundColors]);
  useEffect(() => {
    localStorage.setItem('drippiness-blur', blur.toString());
  }, [blur]);
  useEffect(() => {
    localStorage.setItem('drippiness-shadow', shadowIntensity.toString());
  }, [shadowIntensity]);
  useEffect(() => {
    localStorage.setItem('drippiness-border', borderColor.toString());
  }, [borderColor]);

  // Keep messageInputRef in sync with messageInput for auth callback access
  useEffect(() => {
    messageInputRef.current = messageInput;
  }, [messageInput]);

  // State to trigger auto-submit after login completes
  const [triggerAutoSubmit, setTriggerAutoSubmit] = useState(false);

  // Auto-submit when user becomes fully signed in (if there's a pending goal)
  useEffect(() => {
    if (!isFullySignedIn) {
      autoSubmitInFlightRef.current = false;
      return;
    }
    if (!pendingSubmitAfterLoginRef.current) return;
    if (!messageInputRef.current.trim()) return;
    if (isSendingMessage || autoSubmitInFlightRef.current) return;

    pendingSubmitAfterLoginRef.current = false;
    autoSubmitInFlightRef.current = true;
    console.log('[Auth] Auto-submitting queued goal after login');

    handleSendMessage()
      .catch(error => {
        console.error('[Auth] Auto-submit failed', error);
      })
      .finally(() => {
        autoSubmitInFlightRef.current = false;
      });
  }, [isFullySignedIn, isSendingMessage]);

  // Calculate drip styles from separate controls with non-linear mapping
  const dripStyles = useMemo(() => {
    const bgScalar = mapColorsSlider(backgroundColors) / 100; // 0 to 1 (non-linear)
    const blurPx = mapBlurSlider(blur); // 0px -> 12px (non-linear, more precision around 0-2px)
    const shadowScalar = mapShadowSlider(shadowIntensity) / 100; // 0 to 1 (non-linear, more precision around 20-35%)
    const borderScalar = borderColor / 100; // 0 to 1
    
    // Interpolate border color from white (255,255,255) to dark gray (80,80,80)
    const borderR = Math.round(255 - (borderScalar * 175)); // 255 -> 80
    const borderG = Math.round(255 - (borderScalar * 175)); // 255 -> 80
    const borderB = Math.round(255 - (borderScalar * 175)); // 255 -> 80
    
    return {
      blur: blurPx,
      bgOpacity: 0.6 + (bgScalar * 0.35),     // 0.6 -> 0.95 (more opaque for white marble)
      borderOpacity: 0.4 + (bgScalar * 0.6),  // 0.4 -> 1.0
      shadowIntensity: shadowScalar * 0.25,   // 0 -> 0.25 (softer shadows)
      glow: shadowScalar * 16,                // 0px -> 16px (soft white glow)
      glowOpacity: shadowScalar * 0.08,        // 0 -> 0.08 (very subtle)
      saturation: 1.0 + (bgScalar * 0.3),      // 1.0 -> 1.3 (less saturation, more white)
      brightness: 1.0 + (bgScalar * 0.3),     // 1.0 -> 1.3 (brighter, more ethereal)
      backgroundColorsScalar: bgScalar,
      borderColorScalar: borderScalar,
      borderRgb: `rgba(${borderR}, ${borderG}, ${borderB}, ${0.5 + (borderScalar * 0.5)})`,
    };
  }, [backgroundColors, blur, shadowIntensity, borderColor]);

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

  // Fetch ancestor chain for breadcrumb navigation
  useEffect(() => {
    if (!selectedAgentId) {
      setAncestors([]);
      return;
    }

    fetchAncestors(selectedAgentId)
      .then(setAncestors)
      .catch((err) => {
        console.error('Failed to fetch ancestors:', err);
        setAncestors([]);
      });
  }, [selectedAgentId]);

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

  // Initialize realtime and Amplitude when user is authenticated (JWT or anonymous)
  useEffect(() => {
    if (isAuthenticated && authUser) {
      // Set up realtime connection - works for both anonymous and regular users now
      initializeRealtime();

      // Identify user in Amplitude
      if (authUser.phone) {
        amplitude.setUserId(authUser.phone);
      } else {
        amplitude.setUserId(authUser.id);
      }
    }
  }, [isAuthenticated, authUser]);
  
  // Handle sign out - reset Amplitude
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        amplitude.reset();
      }
    });
    
    return () => subscription.unsubscribe();
  }, []);

  // Load agents on mount (for authenticated users, including anonymous)
  useEffect(() => {
    if (canSubmitGoals) {
      loadAgents();
    }
  }, [canSubmitGoals]);

  // Poll agents every 10 seconds (for authenticated users, including anonymous)
  useEffect(() => {
    if (!canSubmitGoals) return;

    const intervalId = setInterval(() => {
      loadAgents();
    }, 10000); // 10 seconds

    return () => {
      clearInterval(intervalId);
    };
  }, [canSubmitGoals]);

  // Realtime subscription is now handled by AgentContext

  // Derive hasActiveAttentionRequest from messages - when a message has isUserAttentionMessage + IN_PROGRESS
  // Must deduplicate by toolCallId first (keep latest) since FINISHED messages may exist alongside IN_PROGRESS
  const hasActiveAttentionRequest = useMemo(() => {
    // Deduplicate attention messages by toolCallId, keeping the latest one
    const attentionByToolCallId = new Map<string, typeof messages[0]>();
    
    for (const m of messages) {
      if (!m.metadata?.isUserAttentionMessage) continue;
      const toolCallId = m.metadata?.toolCallId;
      if (!toolCallId) continue;
      
      const existing = attentionByToolCallId.get(toolCallId);
      if (!existing || new Date(m.timestamp) > new Date(existing.timestamp)) {
        attentionByToolCallId.set(toolCallId, m);
      }
    }
    
    // Check if any deduplicated attention message is still IN_PROGRESS
    const result = Array.from(attentionByToolCallId.values()).some(
      (m) => m.metadata?.toolStatus === 'IN_PROGRESS'
    );
    
    return result;
  }, [messages]);

  // Debug: Log canSubmit state
  useEffect(() => {
    const canSubmit = !selectedAgentId || hasActiveAttentionRequest || agentDetail?.status === 'PAUSED' || agentDetail?.status === 'COST_LIMIT_REACHED';
    console.log('🎯 canSubmit debug:', {
      selectedAgentId: !!selectedAgentId,
      hasActiveAttentionRequest,
      agentStatus: agentDetail?.status,
      canSubmit,
      showsArrow: canSubmit,
      showsStop: !canSubmit
    });
  }, [selectedAgentId, hasActiveAttentionRequest, agentDetail?.status]);

  // Handle tab visibility changes - reconnect when tab becomes visible
  // Now uses context's forceResubscribe function
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && selectedAgentId) {
        console.log('👀 Tab became visible, ensuring fresh connection...');
        setTimeout(() => {
          if (selectedAgentId) {
            console.log('🔄 Forcing reconnection after tab visibility change');
            forceResubscribeContext();
          }
        }, 1000);
      } else if (document.hidden) {
        console.log('😴 Tab hidden - connection may be suspended by browser');
      }
    };

    const handleFocus = () => {
      if (selectedAgentId) {
        console.log('🎯 Window focused, ensuring connection is alive...');
        setTimeout(() => {
          if (selectedAgentId) {
            forceResubscribeContext();
          }
        }, 500);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [selectedAgentId, forceResubscribeContext]);

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
      
      // Browser task is active if it exists and is not completed (errors don't end task)
      const isComplete = actionType === 'task_complete';
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

  // Animation handling and buffer processing is now in MessageList
  // Thinking indicator is now in MessageList
  // Streaming state clearing on pause is now in AgentContext

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

  // Helper to refresh agent details (for resume/pause where we need fresh data)
  const refreshAgentDetail = useCallback(async (agentId: string) => {
    try {
      const data = await getAgent(agentId);
      setAgentDetail(data.agent);
      setMessages(data.messages);
      setSelectedModel(data.agent.model);
    } catch (error) {
      console.error('Failed to refresh agent details:', error);
    }
  }, [setAgentDetail, setMessages]);

  // Cleanup agent-specific state - websocket cleanup is now in AgentContext
  const cleanupAgentState = useCallback(() => {
    // Clear agent selection via context (this also clears messages and streaming state)
    setSelectedAgentIdContext(null);
    
    // Clear local UI state
    isInitialLoadRef.current = false;
    setIsSendingMessage(false);
    setMessageInput('');
  }, [setSelectedAgentIdContext]);

  // Reset landing page animation state
  const resetAnimationState = useCallback(() => {
    setCurrentFrame(0);
    setAnimationComplete(false);
    setAnimationResetKey(prev => prev + 1);
    setCurrentMessageIndex(0);
    setAnimationPhase('revealing');
    setRevealProgress(0);
    setIsTypingComplete(false);
    setIsLoadingNetwork(false);
  }, []);

  const handleSelectAgent = (agentId: string | null) => {
    // Only switch to agents view if selecting an actual agent
    if (agentId) {
      setCurrentView('agents');
      // Context handles loading agent detail and messages
      setSelectedAgentIdContext(agentId);
    } else {
      // Just clear the selection without changing view
      setSelectedAgentIdContext(null);
    }
  };

  const handleSubmitFeedback = useCallback(async (feedback: BlueprintFeedback) => {
    if (!agentDetail) return;

    try {
      // Find the blueprint for this goal
      const blueprint = await findBlueprintByGoal(agentDetail.goal);

      if (blueprint) {
        await submitBlueprintFeedback(blueprint.id, {
          ...feedback,
          agentId: agentDetail.agent_id,
        });
      } else {
        console.warn('No blueprint found for feedback');
      }
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      throw error;
    }
  }, [agentDetail]);

  const handleCreateAgent = async (data: CreateAgentPayload) => {
    const newAgent = await createAgentAPI({ ...data, source: clientSource });
    await loadAgents();
    setCurrentView('agents');
    // Context handles loading agent detail and messages
    setSelectedAgentIdContext(newAgent.agent_id);
  };

  const handleResumeAgent = async (agentId: string) => {
    try {
      setResumingAgentId(agentId);
      await resumeAgent(agentId);
      
      // If this is the currently selected agent, reload its details
      if (agentId === selectedAgentId) {
        await refreshAgentDetail(agentId);
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

  const handlePauseAgent = async () => {
    if (!selectedAgentId || !agentDetail) return;
    
    try {
      setIsPausing(true);
      await pauseAgent(selectedAgentId);
      
      // Reload agent details to get updated status
      await refreshAgentDetail(selectedAgentId);
      
      toast({
        title: 'Agent pausing',
        description: 'The agent will pause shortly',
      });
    } catch (error) {
      toast({
        title: 'Error',
        description: 'Failed to pause agent',
        variant: 'destructive',
      });
    } finally {
      setIsPausing(false);
    }
  };

  const handleSendMessage = async (attachments?: FilePointer[]) => {
    if (!messageInput.trim() && (!attachments || attachments.length === 0)) return;

    // Track goal submitted event (fires once on submit, regardless of login status)
    if (!selectedAgentId) {
      amplitude.track('goal_submitted', {
        goal: messageInput,
        model: selectedModel,
        has_attachments: attachments && attachments.length > 0,
      });
    }

    // Check if user can submit goals (authenticated via JWT or anonymous token)
    if (!canSubmitGoals) {
      console.log('User not authenticated, opening login modal');
      pendingSubmitAfterLoginRef.current = true; // Flag to auto-submit after login
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

        // Verifier is now auto-generated by backend from goal
        // Pass attachments directly to createAgent - they'll be included in the initial goal message
        const newAgent = await createAgentAPI({
          goal: messageInput,
          model: selectedModel,
          source: clientSource,
          attachments: attachments && attachments.length > 0 ? attachments : undefined,
          price_limit_cents: pendingPriceLimitCents,
        });

        await loadAgents();
        setCurrentView('agents');
        setSelectedAgentIdContext(newAgent.agent_id);

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

      // If agent is paused, resume it first
      if (agentDetail?.status === 'PAUSED') {
        await resumeAgent(selectedAgentId);
        toast({
          title: 'Agent resuming',
          description: 'The agent will continue with your message',
        });
      }

      // Normal message flow (with optional attachments)
      await postMessageAPI(selectedAgentId, messageInput, attachments);
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
      console.log('[Auth] Logout requested');
      await signOut();
      console.log('[Auth] Supabase signOut complete, clearing local session cache');
      clearStoredSession();
      await refreshAuthState('logout');
      console.log('[Auth] refreshAuthState finished after logout');
      // Clear all local state (user state is handled by useAuth hook)
      setAgents([]);
      setSelectedAgentIdContext(null); // This also clears messages and agent detail
      setMessageInput('');
      setCurrentView('agents');
      
      // Reset Amplitude user identity on logout
      amplitude.reset();
      console.log('[Auth] Logout flow completed');
    } catch (error) {
      console.error('[Auth] Logout failed', error);
      toast({
        title: 'Error',
        description: 'Failed to log out',
        variant: 'destructive',
      });
    }
  };

  const handleLoginClick = () => {
    setLoginModalOpen(true);
  };

  const handleCreateNewAgent = () => {
    cleanupAgentState();
    resetAnimationState();
    setCurrentView('agents');
  };

  // Handle quick query from launcher (Electron app)
  const handleQuickQuery = useCallback(async (payload: QuickLauncherPayload) => {
    const trimmed = payload.query?.trim();
    if (!trimmed) return;

    // Switch to agents view
    setCurrentView('agents');
    
    // Set the input temporarily (for display purposes)
    setMessageInput(trimmed);
    
    // Track goal submitted event (fires once on submit, regardless of login status)
    if (!selectedAgentId) {
      amplitude.track('goal_submitted', {
        goal: trimmed,
        model: selectedModel,
        source: 'quick_launcher',
      });
    }
    
    // Submit the query immediately by calling handleSendMessage
    // But we need to use the trimmed value directly since state updates are async
    if (!canSubmitGoals) {
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

        // Verifier is now auto-generated by backend from goal
        const newAgent = await createAgentAPI({
          goal: trimmed,
          model: selectedModel,
          source: clientSource,
          price_limit_cents: pendingPriceLimitCents,
        });
        
        await loadAgents();
        setCurrentView('agents');
        setSelectedAgentIdContext(newAgent.agent_id);
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
        trimmed
      );
      
      if (respondedToRequest) {
        toast({
          description: 'Responded to attention request',
        });
      } else {
        // Regular message sending
        await postMessageAPI(selectedAgentId, trimmed);
      }
      
      setMessageInput(''); // Clear input after successful send
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to send message',
        variant: 'destructive',
      });
    } finally {
      setIsSendingMessage(false);
    }
  }, [user, selectedAgentId, selectedModel, toast, loadAgents, setSelectedAgentIdContext]);

  // Listen for quick query events (from Electron launcher)
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<QuickLauncherPayload>).detail;
      if (!detail) return;
      handleQuickQuery(detail);
    };

    window.addEventListener(QUICK_QUERY_EVENT, handler as EventListener);

    return () => {
      window.removeEventListener(QUICK_QUERY_EVENT, handler as EventListener);
    };
  }, [handleQuickQuery]);

  const sortedAgents = [...agents].sort((a, b) => {
    // Completed agents go to the bottom
    if (a.status === 'COMPLETED' && b.status !== 'COMPLETED') return 1;
    if (a.status !== 'COMPLETED' && b.status === 'COMPLETED') return -1;
    // Paused/Out of credits/Cost limit agents go to the bottom (but above completed)
    const pausedStatuses = ['PAUSED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'];
    const aIsPaused = pausedStatuses.includes(a.status);
    const bIsPaused = pausedStatuses.includes(b.status);
    if (aIsPaused && !bIsPaused) return 1;
    if (!aIsPaused && bIsPaused) return -1;
    // Otherwise sort by progress (descending)
    return b.progress - a.progress;
  });

  // Memoize browser panels for the status bar carousel
  // MessageList handles action rendering via subAgentId, we just need taskId and browserUrl
  const activeBrowserPanels = useMemo(() => {
    type BrowserPanelData = {
      taskId: string;
      browserUrl: string;
    };
    
    const panels: BrowserPanelData[] = [];
    const browserTaskIds = new Set<string>();
    
    // Find all unique browser task IDs
    messages.forEach(m => {
      const taskId = m.metadata?.task_id;
      if (taskId && m.metadata?.toolName === 'spawn_browser_agent') {
        browserTaskIds.add(taskId);
      }
    });
    
    // For each task, check completion status
    browserTaskIds.forEach(taskId => {
      const taskMessages = messages.filter(m => m.metadata?.task_id === taskId);
      // Init message can be 'browser' (new) or 'system' (legacy)
      const initMessage = taskMessages.find(m => 
        m.metadata?.action_type === 'browser' || m.metadata?.action_type === 'system'
      );
      const lastMessage = taskMessages[taskMessages.length - 1];
      
      const isComplete = lastMessage?.metadata?.action_type === 'task_complete';
      
      // Log errors but don't hide chip
      if (lastMessage?.metadata?.action_type === 'error') {
        console.log('🖥️ [Browser] Action error (chip stays visible):', {
          taskId: taskId.slice(-8),
          error: lastMessage?.text?.slice(0, 100),
        });
      }
      
      // Debug: log task completion
      if (isComplete) {
        console.log('🖥️ [Browser] Task completed:', {
          taskId: taskId.slice(-8),
          message: lastMessage?.text?.slice(0, 100),
        });
      }
      
      // Only include active (non-complete) browser panels
      if (!isComplete && initMessage) {
        panels.push({
            taskId,
          browserUrl: initMessage.metadata?.browser_url || '',
          });
        }
    });

    return panels;
  }, [messages]);

  // Stable props for BrowserStatusBar to avoid unnecessary re-renders
  const browserStatusProps = useMemo(() => {
    if (activeBrowserPanels.length === 0) return null;
    return {
      browsers: activeBrowserPanels,
    };
  }, [activeBrowserPanels]);

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
    <div className="h-screen w-screen flex flex-col bg-background dark:bg-navi-black relative overflow-hidden" style={{ height: '100dvh' }}>
      {/* Background Pattern - z-[3] renders tile borders above animation canvases (z-[2]) */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none z-[3]" xmlns="http://www.w3.org/2000/svg" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
        <defs>
          {/* Rose gradient for top corners */}
          <linearGradient id="rose-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
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
        <path d="M 0.5,-12 L 0.5,-6 C 0.5,-4 2,-2 4,-1 L 6,-0.5 L 12,-0.5 L 12,0.5 L 6,0.5 L 4,1 C 2,2 0.5,4 0.5,6 L 0.5,12 L -0.5,12 L -0.5,6 C -0.5,4 -2,2 -4,1 L -6,0.5 L -12,0.5 L -12,-0.5 L -6,-0.5 L -4,-1 C -2,-2 -0.5,-4 -0.5,-6 L -0.5,-12 Z" fill="url(#rose-gradient)" style={{ transform: 'translate(calc(50% - 214.5px), calc(40% - 214.5px))' }} />

        {/* Top-right corner with circle and perfectly smooth geometric diamond shape */}
        <circle cx="0" cy="0" r="25" fill="none" stroke="rgb(229, 231, 235)" strokeWidth="1" className="dark:stroke-gray-800" style={{ transform: 'translate(calc(50% + 214.5px), calc(40% - 214.5px))' }} />
        <path d="M 0.5,-12 L 0.5,-6 C 0.5,-4 2,-2 4,-1 L 6,-0.5 L 12,-0.5 L 12,0.5 L 6,0.5 L 4,1 C 2,2 0.5,4 0.5,6 L 0.5,12 L -0.5,12 L -0.5,6 C -0.5,4 -2,2 -4,1 L -6,0.5 L -12,0.5 L -12,-0.5 L -6,-0.5 L -4,-1 C -2,-2 -0.5,-4 -0.5,-6 L -0.5,-12 Z" fill="url(#rose-gradient)" style={{ transform: 'translate(calc(50% + 214.5px), calc(40% - 214.5px))' }} />
        
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
          backdropFilter: blur > 0 ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : undefined,
          WebkitBackdropFilter: blur > 0 ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : undefined,
          backgroundColor: backgroundColors > 0 ? `rgba(255, 255, 255, ${dripStyles.bgOpacity})` : undefined,
          borderColor: borderColor > 0 ? dripStyles.borderRgb : undefined,
          boxShadow: shadowIntensity > 0 
            ? `0 8px 32px rgba(0, 0, 0, ${dripStyles.shadowIntensity}), 0 0 ${dripStyles.glow}px rgba(126, 87, 194, ${dripStyles.glowOpacity}), inset 0 1px 1px rgba(255,255,255,${dripStyles.bgOpacity * 0.5})`
            : undefined,
        }}
      >
        {/* Marble gradient background - soft white with pastel hints */}
        {backgroundColors > 0 && (
          <div 
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `radial-gradient(circle at 10% 20%, rgba(255, 248, 245, ${0.7 * dripStyles.backgroundColorsScalar}) 0%, transparent 40%), 
                           radial-gradient(circle at 90% 80%, rgba(248, 245, 255, ${0.6 * dripStyles.backgroundColorsScalar}) 0%, transparent 40%),
                           radial-gradient(circle at 50% 50%, rgba(255, 252, 255, ${0.5 * dripStyles.backgroundColorsScalar}) 0%, transparent 60%)`,
              opacity: 0.3 + dripStyles.backgroundColorsScalar * 0.5,
              zIndex: -1,
            }}
          />
        )}
        <div className="flex items-center space-x-1">
          <button
            type="button"
            onClick={handleCreateNewAgent}
            className="flex items-center space-x-2.5 px-1 cursor-pointer hover:opacity-80 transition-opacity"
          >
            <div className="w-8 h-8 rounded-lg" style={{ background: 'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)' }}></div>
            <span className="text-base font-semibold tracking-tight">Rose</span>
          </button>
        </div>
        
        {/* Research Button - Absolutely centered in viewport */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            console.log('Research button clicked');
          }}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm text-muted-foreground hover:text-foreground transition-colors z-10"
        >
          Research
        </button>
        
        {/* Attention Inbox */}
        <AttentionInbox onSelectAgent={setSelectedAgentIdContext} />
      </header>


      <div className="h-screen flex z-[4]" style={{ height: '100dvh' }}>
        {/* Left Sidebar - Always visible */}
        <AppSidebar
          currentView={currentView}
          onViewChange={setCurrentView}
          agents={agents}
          isLoadingAgents={isLoadingAgents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
          onCreateAgent={handleCreateNewAgent}
          onResumeAgent={handleResumeAgent}
          resumingAgentId={resumingAgentId}
          user={user}
          onLogout={handleLogout}
          onLoginClick={handleLoginClick}
          dripStyles={dripStyles}
          blur={blur}
          backgroundColors={backgroundColors}
          borderColor={borderColor}
          shadowIntensity={shadowIntensity}
        />

        {/* Main Content - Centered */}
        <main className="flex-1 flex justify-center h-screen overflow-hidden" style={{ height: '100dvh' }}>
          <div className="flex flex-col relative max-w-5xl w-full px-2 md:px-6 h-full overflow-hidden">
          {/* Breadcrumb for sub-agents - Below Header */}
          {selectedAgentId && agentDetail?.parent_agent_id && (
            <div className="absolute top-20 left-0 right-0 z-40 px-6">
              <div className="max-w-4xl mx-auto">
                <div
                  className="inline-flex px-4 py-2 rounded-lg text-sm items-center gap-1 border border-gray-200/50 dark:border-gray-700/50 bg-white/80 dark:bg-gray-800/80 shadow-lg overflow-x-auto max-w-full"
                  style={{
                    backdropFilter: blur > 0 ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : undefined,
                    WebkitBackdropFilter: blur > 0 ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : undefined,
                  }}
                >
                  {/* Ancestor chain (root → ... → parent) */}
                  {ancestors.map((ancestor) => (
                    <span key={ancestor.id} className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleSelectAgent(ancestor.id)}
                        className="truncate max-w-[150px] text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
                      >
                        {ancestor.goal}
                      </button>
                      <span className="text-gray-400 dark:text-gray-500">›</span>
                    </span>
                  ))}
                  {/* Current agent */}
                  <span className="font-medium truncate max-w-[200px] text-gray-800 dark:text-gray-200 flex-shrink-0">
                    {agentDetail.goal}
                  </span>
                </div>
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
            <ScrollArea className="flex-1 h-full">
              <div className="pt-24 pb-8">
                <Settings />
              </div>
            </ScrollArea>
          ) : currentView === 'integrations' ? (
            <ScrollArea className="flex-1 h-full">
              <div className="pt-24 pb-8">
                <Integrations />
              </div>
            </ScrollArea>
          ) : currentView === 'usage' ? (
            <ScrollArea className="flex-1 h-full">
              <div className="pt-24 pb-8">
                <Usage />
              </div>
            </ScrollArea>
          ) : currentView === 'network' ? (
            <ScrollArea className="flex-1 h-full">
              <div className="pt-24 pb-8">
                <NetworkView />
              </div>
            </ScrollArea>
          ) : (
            <>
            <ScrollArea 
              className="flex-1 px-2 md:px-6 relative" 
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
                  backdropFilter: selectedAgentId && blur > 0 
                    ? `blur(${dripStyles.blur + 8}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
                    : undefined,
                  WebkitBackdropFilter: selectedAgentId && blur > 0 
                    ? `blur(${dripStyles.blur + 8}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})`
                    : undefined,
                  maskImage: 'linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%)',
                  WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 15%, black 85%, transparent 100%)',
                  zIndex: 15,
                  transition: 'backdrop-filter 1.8s ease-in-out, -webkit-backdrop-filter 1.8s ease-in-out',
                }}
              />
              
              {/* Top padding to clear header */}
              <div className="h-24" />
              
              {/* Spacer for breadcrumb when viewing sub-agent */}
              {selectedAgentId && agentDetail?.parent_agent_id && (
                <div className="h-14" />
              )}
              
              {/* ASCII Loader - Always visible, transitions to background when messages appear */}
              <div 
                className="absolute inset-0 flex items-center justify-center pointer-events-none transition-all duration-700 ease-in-out"
                style={{
                  opacity: (!selectedAgentId || messages.length === 0) ? 1 : 0.2,
                  transform: (!selectedAgentId || messages.length === 0) ? 'translateY(0)' : 'translateY(8px)',
                  zIndex: 18,
                  height: '100dvh',
                }}
              >
                <div className="text-center space-y-6" style={{ marginBottom: '20vh' }}>
                  <AsciiLoader showWarmingUp={false} size="large" variant="engine" />
                  {(!selectedAgentId || messages.length === 0) && (
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
              
              {/* Messages - Using MessageList component */}
              <div
                className="transition-opacity duration-700 ease-in-out relative"
                style={{
                  opacity: messages.length > 0 ? 1 : 0,
                  zIndex: 20, // Above blur overlay (15) and ASCII loader (18)
                }}
              >
                <MessageList
                  onAddCredits={() => setShowCreditModal(true)}
                  onIncreaseCostLimit={() => setShowCostLimitModal(true)}
                  onNavigateToAgent={handleSelectAgent}
                  onSubmitFeedback={handleSubmitFeedback}
                />
                <div ref={messagesEndRef} />
              </div>

          </ScrollArea>

          {/* Browser Status Bar - fixed section above query input */}
          {browserStatusProps && (
            <Suspense fallback={null}>
              <div className="px-2 md:px-0">
                <BrowserStatusBarCarousel
                  browsers={browserStatusProps.browsers}
                />
              </div>
            </Suspense>
          )}

          {/* Message Input - Always visible */}
          <div 
            ref={queryInputRef}
            className="pb-6 transition-opacity duration-300 ease-in-out relative"
            style={{
              // Only fade for FAILED status, not COMPLETED (since we show a prominent button)
              opacity: agentDetail && agentDetail.status === 'FAILED' ? 0.8 : 1
            }}
          >
            {/* Popular Goals Carousel - Only visible when no agent selected */}
            {!selectedAgentId && (
              <div className="mb-4 relative z-10">
                <div className="flex items-center gap-3">
                  <span className="hidden md:block text-sm text-muted-foreground whitespace-nowrap flex-shrink-0">Popular Goals</span>
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
                            amplitude.track('goal_typed');
                            amplitude.track('popular_goal_clicked', { goal });
                            setMessageInput(goal);
                          }}
                          className="px-3 py-1 text-xs bg-secondary hover:bg-secondary/80 rounded-full whitespace-nowrap flex-shrink-0 border"
                          style={{
                            borderColor: borderColor > 0 ? dripStyles.borderRgb : undefined,
                          }}
                        >
                          {goal}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="relative z-10">
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
              dripStyles={dripStyles}
              drippiness={blur}
              agentDetail={agentDetail}
              onAgentUpdate={() => selectedAgentId && refreshAgentDetail(selectedAgentId)}
              onAgentDelete={() => {
                cleanupAgentState();
                resetAnimationState();
                setCurrentView('agents');
                loadAgents();
              }}
              canSubmit={!selectedAgentId || hasActiveAttentionRequest || agentDetail?.status === 'PAUSED' || agentDetail?.status === 'COMPLETED' || agentDetail?.status === 'COST_LIMIT_REACHED' || isChatMode}
              onPause={handlePauseAgent}
              isPausing={isPausing}
              agentId={selectedAgentId || undefined}
              pendingPriceLimitCents={pendingPriceLimitCents}
              onPendingPriceLimitChange={setPendingPriceLimitCents}
            />
            </div>
          </div>
          </>
          )}
          </div>
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
        onAuthComplete={refreshAuthState}
        anonymousUserId={isAnonymous ? authUser?.id : undefined}
      />

      {/* Credit/Subscription Modal for OUT_OF_CREDITS */}
      <SubscriptionModal
        open={showCreditModal}
        onOpenChange={setShowCreditModal}
        currentTier={null}
        upgradeOptions={[]}
        remaining={0}
      />

      {/* Cost Limit Modal for COST_LIMIT_REACHED */}
      <CostLimitModal
        open={showCostLimitModal}
        onOpenChange={setShowCostLimitModal}
        agentId={agentDetail?.agent_id || ''}
        currentLimitCents={agentDetail?.price_limit_cents || 100}
        currentCostCents={agentDetail?.tree_cost_cents || 0}
        onIncrease={() => selectedAgentId && refreshAgentDetail(selectedAgentId)}
        onDelete={() => {
          cleanupAgentState();
          resetAnimationState();
          setCurrentView('agents');
          loadAgents();
        }}
      />
    </div>
  );
}

// Main Terminal component - wraps content in AgentProvider
export default function Terminal() {
  const { user: authUser, isFullySignedIn, isAuthenticated } = useAuth();
  const user = isFullySignedIn ? authUser : null;

  // loadAgents callback will be set by TerminalContent via ref
  const loadAgentsRef = useRef<(() => void) | null>(null);

  return (
    <AgentProvider
      user={user}
      isAuthenticated={isAuthenticated}
      onLoadAgents={() => loadAgentsRef.current?.()}
    >
      <TerminalContentWithRef loadAgentsRef={loadAgentsRef} />
    </AgentProvider>
  );
}

// Helper to pass ref into TerminalContent
function TerminalContentWithRef({ loadAgentsRef }: { loadAgentsRef: React.MutableRefObject<(() => void) | null> }) {
  return <TerminalContent loadAgentsRef={loadAgentsRef} />;
}

