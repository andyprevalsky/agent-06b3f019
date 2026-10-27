/** Public-site links are hidden in signed-in and installed app views. */
import { useAuth } from '@/features/auth';
import { isStandaloneApp } from '@/lib/isStandaloneApp';

export function usePublicSiteLinks(): boolean {
  const { isAuthenticated, isAnonymous } = useAuth({ passive: true });
  return !isStandaloneApp() && !(isAuthenticated && !isAnonymous);
}
