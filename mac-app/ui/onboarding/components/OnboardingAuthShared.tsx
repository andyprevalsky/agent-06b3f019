export const fontFamily = 'Inter, system-ui, sans-serif';

// Rose logo component - matches Terminal header
export const RoseLogo = () => (
  <div
    className="w-10 h-10 rounded-xl"
    style={{
      background:
        'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
    }}
  />
);

interface ErrorBannerProps {
  error: string | null;
}

export const ErrorBanner = ({ error }: ErrorBannerProps) => {
  if (error === null || error.length === 0) return null;
  return (
    <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm mb-4">{error}</div>
  );
};

// Format phone number as user types: +1 (XXX)-XXX-XXXX
export const formatPhoneNumber = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 0) return '';

  if (digits[0] === '1') {
    let formatted = '+1';
    const remaining = digits.slice(1);
    if (remaining.length > 0) {
      formatted += ' (' + remaining.slice(0, 3);
      if (remaining.length >= 3) {
        formatted += ')';
        if (remaining.length > 3) {
          formatted += '-' + remaining.slice(3, 6);
          if (remaining.length > 6) {
            formatted += '-' + remaining.slice(6, 10);
          }
        }
      }
    }
    return formatted;
  }

  if (digits.length <= 10) {
    let formatted = '+1 (' + digits.slice(0, 3);
    if (digits.length >= 3) {
      formatted += ')';
      if (digits.length > 3) {
        formatted += '-' + digits.slice(3, 6);
        if (digits.length > 6) {
          formatted += '-' + digits.slice(6, 10);
        }
      }
    }
    return formatted;
  }

  return '+' + digits;
};

export const stripPhoneNumber = (formatted: string): string => {
  return '+' + formatted.replace(/\D/g, '');
};
