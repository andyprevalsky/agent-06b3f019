/**
 * STATE MACHINE: NaviHeader
 *
 * MOBILE BUTTON VISIBILITY (IntersectionObserver):
 * [HIDDEN] <-- showMobileButton: false
 *   |
 *   | (features section enters viewport)
 *   v
 * [VISIBLE] <-- showMobileButton: true
 *   |
 *   | (features section exits viewport)
 *   v
 * [HIDDEN]
 *
 * CONTACT MODAL:
 * [CLOSED] <-- contactModalOpen: false
 *   |
 *   v
 * [OPEN] <-- contactModalOpen: true
 *
 * WAITLIST CTA VISIBILITY (auth):
 * [SHOWN] <-- no authenticated user
 *   |
 *   | (user logs in)
 *   v
 * [HIDDEN] <-- user authenticated (waitlist nav + CTA removed)
 */

import { isStandaloneApp } from '@/lib/isStandaloneApp';
import { isEarlyAccessEnabled } from '@/lib/utils';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import ContactModal from './ContactModal';
import { LoginButton, useAuth } from '@/features/auth';

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

const NaviHeader = () => {
  const [showMobileButton, setShowMobileButton] = useState(false);
  const [contactModalOpen, setContactModalOpen] = useState(false);
  const earlyAccess = isEarlyAccessEnabled();
  const { isAuthenticated, isAnonymous } = useAuth({ passive: true });
  // Only hide the waitlist CTA for a real signed-in account — anonymous
  // bootstrap sessions (every landing visitor) are NOT "logged in".
  const showWaitlistCta = !isStandaloneApp() && !(isAuthenticated && !isAnonymous);

  useEffect(() => {
    const featuresSection = document.getElementById('features');
    if (!featuresSection) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.target.id === 'features') {
            setShowMobileButton(entry.isIntersecting);
          }
        });
      },
      {
        threshold: 0, // show as soon as any part is visible
        rootMargin: '0px', // no offset for reliability across devices
      },
    );

    observer.observe(featuresSection);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <header
      id="site-header"
      className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border/50"
    >
      <div className="container mx-auto px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center space-x-3 hover:opacity-80 transition-opacity">
          <div
            className="w-8 h-8 rounded-lg"
            style={{
              background:
                'linear-gradient(to bottom left, #FE7503, #FE7503, #FC585C, #FD5776, #E062CC, #A76CED, #7A6BEC)',
            }}
          ></div>
          <span className="text-xl font-semibold tracking-tight">Rose</span>
        </Link>

        {showWaitlistCta && (
          <nav className="hidden md:flex items-center space-x-8">
            <button
              onClick={() => {
                goToLandingSection('features', false);
              }}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Features
            </button>
            {showWaitlistCta && (
              <button
                onClick={() => {
                  const targetId = earlyAccess ? 'pre-order' : 'waitlist';
                  goToLandingSection(targetId, earlyAccess);
                }}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {earlyAccess ? 'Pre-order' : 'Join Waitlist'}
              </button>
            )}
            <a
              href="/research"
              onClick={(event) => {
                if (!openExternalFromElectron('/research')) return;
                event.preventDefault();
              }}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Research
            </a>
            <a
              href="/careers"
              onClick={(event) => {
                if (!openExternalFromElectron('/careers')) return;
                event.preventDefault();
              }}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Careers
            </a>
            <a
              href="/about"
              onClick={(event) => {
                if (!openExternalFromElectron('/about')) return;
                event.preventDefault();
              }}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              About
            </a>
          </nav>
        )}

        <div className="flex items-center space-x-3">
          {/* Mobile/Tablet CTA - shows below desktop (<lg) and fades in at Features */}
          {showWaitlistCta && (
            <button
              className={`relative lg:hidden px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 overflow-hidden hover:scale-105 ${
                showMobileButton ? 'opacity-100 visible' : 'opacity-0 invisible'
              }`}
              onClick={() => {
                const targetId = earlyAccess ? 'pre-order' : 'waitlist';
                goToLandingSection(targetId, earlyAccess);
              }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-[#FE7503] via-[#FC585C] via-[#FD5776] via-[#E062CC] via-[#A76CED] to-[#7A6BEC] bg-[length:200%_200%] animate-gradient-rotate rounded-lg"></div>
              <span className="relative text-black z-10">
                {earlyAccess ? 'Pre-order' : 'Join Waitlist'}
              </span>
            </button>
          )}

          {/* Desktop Login Button */}
          <LoginButton />
        </div>
      </div>

      <ContactModal open={contactModalOpen} onOpenChange={setContactModalOpen} />
    </header>
  );
};

export default NaviHeader;
