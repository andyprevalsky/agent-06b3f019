import { useEffect, useState } from 'react';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { CreditCard, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import SubscriptionModal from './SubscriptionModal';
import { getStoredSession } from '@/lib/supabase';

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

interface UsageDisplayProps {
  className?: string;
}

export default function UsageDisplay({ className }: UsageDisplayProps) {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchUsage = async () => {
    try {
      const session = getStoredSession();
      if (!session) {
        console.log('[UsageDisplay] No session available, skipping credits fetch');
        setLoading(false);
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001'}/api/credits/usage`,
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

        // Auto-show modal if out of credits
        if (data.remaining <= 0) {
          setShowSubscriptionModal(true);
        }
      } else {
        console.error('Failed to fetch usage:', response.status);
      }
    } catch (error) {
      console.error('Error fetching usage:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsage();

    // Poll usage every 30 seconds
    const interval = setInterval(fetchUsage, 30000);

    return () => clearInterval(interval);
  }, []);

  if (loading || !usage) {
    return (
      <div className={cn("flex items-center gap-2 px-3 py-2 text-sm", className)}>
        <CreditCard className="h-4 w-4 animate-pulse" />
        <span className="text-muted-foreground">Loading...</span>
      </div>
    );
  }

  const percentageUsed = usage.total > 0 ? (usage.used / usage.total) * 100 : 0;
  const isLow = usage.remaining < 1;
  const isDepleted = usage.remaining <= 0;

  return (
    <>
      <div className={cn("space-y-2", className)}>
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            <CreditCard className={cn(
              "h-4 w-4",
              isDepleted ? "text-red-500" : isLow ? "text-yellow-500" : "text-green-500"
            )} />
            <span className="font-medium">
              {Math.floor(usage.remaining)} credits
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowSubscriptionModal(true)}
            className="h-7 text-xs"
          >
            Upgrade
          </Button>
        </div>

        <Progress
          value={100 - percentageUsed}
          className={cn(
            "h-2",
            isDepleted && "bg-red-100 dark:bg-red-900/20"
          )}
        />

        {isLow && !isDepleted && (
          <div className="flex items-center gap-2 text-xs text-yellow-600 dark:text-yellow-400">
            <AlertCircle className="h-3 w-3" />
            <span>Low credits - upgrade soon to avoid interruption</span>
          </div>
        )}

        {isDepleted && (
          <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 font-semibold">
            <AlertCircle className="h-3 w-3" />
            <span>Out of credits - upgrade now to resume agents</span>
          </div>
        )}

        {usage.tier && (
          <div className="text-xs text-muted-foreground">
            Current plan: ${usage.tier}/month
          </div>
        )}
      </div>

      <SubscriptionModal
        open={showSubscriptionModal}
        onOpenChange={setShowSubscriptionModal}
        currentTier={usage.tier}
        upgradeOptions={usage.upgradeOptions}
        remaining={usage.remaining}
      />
    </>
  );
}

