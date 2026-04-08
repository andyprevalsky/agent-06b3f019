import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

interface RoseWhiteButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

const sizeConfig = {
  sm: 'w-8 h-8',
  md: 'w-10 h-10',
  lg: 'w-12 h-12',
};

const RoseWhiteButton = forwardRef<HTMLButtonElement, RoseWhiteButtonProps>(
  ({ onClick, disabled = false, className, children, size = 'md', ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'flex items-center justify-center rounded-full border border-gray-300 dark:border-gray-700 transition-all',
          'bg-gray-100 dark:bg-gray-800 shadow-md',
          sizeConfig[size],
          disabled ? 'opacity-50 cursor-not-allowed' : 'hover:brightness-95 cursor-pointer',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);

RoseWhiteButton.displayName = 'RoseWhiteButton';

export default RoseWhiteButton;
