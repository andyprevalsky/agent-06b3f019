import { Loader2, ExternalLink, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface BillingTabProps {
  subscriptionTier: number | null;
  loadingBillingPortal: boolean;
  onOpenBillingPortal: () => void;
  subscribeUrl: string | null;
  /** Optional content below the Current Plan block (Rose Desktop payments UI). */
  extra?: React.ReactNode;
}

export default function BillingTab({
  subscriptionTier,
  loadingBillingPortal,
  onOpenBillingPortal,
  subscribeUrl,
  extra,
}: BillingTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="w-5 h-5" />
          Subscription & Billing
        </CardTitle>
        <CardDescription>
          Manage your subscription, view invoices, and update payment methods
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="p-4 border rounded-lg bg-muted/30">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">Current Plan</p>
              <p className="text-sm text-muted-foreground">
                {subscriptionTier ? `$${subscriptionTier}/month` : 'Free tier'}
              </p>
            </div>
            {subscriptionTier ? (
              <Button onClick={onOpenBillingPortal} disabled={loadingBillingPortal}>
                {loadingBillingPortal ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <ExternalLink className="w-4 h-4 mr-2" />
                )}
                Manage Subscription
              </Button>
            ) : (
              <Button asChild>
                <a href={subscribeUrl || '#'} target="_blank" rel="noopener noreferrer">
                  Subscribe
                </a>
              </Button>
            )}
          </div>
        </div>

        {extra}

        <p className="text-sm text-muted-foreground">
          {subscriptionTier
            ? 'Click "Manage Subscription" to update your payment method, change your plan, view invoices, or cancel your subscription.'
            : 'Subscribe to unlock API access and additional features.'}
        </p>
      </CardContent>
    </Card>
  );
}
