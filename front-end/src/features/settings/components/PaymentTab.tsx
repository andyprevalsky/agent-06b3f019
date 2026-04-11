import {
  Loader2,
  Save,
  Check,
  CreditCard,
  HelpCircle,
  Pencil,
  ExternalLink,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { PaymentData, EncryptedPaymentEnvelope } from '@/lib/encryption';

import CardIcons from './CardIcons';
import CardInfoFields from './CardInfoFields';
import BillingAddressFields from './BillingAddressFields';

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
    <div className="p-4 bg-amber-500/10 border border-amber-500/50 rounded-lg flex items-start gap-3">
      <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <p className="text-sm text-amber-800 dark:text-amber-200">
          <span className="font-medium">All card credentials are end-to-end encrypted.</span> We
          recommend creating a separate card for your agent to manage spend (takes &lt; 2 min).
        </p>
        <Button size="sm" className="bg-black text-white hover:bg-black/80" asChild>
          <a href="https://privacy.com" target="_blank" rel="noopener noreferrer">
            <ExternalLink className="w-3 h-3 mr-2" />
            Create Card via Privacy.com
          </a>
        </Button>
      </div>
    </div>
  );
}

function SavedPaymentDisplay({
  envelope,
  onEdit,
}: {
  envelope: EncryptedPaymentEnvelope;
  onEdit: () => void;
}) {
  return (
    <div className="p-4 border rounded-lg bg-muted/30 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {CardIcons[envelope.card_type] || CardIcons.unknown}
          <div>
            <p className="font-medium">**** **** **** {envelope.card_last_four}</p>
            <p className="text-sm text-muted-foreground">
              {envelope.billing_city}, {envelope.billing_country}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="w-4 h-4 mr-2" />
          Edit
        </Button>
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Autopay limit:</span>
        <span className="font-medium">${(envelope.autoagentpaylimit_cents / 100).toFixed(2)}</span>
        {envelope.autoagentpaylimit_cents === 0 && (
          <span className="text-muted-foreground">(disabled - all payments require approval)</span>
        )}
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
                Payments under this amount will be automatically approved. Payments over this amount
                will require your approval.
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
            Encrypting...
          </>
        ) : savedPayment ? (
          <>
            <Check className="w-4 h-4 mr-2" />
            Saved!
          </>
        ) : (
          <>
            <Save className="w-4 h-4 mr-2" />
            Save Payment Method
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
          Agent Payment Method
        </CardTitle>
        <CardDescription>
          Payment method for agent autopay when making purchases on your behalf
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SecurityNotice />

        {props.savedPaymentEnvelope && !props.showPaymentForm && (
          <SavedPaymentDisplay
            envelope={props.savedPaymentEnvelope}
            onEdit={() => props.setShowPaymentForm(true)}
          />
        )}

        {(props.showPaymentForm || !props.savedPaymentEnvelope) && (
          <div className="space-y-6">
            <AutopayLimitField
              autopayLimitDisplay={props.autopayLimitDisplay}
              setAutopayLimitDisplay={props.setAutopayLimitDisplay}
              onAutopayBlur={props.onAutopayBlur}
              paymentErrors={props.paymentErrors}
            />
            <CardInfoFields
              paymentData={props.paymentData}
              paymentErrors={props.paymentErrors}
              currentCardType={props.currentCardType}
              onCardNumber={props.onCardNumber}
              onExpiry={props.onExpiry}
              onCVV={props.onCVV}
              setPaymentData={props.setPaymentData}
            />
            <BillingAddressFields
              paymentData={props.paymentData}
              paymentErrors={props.paymentErrors}
              setPaymentData={props.setPaymentData}
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
          </div>
        )}
      </CardContent>
    </Card>
  );
}
