import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2 } from 'lucide-react';

interface UsageData {
  total: number;
  used: number;
  remaining: number;
  tier: number | null;
}

interface ModelStats {
  model: string;
  tokens: number;
  percentage: number;
}

export default function Usage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [topModels, setTopModels] = useState<ModelStats[]>([]);
  const [totalTokens, setTotalTokens] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsageData();
  }, []);

  const fetchUsageData = async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        console.log('No session');
        return;
      }

      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

      // Fetch usage and stats in parallel
      const [usageResponse, statsResponse] = await Promise.all([
        fetch(`${backendUrl}/api/credits/usage`, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        }),
        fetch(`${backendUrl}/api/credits/stats`, {
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
        }),
      ]);

      if (usageResponse.ok) {
        const usageData = await usageResponse.json();
        setUsage(usageData);
      }

      if (statsResponse.ok) {
        const statsData = await statsResponse.json();
        setTotalTokens(statsData.totalTokens);
        setTopModels(statsData.topModels);
      }

    } catch (error) {
      console.error('Error fetching usage:', error);
    } finally {
      setLoading(false);
    }
  };

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
      {/* Credit Usage and Token Consumption - Side by Side */}
      <div className="grid grid-cols-2 gap-6">
        {/* Credit Usage */}
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
                <p className="text-2xl font-bold text-green-500">${usage?.remaining.toFixed(2) || '0.00'}</p>
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
              <p className="text-sm text-muted-foreground">
                Current plan: ${usage.tier}/month
              </p>
            )}
          </CardContent>
        </Card>

        {/* Token Consumption */}
        <Card>
          <CardHeader>
            <CardTitle>Total Tokens Consumed</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-bold">{totalTokens.toLocaleString()}</p>
            <p className="text-sm text-muted-foreground mt-2">
              Across all agents and models
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Top Models */}
      <Card>
        <CardHeader>
          <CardTitle>Top 5 Models by Token Usage</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {topModels.map((model, index) => (
              <div key={model.model}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">#{index + 1}</span>
                    <span className="text-sm">{model.model}</span>
                  </div>
                  <span className="text-sm text-muted-foreground">
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

