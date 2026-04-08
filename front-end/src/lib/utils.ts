import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isEarlyAccessEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    // Enabled whenever the `earlyaccess` query param is present (value optional)
    return params.has('earlyaccess');
  } catch {
    return false;
  }
}
