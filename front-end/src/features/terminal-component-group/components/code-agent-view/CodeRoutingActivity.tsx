/** Quiet only known, healthy routing activity; diagnostics stay one click away. */
import { useState, type ReactNode } from 'react';
export function CodeRoutingActivity({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="text-xs text-muted-foreground" data-testid="code-routing-activity">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        Agent routing · {expanded ? 'Hide details' : 'Show details'}
      </button>
      {expanded && children}
    </div>
  );
}
