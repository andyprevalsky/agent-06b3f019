export const fontFamily = 'Inter, system-ui, sans-serif';

// Rose logo component - matches Terminal header
export const RoseLogo = (): JSX.Element => (
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

export const ErrorBanner = ({ error }: ErrorBannerProps): JSX.Element | null => {
  if (error === null || error.length === 0) return null;
  return (
    <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm mb-4">{error}</div>
  );
};
