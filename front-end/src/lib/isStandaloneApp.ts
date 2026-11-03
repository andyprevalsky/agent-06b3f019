/** Installed PWAs keep app navigation even before a user signs in. */
export function isStandaloneApp(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}
