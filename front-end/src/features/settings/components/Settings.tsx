/**
 * STATE MACHINE: Settings
 *
 *                    [LOADING]
 *                        |
 *                        v (loadSettings + loadSubscription + loadApiKeys)
 *         +---------[READY]------------------------------+
 *         |              |               |               |
 *    [TAB:CUSTOM]  [TAB:INFO]    [TAB:BILLING]    [TAB:KEYS]
 *         |              |               |               |
 *    (save custom) (save personal + delivery) (redirect) (gen/del keys)
 *         |              |        Stripe portal)        |
 *         v              v               |               v
 *    [SAVING_CUST]  [SAVING]            |        [SUBSCRIPTION_MODAL]
 *         |              |               |         (if no subscription)
 *         v              v               |               |
 *    [SAVED_CUST]   [SAVED]             |         [Subscribe] -> Stripe
 *         |              |               |               |
 *         +──────────────+───────────────+───────────────+
 *                        |
 *                        v
 *                    [READY]
 *
 * States:
 * - loading: true -> LOADING
 * - activeTab: 'customization' | 'info' | 'billing' | 'keys'
 * - saving: true -> SAVING (personal info)
 * - saved: true -> SAVED (success indicator)
 * - savingCustomization: true -> SAVING_CUSTOMIZATION
 * - savedCustomization: true -> customization saved success
 * - showSubscriptionModal: true -> subscription required modal
 * - subscriptionTier: number | null
 * - apiKeys: array of user's API keys
 * - error: string | null (shown as banner)
 *
 * Props: embedded (Rose Desktop account panel beside the left bar: no page
 * padding) and billingExtra (rendered under Current Plan in the Billing tab).
 * The stock page passes neither, so it renders unchanged.
 */

import { useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

import type { UserData } from '../types';
import {
  useSettingsData,
  useSavePersonalInfo,
  useSaveCustomization,
  useBilling,
  useApiKeys,
} from '../hooks';

import SettingsTabContent from './SettingsTabContent';
import SubscriptionModal from './SubscriptionModal';

interface SettingsProps {
  /** Rendered inside a panel (Rose Desktop account settings): no page padding. */
  embedded?: boolean;
  /** Extra Billing content below the Current Plan block (Rose Desktop payments). */
  billingExtra?: React.ReactNode;
}

export default function Settings({ embedded = false, billingExtra }: SettingsProps = {}) {
  const [activeTab, setActiveTab] = useState('customization');
  const data = useSettingsData();
  const personalInfo = useSavePersonalInfo(data.userData, data.setError);
  const customizationSave = useSaveCustomization(data.customization, data.setError);
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
    <div className={embedded ? 'h-full' : 'h-full overflow-y-auto pt-20'}>
      <div className={embedded ? 'space-y-6' : 'container max-w-3xl mx-auto py-12 px-4 space-y-6'}>
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
          <TabsList className="flex w-full overflow-x-auto">
            <TabsTrigger value="customization" className="flex-shrink-0 text-xs sm:text-sm">
              Customization
            </TabsTrigger>
            <TabsTrigger value="info" className="flex-shrink-0 text-xs sm:text-sm">
              Personal Info
            </TabsTrigger>
            <TabsTrigger value="billing" className="flex-shrink-0 text-xs sm:text-sm">
              Billing
            </TabsTrigger>
            <TabsTrigger value="keys" className="flex-shrink-0 text-xs sm:text-sm">
              API Keys
            </TabsTrigger>
          </TabsList>

          <SettingsTabContent
            data={data}
            personalInfo={personalInfo}
            customizationSave={customizationSave}
            billing={billing}
            apiKeysHook={apiKeysHook}
            handleFieldChange={handleFieldChange}
            billingExtra={billingExtra}
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
