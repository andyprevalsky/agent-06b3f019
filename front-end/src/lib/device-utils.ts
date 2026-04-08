/**
 * Utility functions for device and browser detection
 */

/**
 * Detects if the current device is running iOS
 * @returns {boolean} True if running on iOS (iPhone, iPad, iPod)
 */
export const isIOS = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  return /iPad|iPhone|iPod/.test(navigator.userAgent);
};

/**
 * Detects if the current browser is Safari
 * @returns {boolean} True if running Safari (not Chrome or Firefox)
 */
export const isSafari = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent.toLowerCase();
  return (
    userAgent.includes('safari') && !userAgent.includes('chrome') && !userAgent.includes('firefox')
  );
};

/**
 * Detects if the current device is iOS Safari
 * @returns {boolean} True if running Safari on iOS
 */
export const isIOSSafari = (): boolean => {
  return isIOS() && isSafari();
};
