import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { type ModelStats } from '../types';

interface TopModelsCardProps {
  topModels: ModelStats[];
}

export function TopModelsCard({ topModels }: TopModelsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top 5 Models by Token Usage</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {topModels.map((model, index) => (
            <div key={model.model}>
              <div className="flex items-center justify-between mb-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium flex-shrink-0">#{index + 1}</span>
                  <span className="text-sm truncate">{model.model}</span>
                </div>
                <span className="text-sm text-muted-foreground flex-shrink-0 ml-2">
                  {model.tokens.toLocaleString()} tokens ({model.percentage}%)
                </span>
              </div>
              <div className="w-full bg-secondary rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${model.percentage}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
