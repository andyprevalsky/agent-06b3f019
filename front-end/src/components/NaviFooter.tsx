/**
 * STATE MACHINE: NaviFooter
 *
 * [SIGNED_IN] --> no public-site footer
 * [SIGNED_OUT/IDLE] <-- contactModalOpen: false
 *   |
 *   | (click contact link)
 *   v
 * [CONTACT_MODAL_OPEN] <-- contactModalOpen: true
 *   |
 *   | (close modal)
 *   v
 * [IDLE]
 */

import { isStandaloneApp } from '@/lib/isStandaloneApp';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import ContactModal from './ContactModal';
import { isEarlyAccessEnabled } from '@/lib/utils';
import { useAuth } from '@/features/auth';
import { ROSE_APP_DESCRIPTION } from '@/lib/googlePublicCopy';

const ROSE_SITE_ORIGIN = 'https://roselabs.ai';

const isElectronApp = (): boolean =>
  typeof window !== 'undefined' && (window as { api?: unknown }).api !== undefined;

const openExternalFromElectron = (path: string): boolean => {
  if (!isElectronApp()) return false;
  const api = (window as { api?: { openExternal?: (url: string) => Promise<void> } }).api;
  const url = new URL(path, ROSE_SITE_ORIGIN).toString();
  if (api?.openExternal !== undefined) {
    void api.openExternal(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  return true;
};

const goToLandingSection = (targetId: string, earlyAccess: boolean): void => {
  if (window.location.pathname === '/') {
    document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth' });
    return;
  }

  const path = earlyAccess ? `/?earlyaccess#${targetId}` : `/#${targetId}`;
  if (openExternalFromElectron(path)) return;
  window.location.href = path;
};

const NaviFooter = () => {
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const earlyAccess = isEarlyAccessEnabled();
  const { isAuthenticated, isAnonymous } = useAuth({ passive: true });
  // Only hide the waitlist CTA for a real signed-in account — anonymous
  // bootstrap sessions (every landing visitor) are NOT "logged in".
  const showWaitlistCta = !isStandaloneApp() && !(isAuthenticated && !isAnonymous);
  if (!showWaitlistCta) return null;
  return (
    <footer className="relative z-20 bg-primary text-primary-foreground py-16">
      <div className="container mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
          <div className="md:col-span-2">
            <Link
              to="/"
              className="flex items-center space-x-3 mb-4 hover:opacity-80 transition-opacity w-fit"
            >
              <div
                className="w-8 h-8 rounded-lg"
                style={{
                  background:
                    'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
                }}
              ></div>
              <span className="text-xl font-semibold">Rose Labs</span>
            </Link>
            <p className="text-primary-foreground/70 max-w-md leading-relaxed">
              Your personal superintelligence.
            </p>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-primary-foreground/70">
              <li>
                <button
                  onClick={() => {
                    goToLandingSection('features', false);
                  }}
                  className="hover:text-primary-foreground transition-colors text-left"
                >
                  Features
                </button>
              </li>
              {showWaitlistCta && (
                <li>
                  <button
                    onClick={() => {
                      const targetId = earlyAccess ? 'pre-order' : 'waitlist';
                      goToLandingSection(targetId, earlyAccess);
                    }}
                    className="hover:text-primary-foreground transition-colors text-left"
                  >
                    {earlyAccess ? 'Pre-order' : 'Join Waitlist'}
                  </button>
                </li>
              )}
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-primary-foreground/70">
              <li>
                <a
                  href="/careers"
                  onClick={(event) => {
                    if (!openExternalFromElectron('/careers')) return;
                    event.preventDefault();
                  }}
                  className="hover:text-primary-foreground transition-colors"
                >
                  Careers
                </a>
              </li>
              <li>
                <Link to="/privacy" className="hover:text-primary-foreground transition-colors">
                  Privacy
                </Link>
              </li>
              <li>
                <Link to="/terms" className="hover:text-primary-foreground transition-colors">
                  Terms
                </Link>
              </li>
              <li>
                <button
                  onClick={() => setContactModalOpen(true)}
                  className="hover:text-primary-foreground transition-colors text-left"
                >
                  Contact
                </button>
              </li>
            </ul>
          </div>
        </div>

        <div className="border-t border-primary-foreground/10 pt-8">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <p className="text-primary-foreground/60 text-sm">
              © 2026 Rose Labs. All rights reserved.
            </p>
            <div className="flex space-x-6 mt-4 md:mt-0">
              <Link
                to="/privacy"
                className="text-primary-foreground/60 hover:text-primary-foreground transition-colors text-sm"
              >
                Privacy Policy
              </Link>
              <Link
                to="/terms"
                className="text-primary-foreground/60 hover:text-primary-foreground transition-colors text-sm"
              >
                Terms of Service
              </Link>
              <a
                href="#"
                className="text-primary-foreground/60 hover:text-primary-foreground transition-colors text-sm"
              >
                Cookie Policy
              </a>
            </div>
          </div>
          <p className="mt-5 text-sm leading-relaxed text-primary-foreground/70 max-w-5xl">
            {ROSE_APP_DESCRIPTION}
          </p>
        </div>
      </div>

      <ContactModal open={contactModalOpen} onOpenChange={setContactModalOpen} />
    </footer>
  );
};

export default NaviFooter;
