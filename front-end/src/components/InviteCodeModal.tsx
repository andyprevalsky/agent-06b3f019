/**
 * STATE MACHINE: InviteCodeModal
 *
 * [CLOSED] <-- open: false (controlled by parent)
 *     |
 *     v (open=true)
 * [LOADING] <-- loading: true, inviteInfo: null
 *     |
 *     v (API response)
 * [READY] <-- loading: false, inviteInfo: InviteCodeInfo
 *     |
 *     | (click copy)
 *     v
 * [COPIED] <-- copied: true
 *     |
 *     v (setTimeout 2s)
 * [READY] <-- copied: false
 */

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import { getMyInviteCode, InviteCodeInfo } from "@/lib/api";
import { Copy, Check } from "lucide-react";

interface InviteCodeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const InviteCodeModal = ({ open, onOpenChange }: InviteCodeModalProps) => {
  const { toast } = useToast();
  const [inviteInfo, setInviteInfo] = useState<InviteCodeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      loadInviteCode();
    }
  }, [open]);

  const loadInviteCode = async () => {
    try {
      setLoading(true);
      const info = await getMyInviteCode();
      setInviteInfo(info);
    } catch (error: any) {
      console.error('Error loading invite code:', error);
      toast({
        title: "Error",
        description: error.message || "Failed to load invite code",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!inviteInfo) return;

    try {
      await navigator.clipboard.writeText(inviteInfo.inviteCode.toString());
      setCopied(true);
      toast({
        title: "Copied!",
        description: "Invite code copied to clipboard",
      });
      
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to copy to clipboard",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        className="sm:max-w-md p-8 border border-border/50 shadow-lg z-[100]"
        style={{ 
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
        }}
      >
        <div className="space-y-6">
          <div className="text-center space-y-2">
            <h2 className="text-xl font-semibold">Rose is an invite only system</h2>
            <p className="text-sm text-muted-foreground">Your invite code is</p>
          </div>

          {loading ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : inviteInfo ? (
            <>
              <div className="relative">
                <div 
                  className="text-center text-5xl font-mono font-bold tracking-wider py-6 px-4 bg-muted rounded-lg cursor-pointer hover:bg-muted/80 transition-colors"
                  onClick={handleCopy}
                >
                  {inviteInfo.inviteCode.toString().padStart(6, '0')}
                </div>
                <button
                  onClick={handleCopy}
                  className="absolute top-2 right-2 p-2 rounded-md hover:bg-background/50 transition-colors"
                  aria-label="Copy invite code"
                >
                  {copied ? (
                    <Check className="w-5 h-5 text-green-500" />
                  ) : (
                    <Copy className="w-5 h-5 text-muted-foreground" />
                  )}
                </button>
              </div>

              <div className="text-center">
                <p className="text-2xl font-semibold">
                  {inviteInfo.usesRemaining} Use{inviteInfo.usesRemaining !== 1 ? 's' : ''} Left
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  {inviteInfo.uses} of 3 invites used
                </p>
              </div>
            </>
          ) : (
            <div className="text-center text-muted-foreground">
              Failed to load invite code
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default InviteCodeModal;

