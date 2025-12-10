import { Agent } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Play, Loader2, CreditCard, Bot } from 'lucide-react';

interface AgentListItemProps {
  agent: Agent;
  isSelected: boolean;
  onClick: () => void;
  onResume?: (agentId: string) => void;
  isResuming?: boolean;
  isCompact?: boolean;
}

export default function AgentListItem({ agent, isSelected, onClick, onResume, isResuming = false, isCompact = false }: AgentListItemProps) {
  // Calculate the progress arc for the circular progress wheel
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const progressOffset = circumference - (agent.progress * circumference);

  const handlePlayClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger the parent onClick
    if (onResume) {
      onResume(agent.agent_id);
    }
  };

  // Compact mode - just show an icon
  if (isCompact) {
    return (
      <div
        onClick={onClick}
        className={cn(
          'w-full flex items-center justify-center p-2 rounded-lg transition-all cursor-pointer',
          isSelected
            ? 'bg-gray-200 dark:bg-zinc-700'
            : 'hover:bg-gray-100 dark:hover:bg-zinc-800'
        )}
      >
        <Bot className={cn(
          "h-5 w-5",
          isSelected ? "text-gray-800 dark:text-gray-200" : "text-gray-500 dark:text-gray-400"
        )} />
      </div>
    );
  }

  return (
    <div className="w-full space-y-1.5">
      <div
        onClick={onClick}
        className={cn(
          'w-full text-left p-3 rounded-lg transition-all border cursor-pointer',
          isSelected
            ? 'bg-navi-white-dark dark:bg-navi-light-light-black border-border'
            : 'bg-navi-white dark:bg-navi-light-black hover:bg-navi-white-dark dark:hover:bg-navi-light-light-black border-border'
        )}
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium text-sm line-clamp-2 flex-1">{agent.goal}</h3>
            
            {/* Show play button if paused, credit icon if out of credits, otherwise show progress */}
            {agent.status === 'OUT_OF_CREDITS' ? (
              <div 
                className="flex-shrink-0 p-1.5 rounded-full border-2 border-red-400 dark:border-red-500"
                title="Agent ran out of credits - add more to continue"
              >
                <CreditCard className="w-3.5 h-3.5 text-red-500" />
              </div>
            ) : agent.status === 'PAUSED' ? (
              <button
                onClick={handlePlayClick}
                disabled={isResuming}
                className={cn(
                  "flex-shrink-0 p-1.5 rounded-full transition-colors border-2 border-gray-300 dark:border-gray-600",
                  isResuming 
                    ? "cursor-not-allowed opacity-70" 
                    : "hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer"
                )}
                title={isResuming ? "Resuming agent..." : "Resume agent"}
              >
                {isResuming ? (
                  <Loader2 className="w-3.5 h-3.5 text-gray-500 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 text-gray-500" fill="currentColor" />
                )}
              </button>
            ) : (
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-gray-500">
                  {Math.round(agent.progress * 100)}%
                </span>
                <svg className="transform -rotate-90" viewBox="0 0 20 20" width="18" height="18">
                  <circle
                    className="fill-none stroke-gray-300 opacity-70"
                    cx="10"
                    cy="10"
                    r={radius}
                    strokeWidth="3"
                  />
                  <circle
                    className="fill-none stroke-gray-500"
                    cx="10"
                    cy="10"
                    r={radius}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={progressOffset}
                    style={{ 
                      transition: 'stroke-dashoffset 500ms ease',
                      stroke: 'url(#progress-gradient)'
                    }}
                  />
                  <defs>
                    <linearGradient id="progress-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                      <stop offset="0%" stopColor="#FE7503" />
                      <stop offset="20%" stopColor="#FC585C" />
                      <stop offset="40%" stopColor="#FD5776" />
                      <stop offset="60%" stopColor="#E062CC" />
                      <stop offset="80%" stopColor="#A76CED" />
                      <stop offset="100%" stopColor="#7A6BEC" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

