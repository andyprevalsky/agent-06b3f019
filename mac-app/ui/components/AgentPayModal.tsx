import { useState, useEffect } from 'react';
import { X, Loader2, CreditCard, ShieldAlert, ExternalLink, Pencil } from 'lucide-react';
import { getSession } from '@/lib/supabase';
import {
  encryptPaymentData,
  parsePaymentEnvelope,
  detectCardType,
  validateCardNumber,
  validateExpiry,
  validateCVV,
  type PaymentData,
  type EncryptedPaymentEnvelope,
} from '@/lib/encryption';

interface AgentPayModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

// Card type icons (adapted from Settings.tsx)
const CardIcons: Record<string, React.ReactNode> = {
  visa: (
    <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none">
      <rect width="24" height="24" rx="4" fill="#1A1F71"/>
      <path d="M9.5 15.5L10.5 8.5H12.5L11.5 15.5H9.5Z" fill="white"/>
      <path d="M16.5 8.7C16 8.5 15.2 8.3 14.2 8.3C12.2 8.3 10.8 9.3 10.8 10.8C10.8 11.9 11.8 12.5 12.6 12.9C13.4 13.3 13.7 13.5 13.7 13.9C13.7 14.4 13.1 14.7 12.5 14.7C11.7 14.7 11.2 14.5 10.5 14.2L10.2 14.1L9.9 16C10.5 16.3 11.5 16.5 12.5 16.5C14.6 16.5 16 15.5 16 13.9C16 13 15.5 12.3 14.4 11.8C13.7 11.4 13.2 11.2 13.2 10.7C13.2 10.3 13.6 9.9 14.5 9.9C15.2 9.9 15.8 10 16.2 10.2L16.4 10.3L16.5 8.7Z" fill="white"/>
      <path d="M19.5 8.5H18C17.5 8.5 17.1 8.7 16.9 9.2L14 15.5H16.1L16.5 14.3H19.1L19.3 15.5H21.2L19.5 8.5ZM17.1 12.7L18.1 10.1L18.7 12.7H17.1Z" fill="white"/>
      <path d="M8 8.5L6 13.5L5.8 12.5C5.4 11.2 4.2 9.8 2.8 9L4.6 15.5H6.8L10.2 8.5H8Z" fill="white"/>
    </svg>
  ),
  mastercard: (
    <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none">
      <rect width="24" height="24" rx="4" fill="#000"/>
      <circle cx="9" cy="12" r="5" fill="#EB001B"/>
      <circle cx="15" cy="12" r="5" fill="#F79E1B"/>
      <path d="M12 8.5C13.1 9.4 13.8 10.6 13.8 12C13.8 13.4 13.1 14.6 12 15.5C10.9 14.6 10.2 13.4 10.2 12C10.2 10.6 10.9 9.4 12 8.5Z" fill="#FF5F00"/>
    </svg>
  ),
  amex: (
    <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none">
      <rect width="24" height="24" rx="4" fill="#006FCF"/>
      <path d="M3 12L5 8H7L9 12L7 16H5L3 12Z" fill="white"/>
      <path d="M9 8H13V10H11V11H13V13H11V14H13V16H9V8Z" fill="white"/>
      <path d="M14 8H16L17.5 11L19 8H21L18.5 12L21 16H19L17.5 13L16 16H14L16.5 12L14 8Z" fill="white"/>
    </svg>
  ),
  discover: (
    <svg viewBox="0 0 24 24" className="w-7 h-7" fill="none">
      <rect width="24" height="24" rx="4" fill="#FF6000"/>
      <circle cx="12" cy="12" r="4" fill="white"/>
      <path d="M4 10H6V14H4V10Z" fill="white"/>
      <path d="M18 10H20V14H18V10Z" fill="white"/>
    </svg>
  ),
  unknown: (
    <CreditCard className="w-7 h-7 text-muted-foreground" />
  ),
};

const AgentPayModal = ({ isOpen, onClose, onSuccess }: AgentPayModalProps) => {
  // Loading state for initial fetch
  const [initialLoading, setInitialLoading] = useState(false);

  // Saved payment envelope (from existing data)
  const [savedEnvelope, setSavedEnvelope] = useState<EncryptedPaymentEnvelope | null>(null);
  const [editingCard, setEditingCard] = useState(false);

  // Payment form state
  const [paymentData, setPaymentData] = useState<PaymentData>({
    card_number: '',
    cardholder_name: '',
    card_expiry: '',
    card_cvv: '',
    billing_street_address: '',
    billing_address_line2: '',
    billing_city: '',
    billing_state: '',
    billing_zipcode: '',
    billing_country: 'United States',
    billing_phone: '',
    billing_email: '',
    autoagentpaylimit_cents: 10000,
  });
  const [paymentErrors, setPaymentErrors] = useState<Record<string, string>>({});
  const [autopayLimitDisplay, setAutopayLimitDisplay] = useState('100.00');

  // Shipping address state
  const [shippingAddress, setShippingAddress] = useState({
    name: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'United States',
  });
  const [sameAsBilling, setSameAsBilling] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch existing user settings when modal opens
  useEffect(() => {
    if (!isOpen) return;

    const fetchSettings = async () => {
      setInitialLoading(true);
      try {
        const session = getSession();
        if (!session?.access_token) {
          setInitialLoading(false);
          return;
        }

        const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';
        const response = await fetch(`${backendUrl}/api/user-settings`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();

          // Pre-fill shipping address
          setShippingAddress({
            name: data.name || '',
            addressLine1: data.addressLine1 || '',
            addressLine2: data.addressLine2 || '',
            city: data.city || '',
            state: data.state || '',
            postalCode: data.postalCode || '',
            country: data.country || 'United States',
          });

          // Parse saved payment envelope
          if (data.encryptedPaymentInformation) {
            const envelope = parsePaymentEnvelope(data.encryptedPaymentInformation);
            if (envelope) {
              setSavedEnvelope(envelope);
              setAutopayLimitDisplay((envelope.autoagentpaylimit_cents / 100).toFixed(2));
              setPaymentData(prev => ({
                ...prev,
                autoagentpaylimit_cents: envelope.autoagentpaylimit_cents,
              }));
              setEditingCard(false);
            }
          } else {
            // No saved card - show card form by default
            setEditingCard(true);
          }
        }
      } catch (err) {
        console.error('Failed to fetch user settings:', err);
      } finally {
        setInitialLoading(false);
      }
    };

    fetchSettings();
  }, [isOpen]);

  if (!isOpen) return null;

  // Whether the card form is shown (always if no saved card, or user clicked edit)
  const showCardForm = !savedEnvelope || editingCard;

  const currentCardType = detectCardType(paymentData.card_number);

  // Card input handlers (same logic as Settings.tsx)
  const handleCardNumber = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 16);
    const formatted = digits.replace(/(.{4})/g, '$1 ').trim();
    setPaymentData(prev => ({ ...prev, card_number: formatted }));
  };

  const handleExpiry = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    const formatted = digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
    setPaymentData(prev => ({ ...prev, card_expiry: formatted }));
  };

  const handleCVV = (value: string) => {
    const digits = value.replace(/\D/g, '').slice(0, 4);
    setPaymentData(prev => ({ ...prev, card_cvv: digits }));
  };

  const handleAutopayBlur = () => {
    const dollars = parseFloat(autopayLimitDisplay) || 0;
    setPaymentData(prev => ({ ...prev, autoagentpaylimit_cents: Math.round(dollars * 100) }));
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    // Only validate card fields if editing card
    if (showCardForm) {
      if (!paymentData.card_number) {
        errors.card_number = 'Card number is required';
      } else if (!validateCardNumber(paymentData.card_number)) {
        errors.card_number = 'Invalid card number';
      }

      if (!paymentData.cardholder_name.trim()) {
        errors.cardholder_name = 'Cardholder name is required';
      }

      if (!paymentData.card_expiry) {
        errors.card_expiry = 'Expiry date is required';
      } else if (!validateExpiry(paymentData.card_expiry)) {
        errors.card_expiry = 'Invalid or expired date';
      }

      const cardType = detectCardType(paymentData.card_number);
      if (!paymentData.card_cvv) {
        errors.card_cvv = 'CVV is required';
      } else if (!validateCVV(paymentData.card_cvv, cardType)) {
        errors.card_cvv = cardType === 'amex' ? 'Must be 4 digits' : 'Must be 3 digits';
      }

      if (!paymentData.billing_street_address.trim()) {
        errors.billing_street_address = 'Street address is required';
      }
      if (!paymentData.billing_city.trim()) {
        errors.billing_city = 'City is required';
      }
      if (!paymentData.billing_state.trim()) {
        errors.billing_state = 'State is required';
      }
      if (!paymentData.billing_zipcode.trim()) {
        errors.billing_zipcode = 'ZIP code is required';
      }
      if (!paymentData.billing_country.trim()) {
        errors.billing_country = 'Country is required';
      }
    }

    // Shipping validation
    const shipping = sameAsBilling ? null : shippingAddress;
    if (shipping) {
      if (!shipping.name.trim()) errors.shipping_name = 'Name is required';
      if (!shipping.addressLine1.trim()) errors.shipping_addressLine1 = 'Address is required';
      if (!shipping.city.trim()) errors.shipping_city = 'City is required';
      if (!shipping.state.trim()) errors.shipping_state = 'State is required';
      if (!shipping.postalCode.trim()) errors.shipping_postalCode = 'Postal code is required';
      if (!shipping.country.trim()) errors.shipping_country = 'Country is required';
    }

    setPaymentErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSave = async () => {
    if (!validateForm()) return;

    setSaving(true);
    setError(null);

    try {
      const session = getSession();
      if (!session?.access_token) {
        setError('Not authenticated');
        setSaving(false);
        return;
      }

      const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';

      // Build the update payload
      const updatePayload: Record<string, unknown> = {};

      // If editing card, encrypt and include new payment data
      if (showCardForm) {
        const dollars = parseFloat(autopayLimitDisplay) || 0;
        const cents = Math.round(dollars * 100);
        const dataToSave = { ...paymentData, autoagentpaylimit_cents: cents };
        const encryptedData = await encryptPaymentData(dataToSave);
        updatePayload.encryptedPaymentInformation = encryptedData;
      }

      // Build shipping data
      const shippingData = sameAsBilling
        ? {
            name: paymentData.cardholder_name,
            addressLine1: paymentData.billing_street_address,
            addressLine2: paymentData.billing_address_line2,
            city: paymentData.billing_city,
            state: paymentData.billing_state,
            postalCode: paymentData.billing_zipcode,
            country: paymentData.billing_country,
          }
        : shippingAddress;

      updatePayload.name = shippingData.name;
      updatePayload.addressLine1 = shippingData.addressLine1;
      updatePayload.addressLine2 = shippingData.addressLine2;
      updatePayload.city = shippingData.city;
      updatePayload.state = shippingData.state;
      updatePayload.postalCode = shippingData.postalCode;
      updatePayload.country = shippingData.country;

      const response = await fetch(`${backendUrl}/api/user-settings`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatePayload),
      });

      if (!response.ok) {
        throw new Error('Failed to save payment information');
      }

      onSuccess();
    } catch (err) {
      console.error('Failed to save agent pay:', err);
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!saving) {
      setPaymentData({
        card_number: '',
        cardholder_name: '',
        card_expiry: '',
        card_cvv: '',
        billing_street_address: '',
        billing_address_line2: '',
        billing_city: '',
        billing_state: '',
        billing_zipcode: '',
        billing_country: 'United States',
        billing_phone: '',
        billing_email: '',
        autoagentpaylimit_cents: 10000,
      });
      setPaymentErrors({});
      setAutopayLimitDisplay('100.00');
      setShippingAddress({
        name: '',
        addressLine1: '',
        addressLine2: '',
        city: '',
        state: '',
        postalCode: '',
        country: 'United States',
      });
      setSameAsBilling(false);
      setSavedEnvelope(null);
      setEditingCard(false);
      setError(null);
      onClose();
    }
  };

  const inputClass = (fieldName?: string) =>
    `w-full px-3 py-2 text-sm bg-surface border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 ${
      fieldName && paymentErrors[fieldName] ? 'border-red-500' : 'border-border'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={handleClose}
      />

      {/* Modal */}
      <div className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-lg mx-4 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-base font-semibold text-foreground">Agent Pay</h2>
          </div>
          <button
            onClick={handleClose}
            disabled={saving}
            className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">
          {initialLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Security notice */}
              <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    <span className="font-medium">All card credentials are end-to-end encrypted.</span>{' '}
                    We recommend creating a separate card for your agent.
                  </p>
                  <a
                    href="https://privacy.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-black text-white rounded hover:bg-black/80 transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    Create Card via Privacy.com
                  </a>
                </div>
              </div>

              {/* Saved Card Display (when not editing) */}
              {savedEnvelope && !editingCard && (
                <div className="p-4 border rounded-lg bg-muted/30 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      {CardIcons[savedEnvelope.card_type] || CardIcons.unknown}
                      <div>
                        <p className="text-sm font-medium text-foreground">
                          **** **** **** {savedEnvelope.card_last_four}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {savedEnvelope.billing_city}, {savedEnvelope.billing_country}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setEditingCard(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-border rounded-lg hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
                    >
                      <Pencil className="w-3 h-3" />
                      Update
                    </button>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">Autopay limit:</span>
                    <span className="font-medium text-foreground">
                      ${(savedEnvelope.autoagentpaylimit_cents / 100).toFixed(2)}
                    </span>
                  </div>
                </div>
              )}

              {/* Card Form (when no saved card, or editing) */}
              {showCardForm && (
                <>
                  {/* Autopay Limit */}
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-foreground">Autopay Limit ($)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="100.00"
                      value={autopayLimitDisplay}
                      onChange={(e) => setAutopayLimitDisplay(e.target.value)}
                      onBlur={handleAutopayBlur}
                      className={`${inputClass()} max-w-[160px]`}
                    />
                    <p className="text-xs text-muted-foreground">
                      Payments under this amount are auto-approved. Set to $0 to require approval for all.
                    </p>
                  </div>

                  {/* Card Information */}
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-foreground">Card Information</h3>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Card Number</label>
                      <div className="relative">
                        <input
                          placeholder="4111 1111 1111 1111"
                          value={paymentData.card_number}
                          onChange={(e) => handleCardNumber(e.target.value)}
                          maxLength={19}
                          disabled={saving}
                          className={`${inputClass('card_number')} pr-10`}
                        />
                        <div className="absolute right-2 top-1/2 -translate-y-1/2">
                          {CardIcons[currentCardType] || CardIcons.unknown}
                        </div>
                      </div>
                      {paymentErrors.card_number && (
                        <p className="text-xs text-red-500">{paymentErrors.card_number}</p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Cardholder Name</label>
                      <input
                        placeholder="John Doe"
                        value={paymentData.cardholder_name}
                        onChange={(e) => setPaymentData(prev => ({ ...prev, cardholder_name: e.target.value }))}
                        disabled={saving}
                        className={inputClass('cardholder_name')}
                      />
                      {paymentErrors.cardholder_name && (
                        <p className="text-xs text-red-500">{paymentErrors.cardholder_name}</p>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">Expiry Date</label>
                        <input
                          placeholder="MM/YY"
                          value={paymentData.card_expiry}
                          onChange={(e) => handleExpiry(e.target.value)}
                          maxLength={5}
                          disabled={saving}
                          className={inputClass('card_expiry')}
                        />
                        {paymentErrors.card_expiry && (
                          <p className="text-xs text-red-500">{paymentErrors.card_expiry}</p>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">CVV</label>
                        <input
                          placeholder={currentCardType === 'amex' ? '1234' : '123'}
                          value={paymentData.card_cvv}
                          onChange={(e) => handleCVV(e.target.value)}
                          maxLength={4}
                          type="password"
                          disabled={saving}
                          className={inputClass('card_cvv')}
                        />
                        {paymentErrors.card_cvv && (
                          <p className="text-xs text-red-500">{paymentErrors.card_cvv}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Billing Address */}
                  <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-foreground">Billing Address</h3>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Street Address</label>
                      <input
                        placeholder="123 Main Street"
                        value={paymentData.billing_street_address}
                        onChange={(e) => setPaymentData(prev => ({ ...prev, billing_street_address: e.target.value }))}
                        disabled={saving}
                        className={inputClass('billing_street_address')}
                      />
                      {paymentErrors.billing_street_address && (
                        <p className="text-xs text-red-500">{paymentErrors.billing_street_address}</p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Address Line 2 (Optional)</label>
                      <input
                        placeholder="Apt 4B, Suite 100, etc."
                        value={paymentData.billing_address_line2}
                        onChange={(e) => setPaymentData(prev => ({ ...prev, billing_address_line2: e.target.value }))}
                        disabled={saving}
                        className={inputClass()}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">City</label>
                        <input
                          placeholder="New York"
                          value={paymentData.billing_city}
                          onChange={(e) => setPaymentData(prev => ({ ...prev, billing_city: e.target.value }))}
                          disabled={saving}
                          className={inputClass('billing_city')}
                        />
                        {paymentErrors.billing_city && (
                          <p className="text-xs text-red-500">{paymentErrors.billing_city}</p>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">State</label>
                        <input
                          placeholder="NY"
                          value={paymentData.billing_state}
                          onChange={(e) => setPaymentData(prev => ({ ...prev, billing_state: e.target.value }))}
                          disabled={saving}
                          className={inputClass('billing_state')}
                        />
                        {paymentErrors.billing_state && (
                          <p className="text-xs text-red-500">{paymentErrors.billing_state}</p>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">ZIP Code</label>
                        <input
                          placeholder="10001"
                          value={paymentData.billing_zipcode}
                          onChange={(e) => setPaymentData(prev => ({ ...prev, billing_zipcode: e.target.value }))}
                          disabled={saving}
                          className={inputClass('billing_zipcode')}
                        />
                        {paymentErrors.billing_zipcode && (
                          <p className="text-xs text-red-500">{paymentErrors.billing_zipcode}</p>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">Country</label>
                        <input
                          placeholder="United States"
                          value={paymentData.billing_country}
                          onChange={(e) => setPaymentData(prev => ({ ...prev, billing_country: e.target.value }))}
                          disabled={saving}
                          className={inputClass('billing_country')}
                        />
                        {paymentErrors.billing_country && (
                          <p className="text-xs text-red-500">{paymentErrors.billing_country}</p>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}

              {/* Delivery Address */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-foreground">Delivery Address</h3>
                  {showCardForm && (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={sameAsBilling}
                        onChange={(e) => setSameAsBilling(e.target.checked)}
                        className="w-3.5 h-3.5 rounded border-border"
                      />
                      <span className="text-xs text-muted-foreground">Same as billing</span>
                    </label>
                  )}
                </div>

                {!sameAsBilling && (
                  <>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Full Name</label>
                      <input
                        placeholder="John Doe"
                        value={shippingAddress.name}
                        onChange={(e) => setShippingAddress(prev => ({ ...prev, name: e.target.value }))}
                        disabled={saving}
                        className={inputClass('shipping_name')}
                      />
                      {paymentErrors.shipping_name && (
                        <p className="text-xs text-red-500">{paymentErrors.shipping_name}</p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Street Address</label>
                      <input
                        placeholder="123 Main Street"
                        value={shippingAddress.addressLine1}
                        onChange={(e) => setShippingAddress(prev => ({ ...prev, addressLine1: e.target.value }))}
                        disabled={saving}
                        className={inputClass('shipping_addressLine1')}
                      />
                      {paymentErrors.shipping_addressLine1 && (
                        <p className="text-xs text-red-500">{paymentErrors.shipping_addressLine1}</p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground">Address Line 2 (Optional)</label>
                      <input
                        placeholder="Apt 4B, Suite 100, etc."
                        value={shippingAddress.addressLine2}
                        onChange={(e) => setShippingAddress(prev => ({ ...prev, addressLine2: e.target.value }))}
                        disabled={saving}
                        className={inputClass()}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">City</label>
                        <input
                          placeholder="New York"
                          value={shippingAddress.city}
                          onChange={(e) => setShippingAddress(prev => ({ ...prev, city: e.target.value }))}
                          disabled={saving}
                          className={inputClass('shipping_city')}
                        />
                        {paymentErrors.shipping_city && (
                          <p className="text-xs text-red-500">{paymentErrors.shipping_city}</p>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">State</label>
                        <input
                          placeholder="NY"
                          value={shippingAddress.state}
                          onChange={(e) => setShippingAddress(prev => ({ ...prev, state: e.target.value }))}
                          disabled={saving}
                          className={inputClass('shipping_state')}
                        />
                        {paymentErrors.shipping_state && (
                          <p className="text-xs text-red-500">{paymentErrors.shipping_state}</p>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">Postal Code</label>
                        <input
                          placeholder="10001"
                          value={shippingAddress.postalCode}
                          onChange={(e) => setShippingAddress(prev => ({ ...prev, postalCode: e.target.value }))}
                          disabled={saving}
                          className={inputClass('shipping_postalCode')}
                        />
                        {paymentErrors.shipping_postalCode && (
                          <p className="text-xs text-red-500">{paymentErrors.shipping_postalCode}</p>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-medium text-muted-foreground">Country</label>
                        <input
                          placeholder="United States"
                          value={shippingAddress.country}
                          onChange={(e) => setShippingAddress(prev => ({ ...prev, country: e.target.value }))}
                          disabled={saving}
                          className={inputClass('shipping_country')}
                        />
                        {paymentErrors.shipping_country && (
                          <p className="text-xs text-red-500">{paymentErrors.shipping_country}</p>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Error message */}
              {error && (
                <p className="text-sm text-red-500">{error}</p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!initialLoading && (
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-border bg-muted/30 shrink-0">
            <button
              onClick={handleClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium bg-foreground text-background rounded-lg hover:bg-foreground/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {saving ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {showCardForm ? 'Encrypting...' : 'Saving...'}
                </>
              ) : (
                showCardForm ? 'Save Payment' : 'Save'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentPayModal;
