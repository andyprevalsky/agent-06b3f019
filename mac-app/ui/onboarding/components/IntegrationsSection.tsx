import { useState, useEffect } from 'react';
import { useIntegrationHandlers } from '@/contexts/IntegrationHandlersContext';
import { Check, Loader2 } from 'lucide-react';
import { getStoredSession } from '@/lib/supabase';

interface IntegrationsSectionProps {
  disabled?: boolean;
}

interface IntegrationItemProps {
  icon: React.ReactNode;
  name: string;
  description: string;
  connected: boolean;
  loading: boolean;
  onConnect: () => void;
  disabled?: boolean;
}

const IntegrationItem = ({
  icon,
  name,
  description,
  connected,
  loading,
  onConnect,
  disabled,
}: IntegrationItemProps) => (
  <div
    className={`flex items-center justify-between p-4 rounded-xl border transition-all duration-200 ${
      disabled
        ? 'bg-muted/30 border-border/50 opacity-60'
        : connected
        ? 'bg-green-50 border-green-200'
        : 'bg-card border-border hover:border-primary/20 hover:shadow-sm'
    }`}
  >
    <div className="flex items-center gap-3">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
        connected ? 'bg-green-100 text-green-600' : 'bg-surface text-muted-foreground'
      }`}>
        {icon}
      </div>
      <div>
        <div className="font-medium text-sm text-foreground">{name}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </div>

    <button
      onClick={onConnect}
      disabled={disabled || loading || connected}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
        connected
          ? 'bg-green-100 text-green-700 cursor-default'
          : disabled
          ? 'bg-muted text-muted-foreground cursor-not-allowed'
          : 'bg-primary text-primary-foreground hover:bg-primary/90'
      }`}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : connected ? (
        <span className="flex items-center gap-1.5">
          <Check className="w-4 h-4" />
          Connected
        </span>
      ) : (
        'Connect'
      )}
    </button>
  </div>
);

const IntegrationsSection = ({ disabled }: IntegrationsSectionProps) => {
  const handlers = useIntegrationHandlers();
  const [cookiesConnected, setCookiesConnected] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [cookiesLoading, setCookiesLoading] = useState(false);
  const [gmailLoading, setGmailLoading] = useState(false);

  // Load initial integration status from backend
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';
        const session = getStoredSession();
        const token = session?.access_token;
        if (!token) return;
        const res = await fetch(`${backendUrl}/api/integrations`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        const integrations = data.integrations || [];
        const gmail = integrations.find((i: any) => i.name === 'gmail');
        if (gmail?.status === 'CONNECTED' || gmail?.status === 'SYNCING') {
          setGmailConnected(true);
        }
        const chrome = integrations.find((i: any) => i.name === 'chrome');
        if (chrome?.status === 'CONNECTED') {
          setCookiesConnected(true);
        }
      } catch { /* ignore */ }
    };
    checkStatus();
  }, []);

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
      const backendUrl = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001';
      const session = getStoredSession();
      const token = session?.access_token;

      const response = await fetch(`${backendUrl}/api/integrations/email/gmail/start`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.authUrl) {
        throw new Error(payload?.error || 'Failed to start Gmail connection');
      }

      // Open in system browser (Electron intercepts window.open via setWindowOpenHandler)
      const api = (window as any).api;
      if (api?.openExternal) {
        await api.openExternal(payload.authUrl);
      } else {
        window.open(payload.authUrl);
      }

      // Poll backend for connection status since we can't track the external browser
      const pollForConnection = setInterval(async () => {
        try {
          const res = await fetch(`${backendUrl}/api/integrations`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) return;
          const data = await res.json();
          const gmail = (data.integrations || []).find((i: any) => i.name === 'gmail');
          if (gmail?.status === 'CONNECTED' || gmail?.status === 'SYNCING') {
            clearInterval(pollForConnection);
            setGmailLoading(false);
            setGmailConnected(true);
          }
        } catch { /* retry on next interval */ }
      }, 2000);

      // Stop polling after 2 minutes
      setTimeout(() => {
        clearInterval(pollForConnection);
        setGmailLoading(false);
      }, 120000);
    } catch (err) {
      console.error('Failed to connect Gmail:', err);
      setGmailLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <IntegrationItem
        icon={
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
          </svg>
        }
        name="Browser Cookies"
        description="Enable web automation and browsing"
        connected={cookiesConnected}
        loading={cookiesLoading}
        onConnect={handleCookiesConnect}
        disabled={disabled || !handlers?.chromeCookies?.isAvailable}
      />

      <IntegrationItem
        icon={
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="#EA4335" d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
          </svg>
        }
        name="Gmail"
        description="Access and manage your emails"
        connected={gmailConnected}
        loading={gmailLoading}
        onConnect={handleGmailConnect}
        disabled={disabled}
      />

      <p className="text-xs text-muted-foreground text-center pt-2">
        You can connect more services later in Settings
      </p>
    </div>
  );
};

export default IntegrationsSection;
