import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { type UsageData } from '../types';

interface CreditUsageCardProps {
  usage: UsageData | null;
}

export function CreditUsageCard({ usage }: CreditUsageCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Credit Usage</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Total Credits</p>
            <p className="text-2xl font-bold">${usage?.total.toFixed(2) || '0.00'}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Used</p>
            <p className="text-2xl font-bold text-red-500">${usage?.used.toFixed(2) || '0.00'}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Remaining</p>
            <p className="text-2xl font-bold text-green-500">
              ${usage?.remaining.toFixed(2) || '0.00'}
            </p>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-secondary rounded-full h-3">
          <div
            className="bg-primary h-3 rounded-full transition-all"
            style={{ width: `${usage ? (usage.used / usage.total) * 100 : 0}%` }}
          />
        </div>

        {usage?.tier && (
          <p className="text-sm text-muted-foreground">Current plan: ${usage.tier}/month</p>
        )}
      </CardContent>
    </Card>
  );
}
