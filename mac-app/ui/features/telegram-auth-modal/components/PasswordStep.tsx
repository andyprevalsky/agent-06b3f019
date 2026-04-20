import { PASSWORD_INPUT_PLACEHOLDER } from '../config';

interface PasswordStepProps {
  password: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}

export const PasswordStep = ({
  password,
  loading,
  onChange,
  onSubmit,
}: PasswordStepProps): JSX.Element => (
  <>
    <p className="text-sm text-muted-foreground text-center mb-4">
      Your account has 2FA enabled. Enter your Telegram password.
    </p>

    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground">2FA Password</label>
      <input
        type="password"
        value={password}
        onChange={(e) => onChange(e.target.value)}
        placeholder={PASSWORD_INPUT_PLACEHOLDER}
        disabled={loading}
        autoFocus
        className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]/50 disabled:opacity-50"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !loading) {
            onSubmit();
          }
        }}
      />
    </div>
  </>
);
