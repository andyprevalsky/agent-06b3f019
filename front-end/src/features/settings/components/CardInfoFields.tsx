import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PaymentData } from '@/lib/encryption';

import CardIcons from './CardIcons';

interface CardInfoFieldsProps {
  paymentData: PaymentData;
  paymentErrors: Record<string, string>;
  currentCardType: string;
  onCardNumber: (value: string) => void;
  onExpiry: (value: string) => void;
  onCVV: (value: string) => void;
  setPaymentData: React.Dispatch<React.SetStateAction<PaymentData>>;
}

export default function CardInfoFields({
  paymentData,
  paymentErrors,
  currentCardType,
  onCardNumber,
  onExpiry,
  onCVV,
  setPaymentData,
}: CardInfoFieldsProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Card Information</h3>
      <div className="space-y-2">
        <Label htmlFor="cardNumber">Card Number</Label>
        <div className="relative">
          <Input
            id="cardNumber"
            placeholder="4111 1111 1111 1111"
            value={paymentData.card_number}
            onChange={(e) => onCardNumber(e.target.value)}
            className={`pr-12 ${paymentErrors.card_number ? 'border-destructive' : ''}`}
            maxLength={19}
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {CardIcons[currentCardType] || CardIcons.unknown}
          </div>
        </div>
        {paymentErrors.card_number && (
          <p className="text-sm text-destructive">{paymentErrors.card_number}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="cardholderName">Cardholder Name</Label>
        <Input
          id="cardholderName"
          placeholder="John Doe"
          value={paymentData.cardholder_name}
          onChange={(e) => setPaymentData((prev) => ({ ...prev, cardholder_name: e.target.value }))}
          className={paymentErrors.cardholder_name ? 'border-destructive' : ''}
        />
        {paymentErrors.cardholder_name && (
          <p className="text-sm text-destructive">{paymentErrors.cardholder_name}</p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="cardExpiry">Expiry Date</Label>
          <Input
            id="cardExpiry"
            placeholder="MM/YY"
            value={paymentData.card_expiry}
            onChange={(e) => onExpiry(e.target.value)}
            className={paymentErrors.card_expiry ? 'border-destructive' : ''}
            maxLength={5}
          />
          {paymentErrors.card_expiry && (
            <p className="text-sm text-destructive">{paymentErrors.card_expiry}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="cardCvv">CVV</Label>
          <Input
            id="cardCvv"
            placeholder={currentCardType === 'amex' ? '1234' : '123'}
            value={paymentData.card_cvv}
            onChange={(e) => onCVV(e.target.value)}
            className={paymentErrors.card_cvv ? 'border-destructive' : ''}
            maxLength={4}
            type="password"
          />
          {paymentErrors.card_cvv && (
            <p className="text-sm text-destructive">{paymentErrors.card_cvv}</p>
          )}
        </div>
      </div>
    </div>
  );
}
