import { Agent } from '@/lib/api';
import { cn } from '@/lib/utils';

interface AgentListItemProps {
  agent: Agent;
  isSelected: boolean;
  onClick: () => void;
}

export default function AgentListItem({ agent, isSelected, onClick }: AgentListItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left p-3 rounded-lg transition-all border',
        isSelected
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-card dark:bg-navi-light-black hover:bg-secondary dark:hover:bg-navi-light-light-black border-border'
      )}
    >
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-medium text-sm line-clamp-2 flex-1">{agent.goal}</h3>
          <span className={cn(
            'text-xs px-2 py-0.5 rounded-full whitespace-nowrap',
            agent.status === 'COMPLETED' && 'bg-green-500/20 text-green-400',
            agent.status === 'ACTIVE' && 'bg-blue-500/20 text-blue-400',
            agent.status === 'FAILED' && 'bg-red-500/20 text-red-400',
            agent.status === 'PAUSED' && 'bg-yellow-500/20 text-yellow-400',
            agent.status === 'STARTING_UP' && 'bg-purple-500/20 text-purple-400'
          )}>
            {agent.status}
          </span>
        </div>
        
        {/* Progress Bar with Navi Gradient */}
        <div className="w-full h-1 bg-border dark:bg-navi-light-light-black rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${agent.progress * 100}%`,
              background: 'linear-gradient(to right, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
            }}
          />
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

