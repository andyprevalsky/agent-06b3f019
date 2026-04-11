import { TabsContent } from '@/components/ui/tabs';
import type { CustomizationData } from '@/features/customization';
import type { PaymentData, EncryptedPaymentEnvelope } from '@/lib/encryption';

import type { UserData, ApiKey, UpgradeOption } from '../types';

import CustomizationTab from './CustomizationTab';
import PersonalInfoTab from './PersonalInfoTab';
import PaymentTab from './PaymentTab';
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
  payment: {
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
    savePaymentInfo: () => Promise<void>;
    handleCardNumber: (value: string) => void;
    handleExpiry: (value: string) => void;
    handleCVV: (value: string) => void;
    handleAutopayBlur: () => void;
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
}

export default function SettingsTabContent({
  data,
  personalInfo,
  customizationSave,
  payment,
  billing,
  apiKeysHook,
  handleFieldChange,
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

      <TabsContent value="payment">
        <PaymentTab
          showPaymentForm={payment.showPaymentForm}
          setShowPaymentForm={payment.setShowPaymentForm}
          paymentData={payment.paymentData}
          setPaymentData={payment.setPaymentData}
          paymentErrors={payment.paymentErrors}
          setPaymentErrors={payment.setPaymentErrors}
          savingPayment={payment.savingPayment}
          savedPayment={payment.savedPayment}
          autopayLimitDisplay={payment.autopayLimitDisplay}
          setAutopayLimitDisplay={payment.setAutopayLimitDisplay}
          savedPaymentEnvelope={payment.savedPaymentEnvelope}
          currentCardType={payment.currentCardType}
          onSave={() => void payment.savePaymentInfo()}
          onCardNumber={payment.handleCardNumber}
          onExpiry={payment.handleExpiry}
          onCVV={payment.handleCVV}
          onAutopayBlur={payment.handleAutopayBlur}
        />
      </TabsContent>

      <TabsContent value="billing">
        <BillingTab
          subscriptionTier={data.subscriptionTier}
          loadingBillingPortal={billing.loadingBillingPortal}
          onOpenBillingPortal={() => void billing.openBillingPortal()}
          subscribeUrl={billing.getSubscribeUrl()}
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
