import { useState, useEffect, useRef } from 'react';
import { Plus, LogOut, Settings as SettingsIcon, BarChart3, Plug, Network, ChevronLeft, ChevronRight, Loader2, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import AgentListItem from './AgentListItem';
import { Agent } from '@/lib/api';
import { getStoredSession } from '@/lib/supabase';
import SubscriptionModal from '@/components/SubscriptionModal';

// Sidebar dimensions
const SIDEBAR_WIDTH_EXPANDED = 256; // 16rem = 256px
const SIDEBAR_WIDTH_COLLAPSED = 64; // ~4rem for icons

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  isActive?: boolean;
}

interface AppSidebarProps {
  // View state
  currentView: 'agents' | 'integrations' | 'settings' | 'usage' | 'network';
  onViewChange: (view: 'agents' | 'integrations' | 'settings' | 'usage' | 'network') => void;
  
  // Agent state
  agents: Agent[];
  isLoadingAgents: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onCreateAgent: () => void;
  onResumeAgent: (agentId: string) => Promise<void>;
  resumingAgentId: string | null;
  
  // Auth state
  user: any;
  onLogout: () => void;
  onLoginClick: () => void;
  
  // Styling (optional drip styles)
  dripStyles?: {
    blur: number;
    bgOpacity: number;
    saturation: number;
    brightness: number;
    borderRgb: string;
    shadowIntensity: number;
  };
  blur?: number;
  backgroundColors?: number;
  borderColor?: number;
  shadowIntensity?: number;
}

// Sort agents - status priority: processing first, then by recency
function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    // Processing agents go first
    const aProcessing = a.status !== 'COMPLETED' && a.status !== 'FAILED';
    const bProcessing = b.status !== 'COMPLETED' && b.status !== 'FAILED';
    
    if (aProcessing && !bProcessing) return -1;
    if (!aProcessing && bProcessing) return 1;
    
    // Then sort by most recent
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

// Tooltip component for collapsed state
function SidebarTooltip({ 
  children, 
  label, 
  isCollapsed 
}: { 
  children: React.ReactNode; 
  label: string; 
  isCollapsed: boolean;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [position, setPosition] = useState({ top: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isHovered && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPosition({ top: rect.top + rect.height / 2 });
    }
  }, [isHovered]);

  return (
    <div 
      ref={triggerRef}
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}
      
      {/* Tooltip chip - only show when collapsed and hovered */}
      {isCollapsed && isHovered && (
        <div 
          className="fixed z-[100] ml-2 pointer-events-none"
          style={{ 
            left: SIDEBAR_WIDTH_COLLAPSED,
            top: position.top,
            transform: 'translateY(-50%)',
          }}
        >
          <div className="px-3 py-1.5 rounded-md bg-white dark:bg-zinc-800 shadow-lg border border-gray-200 dark:border-zinc-700 text-sm font-medium whitespace-nowrap animate-in fade-in-0 slide-in-from-left-2 duration-150">
            {label}
          </div>
        </div>
      )}
    </div>
  );
}

// Navigation button component
function NavButton({ 
  icon, 
  label, 
  isActive, 
  onClick, 
  isCollapsed 
}: { 
  icon: React.ReactNode; 
  label: string; 
  isActive?: boolean;
  onClick: () => void;
  isCollapsed: boolean;
}) {
  return (
    <SidebarTooltip label={label} isCollapsed={isCollapsed}>
      <button
        onClick={onClick}
        className={cn(
          "w-full flex items-center gap-3 rounded-lg text-sm transition-all duration-200",
          "hover:bg-gray-100 dark:hover:bg-zinc-800",
          isActive && "bg-gray-100 dark:bg-zinc-800 font-medium",
          isCollapsed ? "justify-center p-2.5 mx-auto" : "px-3 py-2.5"
        )}
      >
        <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center">
          {icon}
        </span>
        {!isCollapsed && (
          <span className="truncate">
            {label}
          </span>
        )}
      </button>
    </SidebarTooltip>
  );
}

// Usage data interface for credits
interface UsageData {
  total: number;
  used: number;
  remaining: number;
  tier: number | null;
  upgradeOptions: Array<{
    tier: number;
    name: string;
    url: string;
  }>;
}

// Credit indicator component with ring
function CreditIndicator({ isCollapsed }: { isCollapsed: boolean }) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);

  useEffect(() => {
    const fetchCredits = async () => {
      try {
        const session = getStoredSession();
        if (!session) {
          setLoading(false);
          return;
        }

        const response = await fetch(
          `${(import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '')}/api/credits/usage`,
          {
            headers: {
              'Authorization': `Bearer ${session.access_token}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (response.ok) {
          const data = await response.json();
          setUsage(data);
        }
      } catch (error) {
        console.error('Error fetching credits:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchCredits();
    const interval = setInterval(fetchCredits, 30000);
    return () => clearInterval(interval);
  }, []);

  const credits = usage ? Math.floor(usage.remaining) : 0;
  
  // Calculate percentage: 10+ = 100%, 5 = 50%, 0 = 0%
  const percentage = loading ? 50 : Math.min(100, (credits / 10) * 100);
  const isEmpty = credits === 0 && !loading;
  
  // Ring properties
  const size = isCollapsed ? 40 : 32;
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;
  
  // Color based on credits
  const getColor = () => {
    if (isEmpty) return '#ef4444'; // red-500
    if (credits <= 2) return '#f97316'; // orange-500
    if (credits <= 5) return '#eab308'; // yellow-500
    return '#22c55e'; // green-500
  };

  return (
    <>
      <SidebarTooltip label={`${credits} credits remaining`} isCollapsed={isCollapsed}>
        <div 
          onClick={() => setShowSubscriptionModal(true)}
          className={cn(
            "flex items-center gap-2 rounded-lg transition-all duration-200 cursor-pointer",
            "hover:bg-gray-100 dark:hover:bg-zinc-800",
            isCollapsed ? "justify-center p-2 mx-auto" : "px-3 py-2"
          )}
        >
          <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
            {/* Background ring */}
            <svg className="absolute" width={size} height={size}>
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                className="text-gray-200 dark:text-zinc-700"
              />
            </svg>
            {/* Progress ring */}
            <svg 
              className="absolute -rotate-90" 
              width={size} 
              height={size}
            >
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={getColor()}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                className="transition-all duration-500"
              />
            </svg>
            {/* Credit card icon */}
            <CreditCard 
              className={cn(
                "relative z-10",
                isEmpty ? "text-red-500" : "text-gray-600 dark:text-gray-400"
              )} 
              style={{ width: size * 0.45, height: size * 0.45 }}
            />
          </div>
          {!isCollapsed && (
            <div className="flex flex-col">
              <span className={cn(
                "text-sm font-medium",
                isEmpty ? "text-red-500" : "text-gray-700 dark:text-gray-300"
              )}>
                {loading ? '...' : credits}
              </span>
              <span className="text-xs text-gray-500 dark:text-gray-500">credits</span>
            </div>
          )}
        </div>
      </SidebarTooltip>

      <SubscriptionModal
        open={showSubscriptionModal}
        onOpenChange={setShowSubscriptionModal}
        currentTier={usage?.tier ?? null}
        upgradeOptions={usage?.upgradeOptions ?? []}
        remaining={usage?.remaining ?? 0}
      />
    </>
  );
}

export default function AppSidebar({
  currentView,
  onViewChange,
  agents,
  isLoadingAgents,
  selectedAgentId,
  onSelectAgent,
  onCreateAgent,
  onResumeAgent,
  resumingAgentId,
  user,
  onLogout,
  onLoginClick,
  dripStyles,
  blur = 0,
  backgroundColors = 0,
  borderColor = 0,
  shadowIntensity = 0,
}: AppSidebarProps) {
  // Start collapsed by default
  const [isCollapsed, setIsCollapsed] = useState(true);

  const sortedAgents = sortAgents(agents);

  const currentWidth = isCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  // Navigation items for bottom section
  const navItems: NavItem[] = [
    {
      id: 'integrations',
      label: 'Integrations',
      icon: <Plug className="h-4 w-4" />,
      onClick: () => {
        onViewChange('integrations');
        onSelectAgent(null);
      },
      isActive: currentView === 'integrations',
    },
    {
      id: 'network',
      label: 'Network',
      icon: <Network className="h-4 w-4" />,
      onClick: () => {
        onViewChange('network');
        onSelectAgent(null);
      },
      isActive: currentView === 'network',
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: <SettingsIcon className="h-4 w-4" />,
      onClick: () => {
        onViewChange('settings');
        onSelectAgent(null);
      },
      isActive: currentView === 'settings',
    },
    {
      id: 'usage',
      label: 'Usage',
      icon: <BarChart3 className="h-4 w-4" />,
      onClick: () => {
        onViewChange('usage');
        onSelectAgent(null);
      },
      isActive: currentView === 'usage',
    },
  ];

  return (
    <aside 
      className={cn(
        "group/sidebar fixed top-0 left-0 h-full hidden md:flex flex-col border-r border-gray-200/60 dark:border-zinc-800/60 bg-white/95 dark:bg-zinc-900/95 z-[50]",
        "transition-all duration-300 ease-out shadow-xl"
      )}
      style={{
        width: currentWidth,
        backdropFilter: blur > 0 && dripStyles ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : 'blur(16px)',
        WebkitBackdropFilter: blur > 0 && dripStyles ? `blur(${dripStyles.blur}px) saturate(${dripStyles.saturation}) brightness(${dripStyles.brightness})` : 'blur(16px)',
        backgroundColor: backgroundColors > 0 && dripStyles ? `rgba(255, 255, 255, ${dripStyles.bgOpacity * 0.95})` : undefined,
        borderColor: borderColor > 0 && dripStyles ? dripStyles.borderRgb : undefined,
      }}
    >
      {/* Toggle Button - positioned on the right edge */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className={cn(
          "absolute top-1/2 -translate-y-1/2 z-20",
          "w-6 h-6 rounded-full bg-white dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700",
          "flex items-center justify-center shadow-md",
          "hover:bg-gray-100 dark:hover:bg-zinc-700 transition-all duration-200"
        )}
        style={{
          right: -12,
        }}
        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
        ) : (
          <ChevronLeft className="h-3.5 w-3.5 text-gray-600 dark:text-gray-400" />
        )}
      </button>

      {/* Create Agent Button */}
      <div className="p-3">
        <SidebarTooltip label="Create Agent" isCollapsed={isCollapsed}>
          <Button
            onClick={onCreateAgent}
            className={cn(
              "w-full transition-all duration-200",
              isCollapsed && "px-2"
            )}
            size={isCollapsed ? "icon" : "default"}
          >
            <Plus className={cn("h-4 w-4", !isCollapsed && "mr-2")} />
            <span className={cn(
              "transition-all duration-200",
              isCollapsed ? "w-0 opacity-0 hidden" : "w-auto opacity-100"
            )}>
              Create Agent
            </span>
          </Button>
        </SidebarTooltip>
      </div>

      {/* Agent List */}
      <ScrollArea className="flex-1">
        <div className={cn("py-2 space-y-1", isCollapsed ? "px-1.5" : "px-3")}>
          {isLoadingAgents && agents.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : sortedAgents.length === 0 ? (
            !isCollapsed && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No agents yet
              </div>
            )
          ) : (
            sortedAgents.map((agent) => (
              <SidebarTooltip 
                key={agent.agent_id} 
                label={agent.goal.slice(0, 50) + (agent.goal.length > 50 ? '...' : '')} 
                isCollapsed={isCollapsed}
              >
                <AgentListItem
                  agent={agent}
                  isSelected={selectedAgentId === agent.agent_id}
                  onClick={() => onSelectAgent(agent.agent_id)}
                  onResume={onResumeAgent}
                  isResuming={resumingAgentId === agent.agent_id}
                  isCompact={isCollapsed}
                />
              </SidebarTooltip>
            ))
          )}
        </div>
      </ScrollArea>

      {/* Credit Indicator */}
      <div className="border-t border-gray-200/60 dark:border-zinc-800/60">
        <div className={cn("px-2 py-2", isCollapsed && "px-1.5")}>
          <CreditIndicator isCollapsed={isCollapsed} />
        </div>
      </div>

      {/* Bottom Navigation */}
      <div className="border-t border-gray-200/60 dark:border-zinc-800/60">
        <div className={cn("px-2 py-2 space-y-0.5", isCollapsed && "px-1.5")}>
          {navItems.map((item) => (
            <NavButton
              key={item.id}
              icon={item.icon}
              label={item.label}
              isActive={item.isActive}
              onClick={item.onClick}
              isCollapsed={isCollapsed}
            />
          ))}
        </div>
      </div>

      {/* Login/Logout */}
      <div className="border-t border-gray-200/60 dark:border-zinc-800/60">
        <div className={cn("p-2", isCollapsed && "p-1.5")}>
          {user ? (
            <NavButton
              icon={<LogOut className="h-4 w-4" />}
              label="Logout"
              onClick={onLogout}
              isCollapsed={isCollapsed}
            />
          ) : (
            <NavButton
              icon={<LogOut className="h-4 w-4 rotate-180" />}
              label="Login"
              onClick={onLoginClick}
              isCollapsed={isCollapsed}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

