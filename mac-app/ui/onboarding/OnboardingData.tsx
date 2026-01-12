import { useState, useEffect } from 'react';
import { useIntegrationHandlers } from '@/contexts/IntegrationHandlersContext';
import { Check, Loader2, ArrowRight, X, Plus } from 'lucide-react';
import { supabase } from '@/lib/supabase';

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
        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 ${
          connected
            ? 'bg-green-100 text-green-700'
            : 'bg-foreground text-background hover:bg-foreground/90'
        }`}
      >
        {loading ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : connected ? (
          <span className="flex items-center gap-1">
            <Check className="w-3 h-3" />
            Connected
          </span>
        ) : (
          'Connect'
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

const OnboardingData = ({ onComplete }: OnboardingDataProps) => {
  const handlers = useIntegrationHandlers();
  const [cookiesConnected, setCookiesConnected] = useState(false);
  const [connectedEmails, setConnectedEmails] = useState<string[]>([]);
  const [cookiesLoading, setCookiesLoading] = useState(false);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Fetch existing integrations on mount
  useEffect(() => {
    const fetchIntegrations = async () => {
      try {
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

          // Check for chrome_cookies integration
          const cookiesIntegration = integrations.find(i => i.name === 'chrome_cookies');
          if (cookiesIntegration?.status === 'CONNECTED') {
            setCookiesConnected(true);
          }

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
        console.error('Failed to fetch integrations:', err);
      } finally {
        setInitialLoading(false);
      }
    };

    fetchIntegrations();
  }, []);

  // Continue is only available when cookies are connected and at least one email
  const canContinue = cookiesConnected && connectedEmails.length > 0;

  const handleCookiesConnect = async () => {
    if (!handlers?.chromeCookies?.isAvailable) return;

    setCookiesLoading(true);
    try {
      await handlers.chromeCookies.onClick();
      setCookiesConnected(true);
    } catch (err) {
      console.error('Failed to connect cookies:', err);
    } finally {
      setCookiesLoading(false);
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
          <IntegrationItem
            icon={
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
              </svg>
            }
            name="Chrome Cookies"
            description="Enable web automation and browsing"
            connected={cookiesConnected}
            loading={cookiesLoading}
            onConnect={handleCookiesConnect}
          />

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
    </div>
  );
};

export default OnboardingData;
