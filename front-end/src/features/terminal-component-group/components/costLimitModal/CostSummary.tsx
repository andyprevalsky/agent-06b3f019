import { formatCentsAsDollars } from './format';

interface CostSummaryProps {
  currentCostCents: number;
  currentLimitCents: number;
}

export function CostSummary({ currentCostCents, currentLimitCents }: CostSummaryProps) {
  return (
    <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border">
      <div>
        <p className="text-sm text-muted-foreground">Current Cost Consumed</p>
        <p className="text-2xl font-bold font-mono">{formatCentsAsDollars(currentCostCents)}</p>
      </div>
      <div className="text-right">
        <p className="text-sm text-muted-foreground">Price Limit</p>
        <p className="text-lg font-mono text-muted-foreground">
          {formatCentsAsDollars(currentLimitCents)}
        </p>
      </div>
    </div>
  );
}
