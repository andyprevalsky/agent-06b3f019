import { Agent } from '@/lib/api';
import { cn } from '@/lib/utils';

interface AgentListItemProps {
  agent: Agent;
  isSelected: boolean;
  onClick: () => void;
}

export default function AgentListItem({ agent, isSelected, onClick }: AgentListItemProps) {
  // Calculate the progress arc for the circular progress wheel
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const progressOffset = circumference - (agent.progress * circumference);

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left p-3 rounded-lg transition-all border',
        isSelected
          ? 'bg-navi-white-dark dark:bg-navi-light-light-black border-border'
          : 'bg-navi-white dark:bg-navi-light-black hover:bg-navi-white-dark dark:hover:bg-navi-light-light-black border-border'
      )}
    >
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium text-sm line-clamp-2 flex-1">{agent.goal}</h3>
          
          {/* Progress Percentage and Wheel */}
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
        </div>

        {agent.status_message && (
          <p className="text-xs text-muted-foreground line-clamp-1">
            {agent.status_message}
          </p>
        )}
      </div>
    </button>
  );
}

