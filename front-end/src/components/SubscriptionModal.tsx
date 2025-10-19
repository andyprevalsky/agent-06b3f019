import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/lib/supabase";

interface SubscriptionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentTier: number | null;
  upgradeOptions: Array<{
    tier: number;
    name: string;
    url: string;
  }>;
  remaining: number;
}

export default function SubscriptionModal({
  open,
  onOpenChange,
  currentTier,
  upgradeOptions,
  remaining,
}: SubscriptionModalProps) {
  const isMaxTier = currentTier === 200;

  const handleUpgrade = async (url: string) => {
    try {
      // Get current user
      const { data: { user } } = await supabase.auth.getUser();
      
      if (!user) {
        console.error('No user found');
        // TODO: Show login modal
        return;
      }

      // Add userId as client_reference_id query param
      // Stripe will include this in webhook events!
      const urlWithUserId = `${url}?client_reference_id=${user.id}`;
      
      // Open payment link with userId attached
      window.open(urlWithUserId, '_blank');
    } catch (error) {
      console.error('Error opening payment link:', error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto bg-card dark:bg-navi-black border-border">
        <DialogHeader>
          <DialogTitle>
            Plans & credits
          </DialogTitle>
        </DialogHeader>

        {isMaxTier ? (
          // Show contact info for max tier users
          <div className="py-8 text-center space-y-4">
            <div className="text-6xl">🚀</div>
            <h3 className="text-xl font-semibold">Enterprise Usage</h3>
            <p className="text-muted-foreground">
              You're on our highest tier! For additional usage, please contact us directly.
            </p>
            <div className="pt-4">
              <Button
                size="lg"
                onClick={() => window.location.href = 'mailto:andy@hinavi.ai'}
                className="bg-navi-black text-white hover:bg-navi-black/90"
              >
                Contact andy@hinavi.ai
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 py-4">
            {upgradeOptions.map((option) => (
              <div
                key={option.tier}
                className={cn(
                  "border border-border rounded-lg p-6 transition-all hover:border-foreground/50",
                  "bg-background dark:bg-navi-light-black",
                  "flex flex-col"
                )}
              >
                <div className="flex-1 space-y-4">
                  <div>
                    <h3 className="text-lg font-semibold">{option.name}</h3>
                    <div className="flex items-baseline gap-1 mt-2">
                      <span className="text-3xl font-bold">${option.tier}</span>
                      <span className="text-sm text-muted-foreground">/month</span>
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <Check className="h-4 w-4 text-foreground/70" />
                      <span>${option.tier} monthly credits</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Check className="h-4 w-4 text-foreground/70" />
                      <span>Unlimited agents</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Check className="h-4 w-4 text-foreground/70" />
                      <span>All models</span>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <Check className="h-4 w-4 text-foreground/70" />
                      <span>Priority support</span>
                    </div>
                  </div>
                </div>
                
                <Button
                  onClick={() => handleUpgrade(option.url)}
                  className="mt-6 w-full bg-navi-black text-white hover:bg-navi-black/90"
                >
                  Upgrade
                </Button>
              </div>
            ))}
          </div>
        )}

        {currentTier && !isMaxTier && (
          <div className="text-xs text-muted-foreground text-center pt-2 border-t border-border">
            Currently on: ${currentTier}/month plan
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

