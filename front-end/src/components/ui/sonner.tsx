/**
 * STATE MACHINE: sonner.tsx (Sonner Toaster)
 *
 * [TOAST_CREATED] --> Sonner receives toast event
 *        |
 *        v
 * [TOP_RIGHT_VIEWPORT] --> Sonner renders toast stack at viewport top-right
 *        |
 *        v
 * [DISMISSED] --> Sonner timeout / action removes toast
 */

import { useSyncExternalStore } from 'react';
import { Toaster as Sonner } from 'sonner';

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Toasts mount outside RoseThemeProvider; follow its document class directly.
const documentTheme = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';
const observeTheme = (notify: () => void) => {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useSyncExternalStore(observeTheme, documentTheme, () => 'light');

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      position="top-right"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
