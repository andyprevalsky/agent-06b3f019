/**
 * STATE MACHINE: Settings
 *
 *                    [LOADING]
 *                        |
 *                        v (loadSettings + loadSubscription + loadApiKeys)
 *         +---------[READY]----------------------------------------------+
 *         |              |               |               |               |
 *    [TAB:CUSTOM]  [TAB:INFO]    [TAB:PAYMENT]   [TAB:BILLING]    [TAB:KEYS]
 *         |              |               |               |               |
 *    (save custom) (save info)   (save payment)  (redirect to     (gen/del keys)
 *         |              |               |        Stripe portal)        |
 *         v              v               v               |               v
 *    [SAVING_CUST]  [SAVING]      [SAVING_PAY]          |        [SUBSCRIPTION_MODAL]
 *         |              |               |               |         (if no subscription)
 *         v              v               v               |               |
 *    [SAVED_CUST]   [SAVED]       [SAVED_PAY]           |         [Subscribe] → Stripe
 *         |              |               |               |               |
 *         +──────────────+───────────────+───────────────+───────────────+
 *                        |
 *                        v
 *                    [READY]
 *
 * States:
 * - loading: true → LOADING
 * - activeTab: 'customization' | 'info' | 'payment' | 'billing' | 'keys'
 * - saving: true → SAVING (personal info)
 * - saved: true → SAVED (success indicator)
 * - savingCustomization: true → SAVING_CUSTOMIZATION
 * - savedCustomization: true → customization saved success
 * - savingPayment: true → SAVING_PAYMENT
 * - savedPayment: true → payment saved success
 * - showSubscriptionModal: true → subscription required modal
 * - subscriptionTier: number | null
 * - apiKeys: array of user's API keys
 * - error: string | null (shown as banner)
 */

import { useState, useEffect } from 'react';
import { getStoredSession } from '../lib/supabase';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { Loader2, Save, Check, CreditCard, HelpCircle, Pencil, Key, Trash2, Plus, ExternalLink, Copy, Receipt, ShieldAlert, Sparkles } from 'lucide-react';
import SystemCustomization, { type CustomizationData } from '../components/customization/SystemCustomization';
import {
  encryptPaymentData,
  parsePaymentEnvelope,
  detectCardType,
  validateCardNumber,
  validateExpiry,
  validateCVV,
  type PaymentData,
  type EncryptedPaymentEnvelope,
} from '../lib/encryption';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../components/ui/tooltip';

const API_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const DOCS_URL = import.meta.env.DEV ? 'http://localhost:3002' : 'https://docs.roselabs.ai';

interface UserData {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  encryptedPaymentInformation: string | null;
}

interface ApiKey {
  id: string;
  name: string | null;
  maskedApiKey: string;
  createdAt: string;
}

interface UpgradeOption {
  tier: number;
  name: string;
  url: string;
}

// Card type icons as SVG components
const CardIcons: Record<string, React.ReactNode> = {
  visa: (
    <svg viewBox="0 0 24 24" className="w-8 h-8" fill="none">
      <rect width="24" height="24" rx="4" fill="#1A1F71"/>
      <path d="M9.5 15.5L10.5 8.5H12.5L11.5 15.5H9.5Z" fill="white"/>
      <path d="M16.5 8.7C16 8.5 15.2 8.3 14.2 8.3C12.2 8.3 10.8 9.3 10.8 10.8C10.8 11.9 11.8 12.5 12.6 12.9C13.4 13.3 13.7 13.5 13.7 13.9C13.7 14.4 13.1 14.7 12.5 14.7C11.7 14.7 11.2 14.5 10.5 14.2L10.2 14.1L9.9 16C10.5 16.3 11.5 16.5 12.5 16.5C14.6 16.5 16 15.5 16 13.9C16 13 15.5 12.3 14.4 11.8C13.7 11.4 13.2 11.2 13.2 10.7C13.2 10.3 13.6 9.9 14.5 9.9C15.2 9.9 15.8 10 16.2 10.2L16.4 10.3L16.5 8.7Z" fill="white"/>
      <path d="M19.5 8.5H18C17.5 8.5 17.1 8.7 16.9 9.2L14 15.5H16.1L16.5 14.3H19.1L19.3 15.5H21.2L19.5 8.5ZM17.1 12.7L18.1 10.1L18.7 12.7H17.1Z" fill="white"/>
      <path d="M8 8.5L6 13.5L5.8 12.5C5.4 11.2 4.2 9.8 2.8 9L4.6 15.5H6.8L10.2 8.5H8Z" fill="white"/>
    </svg>
  ),
  mastercard: (
    <svg viewBox="0 0 24 24" className="w-8 h-8" fill="none">
      <rect width="24" height="24" rx="4" fill="#000"/>
      <circle cx="9" cy="12" r="5" fill="#EB001B"/>
      <circle cx="15" cy="12" r="5" fill="#F79E1B"/>
      <path d="M12 8.5C13.1 9.4 13.8 10.6 13.8 12C13.8 13.4 13.1 14.6 12 15.5C10.9 14.6 10.2 13.4 10.2 12C10.2 10.6 10.9 9.4 12 8.5Z" fill="#FF5F00"/>
    </svg>
  ),
  amex: (
    <svg viewBox="0 0 24 24" className="w-8 h-8" fill="none">
      <rect width="24" height="24" rx="4" fill="#006FCF"/>
      <path d="M3 12L5 8H7L9 12L7 16H5L3 12Z" fill="white"/>
      <path d="M9 8H13V10H11V11H13V13H11V14H13V16H9V8Z" fill="white"/>
      <path d="M14 8H16L17.5 11L19 8H21L18.5 12L21 16H19L17.5 13L16 16H14L16.5 12L14 8Z" fill="white"/>
    </svg>
  ),
  discover: (
    <svg viewBox="0 0 24 24" className="w-8 h-8" fill="none">
      <rect width="24" height="24" rx="4" fill="#FF6000"/>
      <circle cx="12" cy="12" r="4" fill="white"/>
      <path d="M4 10H6V14H4V10Z" fill="white"/>
      <path d="M18 10H20V14H18V10Z" fill="white"/>
    </svg>
  ),
  unknown: (
    <CreditCard className="w-8 h-8 text-muted-foreground" />
  ),
};

export default function Settings() {
  // Tab state
  const [activeTab, setActiveTab] = useState('customization');

  // Customization state
  const [customization, setCustomization] = useState<CustomizationData>({
    systemName: 'Rose',
    profilePicture: null,
    customSystemPrompt: '',
  });
  const [savingCustomization, setSavingCustomization] = useState(false);
  const [savedCustomization, setSavedCustomization] = useState(false);

  // User data state
  const [userData, setUserData] = useState<UserData>({
    name: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'United States',
    encryptedPaymentInformation: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Payment form state
  const [showPaymentForm, setShowPaymentForm] = useState(false);
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
  const [savingPayment, setSavingPayment] = useState(false);
  const [savedPayment, setSavedPayment] = useState(false);
  const [autopayLimitDisplay, setAutopayLimitDisplay] = useState('100.00');
  const [savedPaymentEnvelope, setSavedPaymentEnvelope] = useState<EncryptedPaymentEnvelope | null>(null);

  // Subscription state
  const [subscriptionTier, setSubscriptionTier] = useState<number | null>(null);
  const [upgradeOptions, setUpgradeOptions] = useState<UpgradeOption[]>([]);
  const [loadingBillingPortal, setLoadingBillingPortal] = useState(false);

  // API Keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [generatingKey, setGeneratingKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [showNewKeyForm, setShowNewKeyForm] = useState(false);
  const [newlyGeneratedKey, setNewlyGeneratedKey] = useState<string | null>(null);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);

  // Get userId from session
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const session = getStoredSession();
    if (session?.user?.id) {
      setUserId(session.user.id);
    }
    loadSettings();
    loadSubscription();
    loadApiKeys();
  }, []);

  useEffect(() => {
    if (userData.encryptedPaymentInformation) {
      const envelope = parsePaymentEnvelope(userData.encryptedPaymentInformation);
      setSavedPaymentEnvelope(envelope);
      if (envelope) {
        setAutopayLimitDisplay((envelope.autoagentpaylimit_cents / 100).toFixed(2));
        setPaymentData(prev => ({ ...prev, autoagentpaylimit_cents: envelope.autoagentpaylimit_cents }));
      }
    } else {
      setSavedPaymentEnvelope(null);
    }
  }, [userData.encryptedPaymentInformation]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError(null);

      const session = getStoredSession();
      if (!session) {
        setError('Not authenticated');
        return;
      }

      const response = await fetch(`${API_URL}/api/user-settings`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to load settings');
      }

      const data = await response.json();
      setUserData({
        name: data.name || '',
        addressLine1: data.addressLine1 || '',
        addressLine2: data.addressLine2 || '',
        city: data.city || '',
        state: data.state || '',
        postalCode: data.postalCode || '',
        country: data.country || 'United States',
        encryptedPaymentInformation: data.encryptedPaymentInformation || null,
      });
      // Load customization data
      setCustomization({
        systemName: data.systemName || 'Rose',
        profilePicture: data.profilePicture || null,
        customSystemPrompt: data.customSystemPrompt || '',
      });
    } catch (err) {
      console.error('Failed to load settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const loadSubscription = async () => {
    try {
      const session = getStoredSession();
      if (!session) return;

      const response = await fetch(`${API_URL}/api/credits/subscription`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setSubscriptionTier(data.tier);
        setUpgradeOptions(data.upgradeOptions || []);
      }
    } catch (err) {
      console.error('Failed to load subscription:', err);
    }
  };

  const loadApiKeys = async () => {
    try {
      setLoadingKeys(true);
      const session = getStoredSession();
      if (!session) return;

      const response = await fetch(`${API_URL}/api/api-keys`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setApiKeys(data.keys || []);
      }
    } catch (err) {
      console.error('Failed to load API keys:', err);
    } finally {
      setLoadingKeys(false);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      setError(null);
      setSaved(false);

      const session = getStoredSession();
      if (!session) {
        setError('Not authenticated');
        return;
      }

      const response = await fetch(`${API_URL}/api/user-settings`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: userData.name,
          addressLine1: userData.addressLine1,
          addressLine2: userData.addressLine2,
          city: userData.city,
          state: userData.state,
          postalCode: userData.postalCode,
          country: userData.country,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save settings');
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const saveCustomization = async () => {
    try {
      setSavingCustomization(true);
      setError(null);
      setSavedCustomization(false);

      const session = getStoredSession();
      if (!session) {
        setError('Not authenticated');
        return;
      }

      const response = await fetch(`${API_URL}/api/user-settings`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          systemName: customization.systemName || null,
          profilePicture: customization.profilePicture || null,
          customSystemPrompt: customization.customSystemPrompt || null,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save customization');
      }

      setSavedCustomization(true);
      setTimeout(() => setSavedCustomization(false), 3000);
    } catch (err) {
      console.error('Failed to save customization:', err);
      setError(err instanceof Error ? err.message : 'Failed to save customization');
    } finally {
      setSavingCustomization(false);
    }
  };

  const validatePaymentForm = (): boolean => {
    const errors: Record<string, string> = {};

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

    if (paymentData.billing_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(paymentData.billing_email)) {
      errors.billing_email = 'Invalid email format';
    }

    if (paymentData.autoagentpaylimit_cents < 0) {
      errors.autoagentpaylimit_cents = 'Must be 0 or greater';
    }

    setPaymentErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const savePaymentInfo = async () => {
    const dollars = parseFloat(autopayLimitDisplay) || 0;
    const cents = Math.round(dollars * 100);
    const dataToSave = { ...paymentData, autoagentpaylimit_cents: cents };

    if (!validatePaymentForm()) {
      return;
    }

    try {
      setSavingPayment(true);
      setError(null);
      setSavedPayment(false);

      const session = getStoredSession();
      if (!session) {
        setError('Not authenticated');
        return;
      }

      const encryptedData = await encryptPaymentData(dataToSave);

      const response = await fetch(`${API_URL}/api/user-settings`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          encryptedPaymentInformation: encryptedData,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save payment information');
      }

      const data = await response.json();
      setUserData(prev => ({
        ...prev,
        encryptedPaymentInformation: data.encryptedPaymentInformation,
      }));

      setSavedPayment(true);
      setShowPaymentForm(false);

      const newAutopayLimit = cents;
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
        autoagentpaylimit_cents: newAutopayLimit,
      });
      setAutopayLimitDisplay((newAutopayLimit / 100).toFixed(2));
      setPaymentErrors({});

      setTimeout(() => setSavedPayment(false), 3000);
    } catch (err) {
      console.error('Failed to save payment info:', err);
      setError(err instanceof Error ? err.message : 'Failed to save payment information');
    } finally {
      setSavingPayment(false);
    }
  };

  const openBillingPortal = async () => {
    try {
      setLoadingBillingPortal(true);
      const session = getStoredSession();
      if (!session) {
        setError('Not authenticated');
        return;
      }

      const response = await fetch(`${API_URL}/api/billing/portal`, {
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const data = await response.json();
        if (response.status === 404) {
          // No subscription - show subscribe options
          setError(data.message || 'You need an active subscription to access the billing portal.');
          return;
        }
        throw new Error('Failed to open billing portal');
      }

      const data = await response.json();
      window.open(data.url, '_blank');
    } catch (err) {
      console.error('Failed to open billing portal:', err);
      setError(err instanceof Error ? err.message : 'Failed to open billing portal');
    } finally {
      setLoadingBillingPortal(false);
    }
  };

  const handleGenerateKeyClick = () => {
    if (subscriptionTier === null) {
      setShowSubscriptionModal(true);
    } else {
      setShowNewKeyForm(true);
    }
  };

  const generateApiKey = async () => {
    try {
      setGeneratingKey(true);
      const session = getStoredSession();
      if (!session) return;

      const response = await fetch(`${API_URL}/api/api-keys`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: newKeyName || null }),
      });

      if (response.ok) {
        const data = await response.json();
        setNewlyGeneratedKey(data.apiKey);
        setNewKeyName('');
        setShowNewKeyForm(false);
        await loadApiKeys();
      } else {
        const data = await response.json();
        setError(data.error || 'Failed to generate API key');
      }
    } catch (err) {
      console.error('Failed to generate API key:', err);
      setError('Failed to generate API key');
    } finally {
      setGeneratingKey(false);
    }
  };

  const deleteApiKey = async (keyId: string) => {
    try {
      setDeletingKeyId(keyId);
      const session = getStoredSession();
      if (!session) return;

      await fetch(`${API_URL}/api/api-keys/${keyId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      await loadApiKeys();
    } catch (err) {
      console.error('Failed to delete API key:', err);
    } finally {
      setDeletingKeyId(null);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const getSubscribeUrl = () => {
    if (upgradeOptions.length > 0 && userId) {
      return `${upgradeOptions[0].url}?client_reference_id=${userId}`;
    }
    return null;
  };

  // Card input handlers
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

  const currentCardType = detectCardType(paymentData.card_number);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto pt-20">
      <div className="container max-w-3xl mx-auto py-12 px-4 space-y-6">
        <div className="mb-8 backdrop-blur-md bg-background/80 p-6 rounded-xl border border-border/50 dark:border-navi-light-light-black/50">
          <h1 className="text-4xl font-bold mb-2">Settings</h1>
          <p className="text-muted-foreground">
            Manage your account settings and preferences
          </p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive rounded-lg text-destructive">
            {error}
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="customization">Customization</TabsTrigger>
            <TabsTrigger value="info">Personal Info</TabsTrigger>
            <TabsTrigger value="payment">Agent Payment</TabsTrigger>
            <TabsTrigger value="billing">Billing</TabsTrigger>
            <TabsTrigger value="keys">API Keys</TabsTrigger>
          </TabsList>

          {/* Customization Tab */}
          <TabsContent value="customization">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5" />
                  Customize Your Assistant
                </CardTitle>
                <CardDescription>
                  Personalize your AI assistant's name, appearance, and personality
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <SystemCustomization
                  data={customization}
                  onChange={setCustomization}
                  isLoading={loading || savingCustomization}
                />

                <div className="flex gap-4 pt-4 border-t">
                  <Button onClick={saveCustomization} disabled={savingCustomization} className="min-w-[160px]">
                    {savingCustomization ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : savedCustomization ? (
                      <>
                        <Check className="w-4 h-4 mr-2" />
                        Saved!
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4 mr-2" />
                        Save Customization
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Personal Information Tab */}
          <TabsContent value="info">
            <Card>
              <CardHeader>
                <CardTitle>Personal Information</CardTitle>
                <CardDescription>
                  Your information used when purchasing items through your agents
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="name">Full Name</Label>
                  <Input
                    id="name"
                    placeholder="John Doe"
                    value={userData.name}
                    onChange={(e) => setUserData({ ...userData, name: e.target.value })}
                  />
                </div>

                <div className="space-y-4">
                  <h3 className="text-lg font-semibold">Delivery Address</h3>

                  <div className="space-y-2">
                    <Label htmlFor="addressLine1">Address Line 1</Label>
                    <Input
                      id="addressLine1"
                      placeholder="123 Main Street"
                      value={userData.addressLine1}
                      onChange={(e) => setUserData({ ...userData, addressLine1: e.target.value })}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="addressLine2">Address Line 2 (Optional)</Label>
                    <Input
                      id="addressLine2"
                      placeholder="Apt 4B, Suite 100, etc."
                      value={userData.addressLine2}
                      onChange={(e) => setUserData({ ...userData, addressLine2: e.target.value })}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="city">City</Label>
                      <Input
                        id="city"
                        placeholder="New York"
                        value={userData.city}
                        onChange={(e) => setUserData({ ...userData, city: e.target.value })}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="state">State</Label>
                      <Input
                        id="state"
                        placeholder="NY"
                        value={userData.state}
                        onChange={(e) => setUserData({ ...userData, state: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="postalCode">Postal Code</Label>
                      <Input
                        id="postalCode"
                        placeholder="10001"
                        value={userData.postalCode}
                        onChange={(e) => setUserData({ ...userData, postalCode: e.target.value })}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="country">Country</Label>
                      <Input
                        id="country"
                        placeholder="United States"
                        value={userData.country}
                        onChange={(e) => setUserData({ ...userData, country: e.target.value })}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex gap-4 pt-4">
                  <Button onClick={saveSettings} disabled={saving} className="min-w-[120px]">
                    {saving ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : saved ? (
                      <>
                        <Check className="w-4 h-4 mr-2" />
                        Saved!
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4 mr-2" />
                        Save Settings
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Agent Payment Tab */}
          <TabsContent value="payment">
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
                {/* Security Notice */}
                <div className="p-4 bg-amber-500/10 border border-amber-500/50 rounded-lg flex items-start gap-3">
                  <ShieldAlert className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      <span className="font-medium">All card credentials are end-to-end encrypted.</span>{' '}
                      We recommend creating a separate card for your agent to manage spend (takes &lt; 2 min).
                    </p>
                    <Button
                      size="sm"
                      className="bg-black text-white hover:bg-black/80"
                      asChild
                    >
                      <a href="https://privacy.com" target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-3 h-3 mr-2" />
                        Create Card via Privacy.com
                      </a>
                    </Button>
                  </div>
                </div>

                {/* Saved Payment Display */}
                {savedPaymentEnvelope && !showPaymentForm && (
                  <div className="p-4 border rounded-lg bg-muted/30 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {CardIcons[savedPaymentEnvelope.card_type] || CardIcons.unknown}
                        <div>
                          <p className="font-medium">
                            **** **** **** {savedPaymentEnvelope.card_last_four}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {savedPaymentEnvelope.billing_city}, {savedPaymentEnvelope.billing_country}
                          </p>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => setShowPaymentForm(true)}>
                        <Pencil className="w-4 h-4 mr-2" />
                        Edit
                      </Button>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Autopay limit:</span>
                      <span className="font-medium">
                        ${(savedPaymentEnvelope.autoagentpaylimit_cents / 100).toFixed(2)}
                      </span>
                      {savedPaymentEnvelope.autoagentpaylimit_cents === 0 && (
                        <span className="text-muted-foreground">(disabled - all payments require approval)</span>
                      )}
                    </div>
                  </div>
                )}

                {/* Payment Form */}
                {(showPaymentForm || !savedPaymentEnvelope) && (
                  <div className="space-y-6">
                    {/* Autopay Limit */}
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
                                Payments under this amount will be automatically approved.
                                Payments over this amount will require your approval.
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
                        onBlur={handleAutopayBlur}
                        className="max-w-[200px]"
                      />
                      {paymentErrors.autoagentpaylimit_cents && (
                        <p className="text-sm text-destructive">{paymentErrors.autoagentpaylimit_cents}</p>
                      )}
                      <p className="text-sm text-muted-foreground">
                        Set to $0 to require approval for all payments
                      </p>
                    </div>

                    {/* Card Information */}
                    <div className="space-y-4">
                      <h3 className="text-lg font-semibold">Card Information</h3>

                      <div className="space-y-2">
                        <Label htmlFor="cardNumber">Card Number</Label>
                        <div className="relative">
                          <Input
                            id="cardNumber"
                            placeholder="4111 1111 1111 1111"
                            value={paymentData.card_number}
                            onChange={(e) => handleCardNumber(e.target.value)}
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
                          onChange={(e) => setPaymentData(prev => ({ ...prev, cardholder_name: e.target.value }))}
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
                            onChange={(e) => handleExpiry(e.target.value)}
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
                            onChange={(e) => handleCVV(e.target.value)}
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

                    {/* Billing Address */}
                    <div className="space-y-4">
                      <h3 className="text-lg font-semibold">Billing Address</h3>

                      <div className="space-y-2">
                        <Label htmlFor="billingStreet">Street Address</Label>
                        <Input
                          id="billingStreet"
                          placeholder="123 Main Street"
                          value={paymentData.billing_street_address}
                          onChange={(e) => setPaymentData(prev => ({ ...prev, billing_street_address: e.target.value }))}
                          className={paymentErrors.billing_street_address ? 'border-destructive' : ''}
                        />
                        {paymentErrors.billing_street_address && (
                          <p className="text-sm text-destructive">{paymentErrors.billing_street_address}</p>
                        )}
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="billingLine2">Address Line 2 (Optional)</Label>
                        <Input
                          id="billingLine2"
                          placeholder="Apt 4B, Suite 100, etc."
                          value={paymentData.billing_address_line2}
                          onChange={(e) => setPaymentData(prev => ({ ...prev, billing_address_line2: e.target.value }))}
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="billingCity">City</Label>
                          <Input
                            id="billingCity"
                            placeholder="New York"
                            value={paymentData.billing_city}
                            onChange={(e) => setPaymentData(prev => ({ ...prev, billing_city: e.target.value }))}
                            className={paymentErrors.billing_city ? 'border-destructive' : ''}
                          />
                          {paymentErrors.billing_city && (
                            <p className="text-sm text-destructive">{paymentErrors.billing_city}</p>
                          )}
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="billingState">State</Label>
                          <Input
                            id="billingState"
                            placeholder="NY"
                            value={paymentData.billing_state}
                            onChange={(e) => setPaymentData(prev => ({ ...prev, billing_state: e.target.value }))}
                            className={paymentErrors.billing_state ? 'border-destructive' : ''}
                          />
                          {paymentErrors.billing_state && (
                            <p className="text-sm text-destructive">{paymentErrors.billing_state}</p>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="billingZip">ZIP Code</Label>
                          <Input
                            id="billingZip"
                            placeholder="10001"
                            value={paymentData.billing_zipcode}
                            onChange={(e) => setPaymentData(prev => ({ ...prev, billing_zipcode: e.target.value }))}
                            className={paymentErrors.billing_zipcode ? 'border-destructive' : ''}
                          />
                          {paymentErrors.billing_zipcode && (
                            <p className="text-sm text-destructive">{paymentErrors.billing_zipcode}</p>
                          )}
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="billingCountry">Country</Label>
                          <Input
                            id="billingCountry"
                            placeholder="United States"
                            value={paymentData.billing_country}
                            onChange={(e) => setPaymentData(prev => ({ ...prev, billing_country: e.target.value }))}
                            className={paymentErrors.billing_country ? 'border-destructive' : ''}
                          />
                          {paymentErrors.billing_country && (
                            <p className="text-sm text-destructive">{paymentErrors.billing_country}</p>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label htmlFor="billingPhone">Phone (Optional)</Label>
                          <Input
                            id="billingPhone"
                            placeholder="+1 555-123-4567"
                            value={paymentData.billing_phone}
                            onChange={(e) => setPaymentData(prev => ({ ...prev, billing_phone: e.target.value }))}
                          />
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="billingEmail">Email (Optional)</Label>
                          <Input
                            id="billingEmail"
                            placeholder="john@example.com"
                            type="email"
                            value={paymentData.billing_email}
                            onChange={(e) => setPaymentData(prev => ({ ...prev, billing_email: e.target.value }))}
                            className={paymentErrors.billing_email ? 'border-destructive' : ''}
                          />
                          {paymentErrors.billing_email && (
                            <p className="text-sm text-destructive">{paymentErrors.billing_email}</p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Save Button */}
                    <div className="flex gap-4 pt-4">
                      <Button onClick={savePaymentInfo} disabled={savingPayment} className="min-w-[160px]">
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
                        <Button
                          variant="outline"
                          onClick={() => {
                            setShowPaymentForm(false);
                            setPaymentErrors({});
                          }}
                        >
                          Cancel
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Billing Tab */}
          <TabsContent value="billing">
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
                      <Button onClick={openBillingPortal} disabled={loadingBillingPortal}>
                        {loadingBillingPortal ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <ExternalLink className="w-4 h-4 mr-2" />
                        )}
                        Manage Subscription
                      </Button>
                    ) : (
                      <Button asChild>
                        <a href={getSubscribeUrl() || '#'} target="_blank" rel="noopener noreferrer">
                          Subscribe
                        </a>
                      </Button>
                    )}
                  </div>
                </div>

                <p className="text-sm text-muted-foreground">
                  {subscriptionTier
                    ? 'Click "Manage Subscription" to update your payment method, change your plan, view invoices, or cancel your subscription.'
                    : 'Subscribe to unlock API access and additional features.'}
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* API Keys Tab */}
          <TabsContent value="keys">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Key className="w-5 h-5" />
                  Rose API Keys
                </CardTitle>
                <CardDescription>
                  API keys for accessing the Rose completions API
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {loadingKeys ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin" />
                  </div>
                ) : (
                  <>
                    {/* Newly generated key alert */}
                    {newlyGeneratedKey && (
                      <div className="p-4 bg-green-500/10 border border-green-500 rounded-lg space-y-3">
                        <p className="text-sm font-medium text-green-600 dark:text-green-400">
                          New API key generated! Copy it now - you won't see it again.
                        </p>
                        <code className="block p-3 bg-muted rounded text-sm font-mono break-all">
                          {newlyGeneratedKey}
                        </code>
                        <Button
                          size="sm"
                          onClick={() => {
                            copyToClipboard(newlyGeneratedKey);
                            setNewlyGeneratedKey(null);
                          }}
                        >
                          <Copy className="w-4 h-4 mr-2" />
                          Copy & Dismiss
                        </Button>
                      </div>
                    )}

                    {/* Key list */}
                    {apiKeys.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-4">
                        No API keys yet. Generate one to start using the Rose API.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {apiKeys.map((key) => (
                          <div
                            key={key.id}
                            className="flex items-center justify-between p-3 border rounded-lg"
                          >
                            <div>
                              <p className="font-medium">{key.name || 'Unnamed'}</p>
                              <p className="text-sm text-muted-foreground font-mono">
                                {key.maskedApiKey}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Created {new Date(key.createdAt).toLocaleDateString()}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => deleteApiKey(key.id)}
                              disabled={deletingKeyId === key.id}
                            >
                              {deletingKeyId === key.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Trash2 className="w-4 h-4 text-destructive" />
                              )}
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Generate new key */}
                    {showNewKeyForm ? (
                      <div className="space-y-3 pt-2 border-t">
                        <Input
                          placeholder="Key name (optional)"
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value)}
                        />
                        <div className="flex gap-2">
                          <Button onClick={generateApiKey} disabled={generatingKey}>
                            {generatingKey ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : null}
                            Generate
                          </Button>
                          <Button variant="outline" onClick={() => setShowNewKeyForm(false)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button variant="outline" onClick={handleGenerateKeyClick} className="w-full">
                        <Plus className="w-4 h-4 mr-2" />
                        Generate New Key
                      </Button>
                    )}

                    {/* Docs link */}
                    <div className="pt-4 border-t">
                      <a
                        href={DOCS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-primary hover:underline flex items-center gap-1"
                      >
                        <ExternalLink className="w-4 h-4" />
                        View API Documentation
                      </a>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Subscription Required Modal */}
        <Dialog open={showSubscriptionModal} onOpenChange={setShowSubscriptionModal}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Subscription Required</DialogTitle>
              <DialogDescription>
                API access requires an active subscription to Rose Labs.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowSubscriptionModal(false)}>
                Cancel
              </Button>
              <Button asChild>
                <a href={getSubscribeUrl() || '#'} target="_blank" rel="noopener noreferrer">
                  Subscribe
                </a>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
