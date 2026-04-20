import { PHONE_INPUT_PLACEHOLDER } from '../config';
import { TelegramIcon } from './TelegramIcon';

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

    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground">Phone Number</label>
      <input
        type="tel"
        value={phoneNumber}
        onChange={(e) => onChange(e.target.value)}
        placeholder={PHONE_INPUT_PLACEHOLDER}
        disabled={loading}
        className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]/50 disabled:opacity-50"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !loading) {
            onSubmit();
          }
        }}
      />
      <p className="text-xs text-muted-foreground">Include your country code (e.g., +1 for US)</p>
    </div>
  </>
);
