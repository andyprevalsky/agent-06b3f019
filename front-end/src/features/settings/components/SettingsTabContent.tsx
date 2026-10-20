import { TabsContent } from '@/components/ui/tabs';
import type { CustomizationData } from '@/features/customization';

import type { UserData, ApiKey, UpgradeOption } from '../types';

import CustomizationTab from './CustomizationTab';
import PersonalInfoTab from './PersonalInfoTab';
import BillingTab from './BillingTab';
import ApiKeysTab from './ApiKeysTab';

interface SettingsTabContentProps {
  data: {
    loading: boolean;
    userData: UserData;
    customization: CustomizationData;
    setCustomization: React.Dispatch<React.SetStateAction<CustomizationData>>;
    subscriptionTier: number | null;
    upgradeOptions: UpgradeOption[];
    apiKeys: ApiKey[];
    loadingKeys: boolean;
  };
  personalInfo: {
    saving: boolean;
    saved: boolean;
    saveSettings: () => Promise<void>;
  };
  customizationSave: {
    savingCustomization: boolean;
    savedCustomization: boolean;
    saveCustomization: () => Promise<void>;
  };
  billing: {
    loadingBillingPortal: boolean;
    openBillingPortal: () => Promise<void>;
    getSubscribeUrl: () => string | null;
  };
  apiKeysHook: {
    generatingKey: boolean;
    newKeyName: string;
    setNewKeyName: (v: string) => void;
    showNewKeyForm: boolean;
    setShowNewKeyForm: (v: boolean) => void;
    newlyGeneratedKey: string | null;
    setNewlyGeneratedKey: (v: string | null) => void;
    deletingKeyId: string | null;
    handleGenerateKeyClick: () => void;
    generateApiKey: () => Promise<void>;
    deleteApiKey: (keyId: string) => Promise<void>;
    copyToClipboard: (text: string) => void;
  };
  handleFieldChange: (field: keyof UserData, value: string) => void;
  /** Optional Billing content below the Current Plan block. */
  billingExtra?: React.ReactNode;
}

export default function SettingsTabContent({
  data,
  personalInfo,
  customizationSave,
  billing,
  apiKeysHook,
  handleFieldChange,
  billingExtra,
}: SettingsTabContentProps) {
  return (
    <>
      <TabsContent value="customization">
        <CustomizationTab
          customization={data.customization}
          onCustomizationChange={data.setCustomization}
          loading={data.loading}
          savingCustomization={customizationSave.savingCustomization}
          savedCustomization={customizationSave.savedCustomization}
          onSave={() => void customizationSave.saveCustomization()}
        />
      </TabsContent>

      <TabsContent value="info">
        <PersonalInfoTab
          userData={data.userData}
          onFieldChange={handleFieldChange}
          saving={personalInfo.saving}
          saved={personalInfo.saved}
          onSave={() => void personalInfo.saveSettings()}
        />
      </TabsContent>

      <TabsContent value="billing">
        <BillingTab
          subscriptionTier={data.subscriptionTier}
          loadingBillingPortal={billing.loadingBillingPortal}
          onOpenBillingPortal={() => void billing.openBillingPortal()}
          subscribeUrl={billing.getSubscribeUrl()}
          extra={billingExtra}
        />
      </TabsContent>

      <TabsContent value="keys">
        <ApiKeysTab
          loadingKeys={data.loadingKeys}
          apiKeys={data.apiKeys}
          newlyGeneratedKey={apiKeysHook.newlyGeneratedKey}
          setNewlyGeneratedKey={apiKeysHook.setNewlyGeneratedKey}
          showNewKeyForm={apiKeysHook.showNewKeyForm}
          setShowNewKeyForm={apiKeysHook.setShowNewKeyForm}
          newKeyName={apiKeysHook.newKeyName}
          setNewKeyName={apiKeysHook.setNewKeyName}
          generatingKey={apiKeysHook.generatingKey}
          deletingKeyId={apiKeysHook.deletingKeyId}
          onGenerateKeyClick={apiKeysHook.handleGenerateKeyClick}
          onGenerateApiKey={() => void apiKeysHook.generateApiKey()}
          onDeleteApiKey={(keyId) => void apiKeysHook.deleteApiKey(keyId)}
          onCopyToClipboard={apiKeysHook.copyToClipboard}
        />
      </TabsContent>
    </>
  );
}
