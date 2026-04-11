import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface SubscriptionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subscribeUrl: string | null;
}

export default function SubscriptionModal({
  open,
  onOpenChange,
  subscribeUrl,
}: SubscriptionModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Subscription Required</DialogTitle>
          <DialogDescription>
            API access requires an active subscription to Rose Labs.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button asChild>
            <a href={subscribeUrl || '#'} target="_blank" rel="noopener noreferrer">
              Subscribe
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
