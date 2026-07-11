import PhoneInput from '@/features/auth/components/PhoneInput';
import { TelegramIcon } from './TelegramIcon';

const PHONE_FIELD_CLASS =
  'w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]/50 disabled:opacity-50';

const PHONE_TRIGGER_CLASS =
  'flex h-full items-center gap-1 px-2.5 py-2 text-sm bg-surface border border-border rounded-lg';

interface PhoneStepProps {
  phoneNumber: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export const PhoneStep = ({
  phoneNumber,
  loading,
  onChange,
  onSubmit,
}: PhoneStepProps): JSX.Element => (
  <>
    <div className="flex justify-center mb-4">
      <TelegramIcon className="w-16 h-16" />
    </div>

    <p className="text-sm text-muted-foreground text-center mb-4">
      Enter your phone number to connect your Telegram account.
    </p>

    <div
      className="space-y-2"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !loading) {
          onSubmit();
        }
      }}
    >
      <label className="text-sm font-medium text-foreground">Phone Number</label>
      <PhoneInput
        value={phoneNumber}
        onChange={onChange}
        disabled={loading}
        inputClassName={PHONE_FIELD_CLASS}
        triggerClassName={PHONE_TRIGGER_CLASS}
      />
      <p className="text-xs text-muted-foreground">Pick your country code from the selector.</p>
    </div>
  </>
);
