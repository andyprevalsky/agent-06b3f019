/**
 * Tiny labeled text-input used by the card / billing / shipping forms.
 * Centralises the label + error-wiring so each form block stays small
 * enough to fit under the 80-line strict cap.
 */

interface FormInputProps {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  maxLength?: number;
  type?: string;
  className?: string;
}

export const FormInput = ({
  label,
  value,
  placeholder,
  onChange,
  error,
  disabled = false,
  maxLength,
  type,
  className = '',
}: FormInputProps) => {
  const hasError = error !== undefined && error !== '';
  const inputClass = `w-full px-3 py-2 text-sm bg-surface border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50 ${
    hasError ? 'border-red-500' : 'border-border'
  } ${className}`;
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        maxLength={maxLength}
        type={type}
        className={inputClass}
      />
      {hasError && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
};
