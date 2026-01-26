import { useState, useEffect } from 'react';
import { Check, Loader2, ArrowRight, X, RefreshCw } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import AtlasPasswordModal from '../components/AtlasPasswordModal';
import ApplePasswordsModal from '../components/ApplePasswordsModal';
import type { BrowserInfo, BrowserType } from '../../shared/types/ipc';

// Browser icons
import chromeIcon from '../assets/chrome-icon.png';
import chatgptIcon from '../assets/chatgpt-icon.webp';
import braveIcon from '../assets/brave-icon.webp';
import applePasswordsIcon from '../assets/apple-passwords-icon.png';

interface OnboardingDataProps {
  onComplete: () => void;
}

interface IntegrationItemProps {
  icon: React.ReactNode;
  name: string;
  description: string;
  connected: boolean;
  loading: boolean;
  onConnect: () => void;
  children?: React.ReactNode;
}

interface Integration {
  id: string;
  name: string;
  status: string;
  config?: {
    connectedEmail?: string;
    connectedEmails?: string[];
    cookieCount?: number;
    fingerprint?: unknown;
  };
}

const IntegrationItem = ({
  icon,
  name,
  description,
  connected,
  loading,
  onConnect,
  children,
}: IntegrationItemProps) => (
  <div className="p-4 rounded-xl border transition-all duration-200 bg-card border-border">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-surface text-muted-foreground">
          {icon}
        </div>
        <div>
          <div className="font-medium text-sm text-foreground">{name}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
      </div>

      <button
        onClick={onConnect}
        disabled={loading}
        className={`h-10 w-10 rounded-lg flex items-center justify-center transition-all duration-200 ${
          connected
            ? 'bg-green-100 text-green-700'
            : 'bg-foreground text-background hover:bg-foreground/90'
        }`}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : connected ? (
          <Check className="w-4 h-4" />
        ) : (
          <RefreshCw className="w-4 h-4" />
        )}
      </button>
    </div>
    {children}
  </div>
);

// Email chip component
const EmailChip = ({ email, onRemove }: { email: string; onRemove?: () => void }) => (
  <div className="inline-flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded-md text-xs text-foreground">
    <span className="truncate max-w-[180px]">{email}</span>
    {onRemove && (
      <button
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground transition-colors"
      >
        <X className="w-3 h-3" />
      </button>
    )}
  </div>
);

// Browser icon component
const BrowserIcon = ({ type, className = "w-4 h-4" }: { type: BrowserType; className?: string }) => {
  switch (type) {
    case 'chrome':
      return <img src={chromeIcon} alt="Chrome" className={className} />;
    case 'edge':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <defs>
            <linearGradient id="edge1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#0078D4"/>
              <stop offset="100%" stopColor="#1AEBFF"/>
            </linearGradient>
            <linearGradient id="edge2" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#50E6FF"/>
              <stop offset="100%" stopColor="#32BEDD"/>
            </linearGradient>
          </defs>
          <path fill="url(#edge1)" d="M24 4C12.95 4 4 12.95 4 24c0 6.63 3.23 12.5 8.2 16.15 1.15-5.35 5.8-9.35 11.35-9.35 3.05 0 5.85 1.2 7.95 3.15C37.5 31.5 42 28.1 42 24c0-11.05-8.05-20-18-20z"/>
          <path fill="url(#edge2)" d="M23.55 30.8c-5.55 0-10.2 4-11.35 9.35C16.35 43.1 20 44 24 44c11.05 0 20-8.95 20-20 0 4.1-4.5 7.5-10.5 9.95-2.1-1.95-4.9-3.15-7.95-3.15z"/>
        </svg>
      );
    case 'brave':
      return <img src={braveIcon} alt="Brave" className={`${className} bg-white rounded`} />;
    case 'arc':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <defs>
            <linearGradient id="arcGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FF6B6B"/>
              <stop offset="25%" stopColor="#FF8E53"/>
              <stop offset="50%" stopColor="#FFCD56"/>
              <stop offset="75%" stopColor="#6BCB77"/>
              <stop offset="100%" stopColor="#4D96FF"/>
            </linearGradient>
          </defs>
          <circle cx="24" cy="24" r="20" fill="url(#arcGrad)"/>
          <circle cx="24" cy="24" r="12" fill="white"/>
        </svg>
      );
    case 'opera':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <ellipse cx="24" cy="24" rx="20" ry="22" fill="#FF1B2D"/>
          <ellipse cx="24" cy="24" rx="10" ry="16" fill="white"/>
        </svg>
      );
    case 'vivaldi':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="22" fill="#EF3939"/>
          <path fill="white" d="M24 8c-8.8 0-16 7.2-16 16s7.2 16 16 16c4 0 7.6-1.5 10.4-3.9L24 24l10.4-12.1C31.6 9.5 28 8 24 8z"/>
        </svg>
      );
    case 'chromium':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="22" fill="#4587F3"/>
          <path fill="#7BAAF7" d="M24 2C12.95 2 4 10.95 4 22h20l9.5-16.5A21.9 21.9 0 0024 2z"/>
          <path fill="#A8C7FA" d="M4 22c0 11.05 8.95 20 20 20 4.57 0 8.78-1.53 12.17-4.1L26.5 22H4z"/>
          <path fill="#669DF6" d="M24 42c8.28 0 15.35-5.03 18.37-12.2L33.5 16.5 24 22v20z"/>
          <circle cx="24" cy="24" r="10" fill="white"/>
          <circle cx="24" cy="24" r="8" fill="#4587F3"/>
        </svg>
      );
    case 'atlas':
      return <img src={chatgptIcon} alt="ChatGPT" className={`${className} rounded`} />;
    default:
      return (
        <svg className={className} viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="20" fill="#888"/>
          <circle cx="24" cy="24" r="8" fill="white"/>
        </svg>
      );
  }
};

const OnboardingData = ({ onComplete }: OnboardingDataProps) => {
  const [connectedEmails, setConnectedEmails] = useState<string[]>([]);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Browser sync state
  const [installedBrowsers, setInstalledBrowsers] = useState<BrowserInfo[]>([]);
  const [connectedBrowsers, setConnectedBrowsers] = useState<Set<BrowserType>>(new Set());
  const [browserSyncLoading, setBrowserSyncLoading] = useState<BrowserType | null>(null);
  const [browsersExpanded, setBrowsersExpanded] = useState(false);
  const [atlasModalOpen, setAtlasModalOpen] = useState(false);
  const [pendingAtlasBrowser, setPendingAtlasBrowser] = useState<BrowserType | null>(null);

  // Passwords state
  const [passwordsExpanded, setPasswordsExpanded] = useState(false);
  const [applePasswordsModalOpen, setApplePasswordsModalOpen] = useState(false);
  const [atlasPasswordsModalOpen, setAtlasPasswordsModalOpen] = useState(false);
  const [chromePasswordsSynced, setChromePasswordsSynced] = useState(false);
  const [applePasswordsSynced, setApplePasswordsSynced] = useState(false);
  const [atlasPasswordsSynced, setAtlasPasswordsSynced] = useState(false);
  const [passwordSyncLoading, setPasswordSyncLoading] = useState<'chrome' | 'apple' | 'atlas' | null>(null);
  const [passwordRequestExpanded, setPasswordRequestExpanded] = useState(false);
  const [passwordRequestInput, setPasswordRequestInput] = useState('');
  const [passwordRequestSending, setPasswordRequestSending] = useState(false);
  const [passwordRequestSent, setPasswordRequestSent] = useState(false);

  // Fetch installed browsers and existing integrations on mount
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch installed browsers
        console.log('[OnboardingData] Checking for getInstalledBrowsers API...');
        if (window.api?.getInstalledBrowsers) {
          console.log('[OnboardingData] Calling getInstalledBrowsers...');
          const browsers = await window.api.getInstalledBrowsers();
          console.log('[OnboardingData] Got browsers:', browsers);
          setInstalledBrowsers(browsers);
        } else {
          console.log('[OnboardingData] getInstalledBrowsers API not available');
        }

        // Fetch existing integrations
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) {
          setInitialLoading(false);
          return;
        }

        const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';
        const response = await fetch(`${backendUrl}/api/integrations`, {
          headers: {
            Authorization: `Bearer ${session.access_token}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          const integrations: Integration[] = data.integrations || [];

          // Check for browser integrations (chrome, edge, atlas, etc.)
          const validBrowserTypes = ['chrome', 'edge', 'brave', 'arc', 'opera', 'vivaldi', 'chromium', 'atlas', 'safari', 'firefox'];
          const newConnectedBrowsers = new Set<BrowserType>();
          for (const integration of integrations) {
            if (validBrowserTypes.includes(integration.name) && integration.status === 'CONNECTED') {
              newConnectedBrowsers.add(integration.name as BrowserType);
            }
          }
          setConnectedBrowsers(newConnectedBrowsers);

          // Check for password integrations
          const chromeIntegration = integrations.find((i: Integration) => i.name === 'chrome' && i.status === 'CONNECTED');
          setChromePasswordsSynced(!!chromeIntegration);

          const applePasswordsIntegration = integrations.find((i: Integration) => i.name === 'apple_passwords' && i.status === 'CONNECTED');
          setApplePasswordsSynced(!!applePasswordsIntegration);

          const atlasPasswordsIntegration = integrations.find((i: Integration) => i.name === 'atlas_passwords' && i.status === 'CONNECTED');
          setAtlasPasswordsSynced(!!atlasPasswordsIntegration);

          // Check for gmail integration(s) - use connectedEmails array if available, fallback to connectedEmail
          // Treat CONNECTED or SYNCING as connected (SYNCING means OAuth succeeded, just processing emails)
          const gmailIntegration = integrations.find(i => i.name === 'gmail');
          const isGmailConnected = gmailIntegration?.status === 'CONNECTED' || gmailIntegration?.status === 'SYNCING';
          if (isGmailConnected) {
            if (gmailIntegration.config?.connectedEmails && gmailIntegration.config.connectedEmails.length > 0) {
              setConnectedEmails(gmailIntegration.config.connectedEmails);
            } else if (gmailIntegration.config?.connectedEmail) {
              setConnectedEmails([gmailIntegration.config.connectedEmail]);
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch data:', err);
      } finally {
        setInitialLoading(false);
      }
    };

    fetchData();
  }, []);

  // Continue is only available when at least one browser is connected and at least one email
  const canContinue = connectedBrowsers.size > 0 && connectedEmails.length > 0;

  // Handle browser sync click - syncs all browser data in parallel
  const handleBrowserSync = async (browserType: BrowserType) => {
    const browser = installedBrowsers.find(b => b.type === browserType);
    if (!browser) return;

    // For Atlas (or any browser needing manual password), open the password modal
    if (browser.needsManualPassword) {
      setPendingAtlasBrowser(browserType);
      setAtlasModalOpen(true);
      return;
    }

    // Full browser sync (all browser data)
    setBrowserSyncLoading(browserType);
    try {
      const result = await window.api.syncBrowser(browserType);
      if (result.success) {
        setConnectedBrowsers(prev => new Set([...prev, browserType]));
      } else {
        console.error(`Failed to sync ${browserType}:`, result.message);
      }
    } catch (err) {
      console.error(`Failed to sync ${browserType}:`, err);
    } finally {
      setBrowserSyncLoading(null);
    }
  };

  // Handle Atlas password modal sync
  const handleAtlasSync = async (password: string) => {
    if (!pendingAtlasBrowser) return;

    setBrowserSyncLoading(pendingAtlasBrowser);
    try {
      const result = await window.api.syncBrowser(pendingAtlasBrowser, { keychainPassword: password });
      if (result.success) {
        setConnectedBrowsers(prev => new Set([...prev, pendingAtlasBrowser]));

        // Store the password securely for background sync
        if (window.api.atlas?.storePassword) {
          const storeResult = await window.api.atlas.storePassword(password);
          if (!storeResult.success) {
            console.warn('[OnboardingData] Failed to store Atlas password:', storeResult.error);
          }
        }
      }
      setAtlasModalOpen(false);
      setPendingAtlasBrowser(null);
    } catch (err) {
      console.error(`Failed to sync ${pendingAtlasBrowser}:`, err);
      throw err; // Let the modal handle the error display
    } finally {
      setBrowserSyncLoading(null);
    }
  };

  // Handle Chrome passwords sync (password-only, not full browser state)
  const handleChromePasswordsSync = async () => {
    setPasswordSyncLoading('chrome');
    try {
      const result = await window.api.syncBrowserPasswords('chrome');
      if (result.success) {
        setChromePasswordsSynced(true);
      } else {
        console.error('Failed to sync Chrome passwords:', result.message);
      }
    } catch (err) {
      console.error('Failed to sync Chrome passwords:', err);
    } finally {
      setPasswordSyncLoading(null);
    }
  };

  // Handle Apple Passwords CSV upload
  const handleApplePasswordsSync = async (file: File) => {
    setPasswordSyncLoading('apple');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        throw new Error('Not authenticated');
      }

      const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${backendUrl}/api/integrations/passwords/apple/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: formData,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to import passwords');
      }

      setApplePasswordsSynced(true);
      setApplePasswordsModalOpen(false);
      console.log(`[OnboardingData] Imported ${payload.passwordCount} Apple passwords`);
    } catch (err) {
      console.error('Failed to import Apple passwords:', err);
      throw err; // Let the modal handle the error display
    } finally {
      setPasswordSyncLoading(null);
    }
  };

  // Handle Atlas (ChatGPT) password sync via keychain password
  const handleAtlasPasswordsSync = async (keychainPassword: string) => {
    setPasswordSyncLoading('atlas');
    try {
      const result = await window.api.syncBrowserPasswords('atlas', { keychainPassword });
      if (result.success) {
        setAtlasPasswordsSynced(true);
        setAtlasPasswordsModalOpen(false);
        console.log('[OnboardingData] Synced Atlas passwords');
      } else {
        throw new Error(result.message || 'Failed to sync passwords');
      }
    } catch (err) {
      console.error('Failed to sync Atlas passwords:', err);
      throw err; // Let the modal handle the error display
    } finally {
      setPasswordSyncLoading(null);
    }
  };

  // Handle password integration request
  const handlePasswordRequest = async () => {
    if (!passwordRequestInput.trim()) return;

    setPasswordRequestSending(true);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        console.error('No auth session');
        setPasswordRequestSending(false);
        return;
      }

      const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';
      const response = await fetch(`${backendUrl}/api/integrations/passwords/request`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ request: passwordRequestInput.trim() }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Failed to send request');
      }

      setPasswordRequestSent(true);
      setPasswordRequestInput('');
      console.log('[OnboardingData] Password integration request sent');
    } catch (err) {
      console.error('Failed to send password request:', err);
    } finally {
      setPasswordRequestSending(false);
    }
  };

  const handleGmailConnect = async () => {
    setGmailLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        console.error('No auth session');
        setGmailLoading(false);
        return;
      }

      const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';

      // Start OAuth flow
      const startResponse = await fetch(`${backendUrl}/api/integrations/email/gmail/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!startResponse.ok) {
        throw new Error('Failed to start Gmail OAuth');
      }

      const { authUrl } = await startResponse.json();

      const width = 500;
      const height = 600;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      const popup = window.open(
        authUrl,
        'gmail-oauth',
        `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`
      );

      // Poll for popup close and then refresh integrations
      const checkPopup = setInterval(async () => {
        if (popup?.closed) {
          clearInterval(checkPopup);

          // Wait for backend to process the callback
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Fetch updated integrations with retries
          const fetchWithRetry = async (retries = 3): Promise<void> => {
            try {
              const response = await fetch(`${backendUrl}/api/integrations`, {
                headers: {
                  Authorization: `Bearer ${session.access_token}`,
                },
              });

              if (response.ok) {
                const data = await response.json();
                const integrations: Integration[] = data.integrations || [];
                console.log('[OnboardingData] Fetched integrations:', integrations);
                const gmailIntegration = integrations.find(i => i.name === 'gmail');
                console.log('[OnboardingData] Gmail integration:', gmailIntegration);

                // Treat CONNECTED or SYNCING as connected (SYNCING means OAuth succeeded, just processing emails)
                const isGmailConnected = gmailIntegration?.status === 'CONNECTED' || gmailIntegration?.status === 'SYNCING';
                if (isGmailConnected) {
                  // Prefer connectedEmails array if available
                  if (gmailIntegration.config?.connectedEmails && gmailIntegration.config.connectedEmails.length > 0) {
                    setConnectedEmails(gmailIntegration.config.connectedEmails);
                  } else if (gmailIntegration.config?.connectedEmail) {
                    const email = gmailIntegration.config.connectedEmail;
                    if (!connectedEmails.includes(email)) {
                      setConnectedEmails(prev => [...prev, email]);
                    }
                  }
                } else if (retries > 0) {
                  // Integration not ready yet, retry
                  console.log('[OnboardingData] Gmail not connected yet, retrying...');
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  return fetchWithRetry(retries - 1);
                }
              }
            } catch (err) {
              console.error('Failed to refresh integrations:', err);
              if (retries > 0) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                return fetchWithRetry(retries - 1);
              }
            }
          };

          await fetchWithRetry();
          setGmailLoading(false);
        }
      }, 500);
    } catch (err) {
      console.error('Failed to connect Gmail:', err);
      setGmailLoading(false);
    }
  };

  // Note: Currently backend only supports one Gmail per user due to unique constraint
  // So we don't show remove button for now
  // const handleRemoveEmail = (emailToRemove: string) => {
  //   setConnectedEmails(prev => prev.filter(email => email !== emailToRemove));
  // };

  if (initialLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-80px)] px-8">
      <div className="w-full max-w-sm">
        {/* Header */}
        <h1 className="text-2xl font-semibold text-foreground mb-2">
          Connect your Data
        </h1>
        <p className="text-muted-foreground mb-8">
          Rose works best when connected to your services
        </p>

        {/* Integrations */}
        <div className="space-y-3 mb-8">
          {/* Browser Sync - Expandable */}
          <div className="rounded-xl border transition-all duration-200 bg-card border-border overflow-hidden">
            {/* Main row */}
            <div className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-surface">
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <defs>
                      <radialGradient id="browserCookieGradient" cx="30%" cy="30%" r="70%">
                        <stop offset="26%" stopColor="rgb(9,78,255)" />
                        <stop offset="63%" stopColor="rgb(33,130,255)" />
                        <stop offset="100%" stopColor="rgb(57,182,255)" />
                      </radialGradient>
                    </defs>
                    <path fill="url(#browserCookieGradient)" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                  </svg>
                </div>
                <div>
                  <div className="font-medium text-sm text-foreground">Browser Sync</div>
                  <div className="text-xs text-muted-foreground">Sync browsing data for web automation</div>
                </div>
              </div>

              <button
                onClick={() => setBrowsersExpanded(!browsersExpanded)}
                className={`h-10 w-10 rounded-lg flex items-center justify-center transition-all duration-200 ${
                  connectedBrowsers.size > 0
                    ? 'bg-green-100 text-green-700'
                    : 'bg-foreground text-background hover:bg-foreground/90'
                }`}
              >
                {connectedBrowsers.size > 0 ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* Expanded browser list */}
            {browsersExpanded && (
              <div className="border-t border-border">
                {installedBrowsers.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-muted-foreground">
                    No supported browsers detected. Install Chrome, Edge, Brave, Arc, or another Chromium-based browser.
                  </div>
                ) : installedBrowsers.map((browser, index) => {
                  const isConnected = connectedBrowsers.has(browser.type);
                  const isLoading = browserSyncLoading === browser.type;

                  return (
                    <div
                      key={browser.type}
                      className={`px-4 py-2 flex items-center justify-between ${
                        index < installedBrowsers.length - 1 ? 'border-b border-border/50' : ''
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <BrowserIcon type={browser.type} className="w-6 h-6" />
                        <span className="text-sm text-foreground">{browser.name}</span>
                      </div>

                      <button
                        onClick={() => handleBrowserSync(browser.type)}
                        disabled={isLoading}
                        className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                          isConnected
                            ? 'bg-green-100 text-green-700'
                            : 'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {isLoading ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : isConnected ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Passwords Connector - Expandable Section */}
          <div className="rounded-xl border transition-all duration-200 bg-card border-border overflow-hidden">
            {/* Main row */}
            <div className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-surface">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="url(#keyGradientOnboarding)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <defs>
                      <linearGradient id="keyGradientOnboarding" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#f59e0b" />
                        <stop offset="100%" stopColor="#fcd34d" />
                      </linearGradient>
                    </defs>
                    <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
                  </svg>
                </div>
                <div>
                  <div className="font-medium text-sm text-foreground">Passwords</div>
                  <div className="text-xs text-muted-foreground">Auto-fill login credentials</div>
                </div>
              </div>

              <button
                onClick={() => setPasswordsExpanded(!passwordsExpanded)}
                className={`h-10 w-10 rounded-lg flex items-center justify-center transition-all duration-200 ${
                  chromePasswordsSynced || applePasswordsSynced || atlasPasswordsSynced
                    ? 'bg-green-100 text-green-700'
                    : 'bg-foreground text-background hover:bg-foreground/90'
                }`}
              >
                {chromePasswordsSynced || applePasswordsSynced || atlasPasswordsSynced ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* Expanded password options */}
            {passwordsExpanded && (
              <div className="border-t border-border">
                {/* Chrome passwords */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <img src={chromeIcon} alt="Chrome" className="w-6 h-6" />
                    <span className="text-sm text-foreground">Chrome</span>
                  </div>

                  <button
                    onClick={handleChromePasswordsSync}
                    disabled={passwordSyncLoading === 'chrome'}
                    className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                      chromePasswordsSynced
                        ? 'bg-green-100 text-green-700'
                        : 'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {passwordSyncLoading === 'chrome' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : chromePasswordsSynced ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* Apple Passwords */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <img src={applePasswordsIcon} alt="Apple Passwords" className="w-6 h-6" />
                    <span className="text-sm text-foreground">Apple Passwords</span>
                  </div>

                  <button
                    onClick={() => setApplePasswordsModalOpen(true)}
                    disabled={passwordSyncLoading === 'apple'}
                    className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                      applePasswordsSynced
                        ? 'bg-green-100 text-green-700'
                        : 'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {passwordSyncLoading === 'apple' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : applePasswordsSynced ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* ChatGPT Atlas Passwords */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <img src={chatgptIcon} alt="ChatGPT Atlas" className="w-6 h-6" />
                    <span className="text-sm text-foreground">ChatGPT Atlas</span>
                  </div>

                  <button
                    onClick={() => setAtlasPasswordsModalOpen(true)}
                    disabled={passwordSyncLoading === 'atlas'}
                    className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                      atlasPasswordsSynced
                        ? 'bg-green-100 text-green-700'
                        : 'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {passwordSyncLoading === 'atlas' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : atlasPasswordsSynced ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* Request new password integration */}
                <div className="px-4 py-2">
                  {!passwordRequestExpanded ? (
                    <button
                      onClick={() => setPasswordRequestExpanded(true)}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Don't see your password client? <span className="underline">Request one</span> and we'll add it in &lt; 1 day
                    </button>
                  ) : passwordRequestSent ? (
                    <p className="text-xs text-green-600">
                      Request sent! We'll add the integration within 24 hours.
                    </p>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={passwordRequestInput}
                        onChange={(e) => setPasswordRequestInput(e.target.value)}
                        placeholder="e.g., 1Password, Bitwarden, LastPass..."
                        disabled={passwordRequestSending}
                        className="flex-1 px-2 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !passwordRequestSending) {
                            handlePasswordRequest();
                          }
                        }}
                      />
                      <button
                        onClick={handlePasswordRequest}
                        disabled={passwordRequestSending || !passwordRequestInput.trim()}
                        className="h-7 px-2 text-xs font-medium bg-foreground text-background rounded hover:bg-foreground/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                      >
                        {passwordRequestSending ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          'Send'
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <IntegrationItem
            icon={
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#EA4335" d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
              </svg>
            }
            name="Gmail"
            description="Access and manage your emails"
            connected={connectedEmails.length > 0}
            loading={gmailLoading}
            onConnect={handleGmailConnect}
          >
            {/* Connected emails chips */}
            {connectedEmails.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {connectedEmails.map(email => (
                  <EmailChip
                    key={email}
                    email={email}
                  />
                ))}
                {/* Add another button - hidden for now since backend only supports one Gmail */}
                {/* <button
                  onClick={handleGmailConnect}
                  disabled={gmailLoading}
                  className="inline-flex items-center gap-1 px-2 py-1 border border-dashed border-border rounded-md text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  Add another
                </button> */}
              </div>
            )}
          </IntegrationItem>
        </div>

        {/* Continue button */}
        <button
          onClick={onComplete}
          disabled={!canContinue}
          className="w-full py-3 px-4 rounded-xl bg-foreground text-background font-medium text-sm hover:bg-foreground/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Continue
          <ArrowRight className="w-3.5 h-3.5" />
        </button>

        {/* Skip button */}
        <button
          onClick={onComplete}
          className="w-full py-2 mt-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Skip for now
        </button>
      </div>

      {/* Atlas Browser Data Modal */}
      <AtlasPasswordModal
        isOpen={atlasModalOpen}
        onClose={() => {
          setAtlasModalOpen(false);
          setPendingAtlasBrowser(null);
        }}
        onSync={handleAtlasSync}
        syncType="browser data"
      />

      {/* Apple Passwords Modal */}
      <ApplePasswordsModal
        isOpen={applePasswordsModalOpen}
        onClose={() => setApplePasswordsModalOpen(false)}
        onSync={handleApplePasswordsSync}
      />

      {/* Atlas Passwords Modal (reuses AtlasPasswordModal for keychain password entry) */}
      <AtlasPasswordModal
        isOpen={atlasPasswordsModalOpen}
        onClose={() => setAtlasPasswordsModalOpen(false)}
        onSync={handleAtlasPasswordsSync}
        syncType="passwords"
      />
    </div>
  );
};

export default OnboardingData;
