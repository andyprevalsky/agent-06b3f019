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
 *    [SAVED_CUST]   [SAVED]       [SAVED_PAY]           |         [Subscribe] -> Stripe
 *         |              |               |               |               |
 *         +──────────────+───────────────+───────────────+───────────────+
 *                        |
 *                        v
 *                    [READY]
 *
 * States:
 * - loading: true -> LOADING
 * - activeTab: 'customization' | 'info' | 'payment' | 'billing' | 'keys'
 * - saving: true -> SAVING (personal info)
 * - saved: true -> SAVED (success indicator)
 * - savingCustomization: true -> SAVING_CUSTOMIZATION
 * - savedCustomization: true -> customization saved success
 * - savingPayment: true -> SAVING_PAYMENT
 * - savedPayment: true -> payment saved success
 * - showSubscriptionModal: true -> subscription required modal
 * - subscriptionTier: number | null
 * - apiKeys: array of user's API keys
 * - error: string | null (shown as banner)
 */

import { useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import type { UserData } from '../types';
import {
  useSettingsData,
  useSavePersonalInfo,
  useSaveCustomization,
  usePayment,
  useBilling,
  useApiKeys,
} from '../hooks';

import SettingsTabContent from './SettingsTabContent';
import SubscriptionModal from './SubscriptionModal';

export default function Settings() {
  const [activeTab, setActiveTab] = useState('customization');
  const data = useSettingsData();
  const personalInfo = useSavePersonalInfo(data.userData, data.setError);
  const customizationSave = useSaveCustomization(data.customization, data.setError);
  const payment = usePayment(data.userData, data.setUserData, data.setError);
  const billing = useBilling(data.userId, data.upgradeOptions, data.setError);
  const apiKeysHook = useApiKeys(data.subscriptionTier, data.reloadApiKeys, data.setError);

  const { setUserData } = data;
  const handleFieldChange = useCallback(
    (field: keyof UserData, value: string) => {
      setUserData((prev) => ({ ...prev, [field]: value }));
    },
    [setUserData],
  );

  if (data.loading) {
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
          <p className="text-muted-foreground">Manage your account settings and preferences</p>
        </div>

        {data.error && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive rounded-lg text-destructive">
            {data.error}
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

          <SettingsTabContent
            data={data}
            personalInfo={personalInfo}
            customizationSave={customizationSave}
            payment={payment}
            billing={billing}
            apiKeysHook={apiKeysHook}
            handleFieldChange={handleFieldChange}
          />
        </Tabs>

        <SubscriptionModal
          open={apiKeysHook.showSubscriptionModal}
          onOpenChange={apiKeysHook.setShowSubscriptionModal}
          subscribeUrl={billing.getSubscribeUrl()}
        />
      </div>
    </div>
  );
}
