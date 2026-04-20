import { CODE_INPUT_MAX_LENGTH, CODE_INPUT_PLACEHOLDER } from '../config';

interface CodeStepProps {
  phoneNumber: string;
  code: string;
  loading: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}

export const CodeStep = ({
  phoneNumber,
  code,
  loading,
  onChange,
  onSubmit,
  onBack,
}: CodeStepProps): JSX.Element => (
  <>
    <p className="text-sm text-muted-foreground text-center mb-4">
      Telegram sent a code to <span className="font-medium text-foreground">{phoneNumber}</span>.
      Enter it below.
    </p>

    <div className="space-y-2">
      <label className="text-sm font-medium text-foreground">Verification Code</label>
      <input
        type="text"
        value={code}
        onChange={(e) => onChange(e.target.value)}
        placeholder={CODE_INPUT_PLACEHOLDER}
        disabled={loading}
        autoFocus
        className="w-full px-3 py-2 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#229ED9]/50 disabled:opacity-50 tracking-widest text-center text-lg"
        maxLength={CODE_INPUT_MAX_LENGTH}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !loading) {
            onSubmit();
          }
        }}
      />
    </div>

    <button
      onClick={onBack}
      disabled={loading}
      className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
    >
      Wrong number? Go back
    </button>
  </>
);
