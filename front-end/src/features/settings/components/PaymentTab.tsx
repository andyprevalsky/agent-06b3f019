/**
 * STATE MACHINE: PaymentTab
 *
 * [IDLE] -- user edits autopay limit --> [DIRTY]
 * [DIRTY] -- save clicked --> [SAVING]
 * [SAVING] -- success --> [SAVED]
 * [SAVING] -- validation/API error --> [DIRTY_WITH_ERROR]
 * [SAVED] -- user edits autopay limit --> [DIRTY]
 *
 * This tab now stores only the autopay limit marker. Agents request one-time
 * virtual cards at checkout instead of reading a saved shopping card.
 */

import { Loader2, Save, Check, CreditCard, HelpCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { PaymentData, EncryptedPaymentEnvelope } from '@/lib/encryption';

interface PaymentTabProps {
  showPaymentForm: boolean;
  setShowPaymentForm: (v: boolean) => void;
  paymentData: PaymentData;
  setPaymentData: React.Dispatch<React.SetStateAction<PaymentData>>;
  paymentErrors: Record<string, string>;
  setPaymentErrors: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  savingPayment: boolean;
  savedPayment: boolean;
  autopayLimitDisplay: string;
  setAutopayLimitDisplay: (v: string) => void;
  savedPaymentEnvelope: EncryptedPaymentEnvelope | null;
  currentCardType: string;
  onSave: () => void;
  onCardNumber: (value: string) => void;
  onExpiry: (value: string) => void;
  onCVV: (value: string) => void;
  onAutopayBlur: () => void;
}

function SecurityNotice() {
  return (
    <div className="p-4 bg-emerald-500/10 border border-emerald-500/40 rounded-lg flex items-start gap-3">
      <ShieldCheck className="w-5 h-5 text-emerald-700 dark:text-emerald-300 mt-0.5 flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <p className="text-sm text-emerald-900 dark:text-emerald-100">
          <span className="font-medium">Rose no longer stores agent shopping cards.</span> At
          checkout, Rose charges your Stripe billing method and mints a one-time virtual card.
        </p>
      </div>
    </div>
  );
}

function AutopayLimitField({
  autopayLimitDisplay,
  setAutopayLimitDisplay,
  onAutopayBlur,
  paymentErrors,
}: Pick<
  PaymentTabProps,
  'autopayLimitDisplay' | 'setAutopayLimitDisplay' | 'onAutopayBlur' | 'paymentErrors'
>) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor="autopayLimit">Autopay Limit ($)</Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <HelpCircle className="w-4 h-4 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p>
                Payments under this amount may be approved automatically. Larger purchases ask
                first.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <Input
        id="autopayLimit"
        type="number"
        min="0"
        step="0.01"
        placeholder="100.00"
        value={autopayLimitDisplay}
        onChange={(e) => setAutopayLimitDisplay(e.target.value)}
        onBlur={onAutopayBlur}
        className="max-w-[200px]"
      />
      {paymentErrors.autoagentpaylimit_cents && (
        <p className="text-sm text-destructive">{paymentErrors.autoagentpaylimit_cents}</p>
      )}
      <p className="text-sm text-muted-foreground">
        Set to $0 to require approval for all payments
      </p>
    </div>
  );
}

function SavePaymentButton({
  savingPayment,
  savedPayment,
  showPaymentForm,
  savedPaymentEnvelope,
  onSave,
  onCancel,
}: {
  savingPayment: boolean;
  savedPayment: boolean;
  showPaymentForm: boolean;
  savedPaymentEnvelope: EncryptedPaymentEnvelope | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex gap-4 pt-4">
      <Button onClick={onSave} disabled={savingPayment} className="min-w-[160px]">
        {savingPayment ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Saving...
          </>
        ) : savedPayment ? (
          <>
            <Check className="w-4 h-4 mr-2" />
            Saved!
          </>
        ) : (
          <>
            <Save className="w-4 h-4 mr-2" />
            Save Autopay Limit
          </>
        )}
      </Button>
      {showPaymentForm && savedPaymentEnvelope && (
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </div>
  );
}

export default function PaymentTab(props: PaymentTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="w-5 h-5" />
          Agent Purchases
        </CardTitle>
        <CardDescription>
          Manage approval limits for one-time virtual cards used by agents at checkout
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SecurityNotice />

        <AutopayLimitField
          autopayLimitDisplay={props.autopayLimitDisplay}
          setAutopayLimitDisplay={props.setAutopayLimitDisplay}
          onAutopayBlur={props.onAutopayBlur}
          paymentErrors={props.paymentErrors}
        />
        <SavePaymentButton
          savingPayment={props.savingPayment}
          savedPayment={props.savedPayment}
          showPaymentForm={props.showPaymentForm}
          savedPaymentEnvelope={props.savedPaymentEnvelope}
          onSave={props.onSave}
          onCancel={() => {
            props.setShowPaymentForm(false);
            props.setPaymentErrors({});
          }}
        />
      </CardContent>
    </Card>
  );
}
