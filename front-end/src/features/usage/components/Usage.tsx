/**
 * STATE MACHINE: Usage
 *
 * [LOADING] <-- loading: true
 *     |
 *     v (fetchUsageData)
 * [READY] <-- loading: false
 *     |
 *     +--> usage: UsageData | null
 *     +--> topModels: ModelStats[]
 *     +--> totalTokens: number
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

import { useUsageData } from '../hooks';
import { CreditUsageCard } from './CreditUsageCard';
import { TokenConsumptionCard } from './TokenConsumptionCard';
import { TopModelsCard } from './TopModelsCard';

export default function Usage() {
  const { usage, topModels, totalTokens, loading } = useUsageData();

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="pt-24 p-6 space-y-6 max-w-6xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
          <CreditUsageCard usage={usage} />
          <TokenConsumptionCard totalTokens={totalTokens} />
        </div>

        <TopModelsCard topModels={topModels} />

        {/* Usage Over Time - Placeholder */}
        <Card>
          <CardHeader>
            <CardTitle>Usage Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 flex items-center justify-center border-2 border-dashed border-border rounded-lg">
              <p className="text-muted-foreground">Graph coming soon</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
