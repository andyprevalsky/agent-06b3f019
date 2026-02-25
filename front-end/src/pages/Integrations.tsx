/**
 * STATE MACHINE: Integrations
 *
 *                              [LOADING]
 *                                  |
 *                                  v (fetchIntegrations + getInstalledBrowsers)
 *       +-------------------[IDLE/READY]-------------------+
 *       |           |              |    |                  |
 *       | (file)    | (browser)    |    |  (provider)      | (handler/passwords)
 *       v           v              |    v                  v
 * [FILE_UPLOADING] [BROWSER_SYNC]  |  [CONNECTING]  [HANDLER/PASSWORD_UPLOADING]
 *       |           |              |       |               |
 *       v           v              v       v               v
 *       +----------(atlas modal?)--+-------+----(apple passwords modal?)
 *                              v
 *                         [IDLE/READY]
 *
 * States:
 * - loadingIntegrations: true --> LOADING
 * - uploading: string | null --> FILE_UPLOADING or HANDLER_UPLOADING
 * - connectingProvider: 'gmail' | null --> CONNECTING_PROVIDER
 * - browserSyncLoading: BrowserType | null --> syncing specific browser
 * - browsersExpanded: boolean --> browser list expanded
 * - atlasModalOpen: boolean --> Atlas password modal
 * - passwordsExpanded: boolean --> passwords list expanded
 * - applePasswordsModalOpen: boolean --> Apple passwords import modal
 * - passwordSyncLoading: 'chrome' | 'apple' | 'atlas' | null --> syncing passwords
 * - chromePasswordsSynced: boolean --> Chrome passwords connected
 * - applePasswordsSynced: boolean --> Apple passwords connected
 * - atlasPasswordsSynced: boolean --> Atlas passwords connected
 * - atlasPasswordsModalOpen: boolean --> Atlas passwords import modal
 * - passwordRequestExpanded: boolean --> showing password request input
 * - passwordRequestInput: string --> password request text
 * - passwordRequestSending: boolean --> sending password request
 * - passwordRequestSent: boolean --> password request sent successfully
 * - messagesSyncExpanded: boolean --> messages sync list expanded
 * - socialsExpanded: boolean --> socials list expanded
 * - iMessageSynced: boolean --> iMessage connected
 * - whatsAppConnected: boolean --> WhatsApp connected
 * - telegramConnected: boolean --> Telegram connected
 * - messageSyncLoading: 'imessage' | 'whatsapp' | 'telegram' | null --> syncing specific messaging client
 * - error: string | null (shown as banner)
 * - success: string | null (shown as banner)
 * - connectedIntegrations: list of connected integrations
 * - installedBrowsers: list of detected browsers
 * - connectedBrowsers: Set of browser types that are connected
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, RefreshCw, Check } from 'lucide-react';
import { useIntegrationHandlers, type BrowserType, type BrowserInfo } from '@/contexts/IntegrationHandlersContext';
import { getStoredSession } from '@/lib/supabase';
import AtlasPasswordModal from '@/components/AtlasPasswordModal';
import ApplePasswordsModal from '@/components/ApplePasswordsModal';

// Browser icons
import chromeIcon from '@/assets/chrome-icon.png';
import chatgptIcon from '@/assets/chatgpt-icon.webp';
import braveIcon from '@/assets/brave-icon.webp';
import applePasswordsIcon from '@/assets/apple-passwords-icon.png';
import claudeIcon from '@/assets/claude-color.svg';

const API_BASE_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api') ? API_BASE_URL : `${API_BASE_URL}/api`;

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

function getAuthHeaders() {
  const session = getStoredSession();
  const token = session?.access_token;
  if (!token) {
    throw new Error('Not authenticated');
  }
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

interface ConnectedIntegration {
  id: string;
  name: string;
  status: 'NOT_CONNECTED' | 'CONNECTED' | 'SYNCING' | 'SYNC_FAILED' | 'EXPIRED';
  isActive: boolean;
  config?: {
    connectedEmail?: string;
    provider?: string;
    contacts?: number;
    messages?: number;
    cookieCount?: number;
    [key: string]: unknown;
  };
  lastSuccessfulSyncAt?: string;
}

export default function Integrations() {
  const handlers = useIntegrationHandlers();
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<'gmail' | null>(null);
  const [connectedIntegrations, setConnectedIntegrations] = useState<ConnectedIntegration[]>([]);
  const [loadingIntegrations, setLoadingIntegrations] = useState(true);
  const vcfInputRef = useRef<HTMLInputElement>(null);
  const emailZipInputRef = useRef<HTMLInputElement>(null);

  // Browser cookies state
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

  // Claude Code state
  const [claudeCodeSynced, setClaudeCodeSynced] = useState(false);
  const [claudeCodeSyncLoading, setClaudeCodeSyncLoading] = useState(false);
  const [claudeCodeStatus, setClaudeCodeStatus] = useState<string | null>(null);

  // Messages Sync state
  const [messagesSyncExpanded, setMessagesSyncExpanded] = useState(false);
  const [socialsExpanded, setSocialsExpanded] = useState(false);
  const [iMessageSynced, setIMessageSynced] = useState(false);
  const [whatsAppConnected, setWhatsAppConnected] = useState(false);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [messageSyncLoading, setMessageSyncLoading] = useState<'imessage' | 'whatsapp' | 'telegram' | null>(null);

  const fetchIntegrations = useCallback(async () => {
    try {
      const headers = getAuthHeaders();
      const response = await fetch(`${API_BASE_WITH_PATH}/integrations`, {
        headers,
      });
      if (response.ok) {
        const data = await response.json();
        const integrations = data.integrations || [];
        setConnectedIntegrations(integrations);

        // Check for browser cookie integrations
        const validBrowserTypes: BrowserType[] = ['chrome', 'edge', 'brave', 'arc', 'opera', 'vivaldi', 'chromium', 'atlas'];
        const newConnectedBrowsers = new Set<BrowserType>();
        for (const integration of integrations) {
          if (validBrowserTypes.includes(integration.name as BrowserType) && integration.status === 'CONNECTED') {
            newConnectedBrowsers.add(integration.name as BrowserType);
          }
        }
        setConnectedBrowsers(newConnectedBrowsers);

        // Check for password integrations
        const chromePasswordsIntegration = integrations.find((i: ConnectedIntegration) =>
          (i.name === 'chrome_passwords' || i.name === 'chrome') && i.status === 'CONNECTED'
        );
        setChromePasswordsSynced(!!chromePasswordsIntegration);

        // Apple passwords have their own integration
        const applePasswordsIntegration = integrations.find((i: ConnectedIntegration) => i.name === 'apple_passwords' && i.status === 'CONNECTED');
        setApplePasswordsSynced(!!applePasswordsIntegration);

        // Atlas passwords have their own integration
        const atlasPasswordsIntegration = integrations.find((i: ConnectedIntegration) => i.name === 'atlas_passwords' && i.status === 'CONNECTED');
        setAtlasPasswordsSynced(!!atlasPasswordsIntegration);

        // Claude Code credentials
        const claudeCodeIntegration = integrations.find((i: ConnectedIntegration) => i.name === 'claude_code' && i.status === 'CONNECTED');
        setClaudeCodeSynced(!!claudeCodeIntegration);

        // Messaging integrations
        const imessageIntegration = integrations.find((i: ConnectedIntegration) => i.name === 'imessage' && i.status === 'CONNECTED');
        setIMessageSynced(!!imessageIntegration);
        const whatsappIntegration = integrations.find((i: ConnectedIntegration) => i.name === 'whatsapp' && i.status === 'CONNECTED');
        setWhatsAppConnected(!!whatsappIntegration);
        const telegramIntegration = integrations.find((i: ConnectedIntegration) => i.name === 'telegram' && i.status === 'CONNECTED');
        setTelegramConnected(!!telegramIntegration);
      }
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
    } finally {
      setLoadingIntegrations(false);
    }
  }, []);

  // Fetch installed browsers when handler is available
  useEffect(() => {
    const fetchBrowsers = async () => {
      if (handlers.browserCookies?.isAvailable) {
        try {
          const browsers = await handlers.browserCookies.getInstalledBrowsers();
          setInstalledBrowsers(browsers);
        } catch (err) {
          console.error('Failed to fetch installed browsers:', err);
        }
      }
    };
    fetchBrowsers();
  }, [handlers.browserCookies]);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  // Listen for Claude Code setup status events (only in Electron context)
  useEffect(() => {
    const api = (window as any).api;
    if (!api?.onClaudeSetupStatus) return;
    const cleanup = api.onClaudeSetupStatus((status: string) => {
      if (status) console.log('[ClaudeCodeSetup]', status);
      setClaudeCodeStatus(status || null);
    });
    return cleanup;
  }, []);

  // All integrations are now rendered as expandable sections (Browser Cookies, Passwords, Messages Sync, Socials, Claude Code)

  // Handle browser sync click
  const handleBrowserSync = async (browserType: BrowserType) => {
    const browser = installedBrowsers.find(b => b.type === browserType);
    if (!browser || !handlers.browserCookies) return;

    // For Atlas (or any browser needing manual password), open the password modal
    if (browser.needsManualPassword) {
      setPendingAtlasBrowser(browserType);
      setAtlasModalOpen(true);
      return;
    }

    // For standard browsers (automatic keychain access)
    setBrowserSyncLoading(browserType);
    setError(null);
    try {
      await handlers.browserCookies.syncBrowser(browserType);
      setConnectedBrowsers(prev => new Set([...prev, browserType]));
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to sync ${browserType} cookies`);
    } finally {
      setBrowserSyncLoading(null);
    }
  };

  // Handle Atlas password modal sync
  const handleAtlasSync = async (password: string) => {
    if (!pendingAtlasBrowser || !handlers.browserCookies) return;

    setBrowserSyncLoading(pendingAtlasBrowser);
    try {
      await handlers.browserCookies.syncBrowser(pendingAtlasBrowser, password);
      setConnectedBrowsers(prev => new Set([...prev, pendingAtlasBrowser]));

      // Store the password for background sync
      await handlers.browserCookies.storeAtlasPassword(password);

      setAtlasModalOpen(false);
      setPendingAtlasBrowser(null);
      await fetchIntegrations();
    } catch (err) {
      throw err; // Let the modal handle the error display
    } finally {
      setBrowserSyncLoading(null);
    }
  };

  const handleOpenKeychain = async () => {
    if (handlers.browserCookies) {
      await handlers.browserCookies.openKeychainAccess('ChatGPT Safe Storage');
    }
  };

  // Handle Chrome passwords sync (password-only, not full browser state)
  const handleChromePasswordsSync = async () => {
    if (!handlers.browserCookies) return;

    setPasswordSyncLoading('chrome');
    setError(null);
    try {
      await handlers.browserCookies.syncBrowserPasswords('chrome');
      setChromePasswordsSynced(true);
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync Chrome passwords');
    } finally {
      setPasswordSyncLoading(null);
    }
  };

  // Handle Apple Passwords CSV upload
  const handleApplePasswordsSync = async (file: File) => {
    setPasswordSyncLoading('apple');
    setError(null);
    try {
      const session = getStoredSession();
      const token = session?.access_token;
      if (!token) {
        throw new Error('Not authenticated');
      }

      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${API_BASE_WITH_PATH}/integrations/passwords/apple/upload`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to import passwords');
      }

      setApplePasswordsSynced(true);
      setApplePasswordsModalOpen(false);
      setSuccess(`Imported ${payload.passwordCount} passwords from Apple Passwords`);
      await fetchIntegrations();
    } catch (err) {
      throw err; // Let the modal handle the error display
    } finally {
      setPasswordSyncLoading(null);
    }
  };

  // Handle Atlas (ChatGPT) password sync via keychain password
  const handleAtlasPasswordsSync = async (keychainPassword: string) => {
    if (!handlers.browserCookies) return;

    setPasswordSyncLoading('atlas');
    setError(null);
    try {
      const result = await handlers.browserCookies.syncBrowserPasswords('atlas', { keychainPassword });
      if (!result.success) {
        throw new Error(result.message || 'Failed to sync Atlas passwords');
      }
      setAtlasPasswordsSynced(true);
      setAtlasPasswordsModalOpen(false);
      setSuccess('Synced passwords from ChatGPT Atlas');
      await fetchIntegrations();
    } catch (err) {
      throw err; // Let the modal handle the error display
    } finally {
      setPasswordSyncLoading(null);
    }
  };

  // Handle password integration request
  const handlePasswordRequest = async () => {
    if (!passwordRequestInput.trim()) return;

    setPasswordRequestSending(true);
    setError(null);

    try {
      const headers = getAuthHeaders();
      const response = await fetch(`${API_BASE_WITH_PATH}/integrations/passwords/request`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ request: passwordRequestInput.trim() }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || 'Failed to send request');
      }

      setPasswordRequestSent(true);
      setPasswordRequestInput('');
      setSuccess('Request sent! We\'ll add the integration within 24 hours.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send request');
    } finally {
      setPasswordRequestSending(false);
    }
  };

  // Handle Claude Code credentials sync
  const handleClaudeCodeSync = async () => {
    if (!handlers.claudeCode) return;
    setClaudeCodeSyncLoading(true);
    setError(null);
    try {
      const result = await handlers.claudeCode.syncCredentials();
      if (!result.success) {
        throw new Error(result.message || 'Failed to sync Claude Code credentials');
      }
      setClaudeCodeSynced(true);
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync Claude Code credentials');
    } finally {
      setClaudeCodeSyncLoading(false);
    }
  };

  // Handle iMessage sync via handler
  const handleIMessageSync = async () => {
    if (!handlers.iMessage?.isAvailable) return;
    setMessageSyncLoading('imessage');
    setError(null);
    try {
      await handlers.iMessage.onClick();
      setIMessageSynced(true);
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sync iMessage');
    } finally {
      setMessageSyncLoading(null);
    }
  };

  const handleFileUpload = async (type: 'vcf' | 'email-zip', file: File) => {
    const integrationName = type === 'vcf' ? 'Contacts (VCF)' : 'Email Export (ZIP)';
    setUploading(integrationName);
    setError(null);
    setSuccess(null);

    try {
      const session = getStoredSession();
      const token = session?.access_token;
      if (!token) {
        throw new Error('Not authenticated');
      }

      const formData = new FormData();
      formData.append('file', file);

      const endpoint = type === 'vcf' 
        ? `${API_BASE_WITH_PATH}/integrations/contacts/upload`
        : `${API_BASE_WITH_PATH}/integrations/email/upload`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        body: formData,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to upload file');
      }

      if (type === 'vcf') {
        setSuccess(`Imported ${payload.created} new contacts, updated ${payload.updated}, skipped ${payload.skipped}`);
      } else {
        setSuccess(payload.message || 'File uploaded successfully');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setUploading(null);
    }
  };

  const handleEmailConnect = async (provider: 'gmail') => {
    setConnectingProvider(provider);
    setError(null);

    try {
      const headers = getAuthHeaders();
      const response = await fetch(`${API_BASE_WITH_PATH}/integrations/email/${provider}/start`, {
        method: 'POST',
        headers,
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.authUrl) {
        throw new Error(payload?.error || 'Failed to start email connection');
      }

      const popup = window.open(payload.authUrl, 'email-oauth', 'width=520,height=720');
      if (!popup) {
        throw new Error('Pop-up was blocked. Please allow pop-ups for this site and try again.');
      }
      popup.focus();

      // Poll for popup close and refetch integrations
      const pollInterval = setInterval(() => {
        if (popup.closed) {
          clearInterval(pollInterval);
          setConnectingProvider(null);
          // Give the backend a moment to finish processing, then refetch
          setTimeout(() => {
            fetchIntegrations();
          }, 500);
        }
      }, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setConnectingProvider(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="container max-w-3xl mx-auto pt-20 pb-12 px-4">
        {error && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive rounded-lg text-destructive text-sm">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-6 p-4 bg-green-500/10 border border-green-500 rounded-lg text-green-600 dark:text-green-400 text-sm">
            {success}
          </div>
        )}

        {/* Hidden file inputs */}
        <input
          type="file"
          ref={vcfInputRef}
          accept=".vcf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              handleFileUpload('vcf', file);
              e.target.value = '';
            }
          }}
        />
        <input
          type="file"
          ref={emailZipInputRef}
          accept=".zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              handleFileUpload('email-zip', file);
              e.target.value = '';
            }
          }}
        />

        <div className="space-y-3">
          {loadingIntegrations ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Browser Cookies - Expandable Section */}
              {handlers.browserCookies?.isAvailable ? (
                <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
                  {/* Main row */}
                  <div className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
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
                      <div className="flex flex-col">
                        <h3 className="font-medium">Browser Cookies</h3>
                        <span className="text-xs text-muted-foreground">Enable web automation and browsing</span>
                      </div>
                    </div>

                    <button
                      onClick={() => setBrowsersExpanded(!browsersExpanded)}
                      className={`h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 ${
                        connectedBrowsers.size > 0
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90'
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
                              <span className="text-sm">{browser.name}</span>
                            </div>

                            <button
                              onClick={() => handleBrowserSync(browser.type)}
                              disabled={isLoading}
                              className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                                isConnected
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
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
              ) : (
                // Desktop-only fallback for web
                <div className="flex items-center justify-between p-4 border border-border rounded-lg bg-card/60">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
                      <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <defs>
                          <radialGradient id="browserCookieGradientAlt" cx="30%" cy="30%" r="70%">
                            <stop offset="26%" stopColor="rgb(9,78,255)" />
                            <stop offset="63%" stopColor="rgb(33,130,255)" />
                            <stop offset="100%" stopColor="rgb(57,182,255)" />
                          </radialGradient>
                        </defs>
                        <path fill="url(#browserCookieGradientAlt)" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                      </svg>
                    </div>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">Browser Cookies</h3>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          Desktop Only
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">Enable web automation and browsing</span>
                    </div>
                  </div>
                  <Button size="sm" variant="outline" asChild>
                    <a href="/download">Download for Mac</a>
                  </Button>
                </div>
              )}

              {/* Passwords Connector - Expandable Section */}
              <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
                {/* Main row */}
                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="url(#keyGradient)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <defs>
                          <linearGradient id="keyGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="#f59e0b" />
                            <stop offset="100%" stopColor="#fcd34d" />
                          </linearGradient>
                        </defs>
                        <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
                      </svg>
                    </div>
                    <div className="flex flex-col">
                      <h3 className="font-medium">Passwords</h3>
                      <span className="text-xs text-muted-foreground">Auto-fill login credentials</span>
                    </div>
                  </div>

                  <button
                    onClick={() => setPasswordsExpanded(!passwordsExpanded)}
                    className={`h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 ${
                      chromePasswordsSynced || applePasswordsSynced || atlasPasswordsSynced
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90'
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
                    {handlers.browserCookies?.isAvailable ? (
                      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                        <div className="flex items-center gap-3">
                          <img src={chromeIcon} alt="Chrome" className="w-6 h-6" />
                          <span className="text-sm">Chrome</span>
                        </div>

                        <button
                          onClick={handleChromePasswordsSync}
                          disabled={passwordSyncLoading === 'chrome'}
                          className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                            chromePasswordsSynced
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
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
                    ) : (
                      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                        <div className="flex items-center gap-3">
                          <img src={chromeIcon} alt="Chrome" className="w-6 h-6" />
                          <div className="flex items-center gap-2">
                            <span className="text-sm">Chrome</span>
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              Desktop Only
                            </span>
                          </div>
                        </div>
                        <Button size="sm" variant="outline" asChild>
                          <a href="/download">Download for Mac</a>
                        </Button>
                      </div>
                    )}

                    {/* Apple Passwords */}
                    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <img src={applePasswordsIcon} alt="Apple Passwords" className="w-6 h-6" />
                        <span className="text-sm">Apple Passwords</span>
                      </div>

                      <button
                        onClick={() => setApplePasswordsModalOpen(true)}
                        disabled={passwordSyncLoading === 'apple'}
                        className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                          applePasswordsSynced
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
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
                    {handlers.browserCookies?.isAvailable ? (
                      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                        <div className="flex items-center gap-3">
                          <img src={chatgptIcon} alt="ChatGPT Atlas" className="w-6 h-6 rounded" />
                          <span className="text-sm">ChatGPT Atlas</span>
                        </div>

                        <button
                          onClick={() => setAtlasPasswordsModalOpen(true)}
                          disabled={passwordSyncLoading === 'atlas'}
                          className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                            atlasPasswordsSynced
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
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
                    ) : (
                      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                        <div className="flex items-center gap-3">
                          <img src={chatgptIcon} alt="ChatGPT Atlas" className="w-6 h-6 rounded" />
                          <div className="flex items-center gap-2">
                            <span className="text-sm">ChatGPT Atlas</span>
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              Desktop Only
                            </span>
                          </div>
                        </div>
                        <Button size="sm" variant="outline" asChild>
                          <a href="/download">Download for Mac</a>
                        </Button>
                      </div>
                    )}

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
                        <p className="text-xs text-green-600 dark:text-green-400">
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
                          <Button
                            size="sm"
                            variant="default"
                            onClick={handlePasswordRequest}
                            disabled={passwordRequestSending || !passwordRequestInput.trim()}
                            className="h-7 px-2 text-xs"
                          >
                            {passwordRequestSending ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              'Send'
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Messages Sync - Expandable Section */}
              <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
                {/* Main row */}
                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
                        <defs>
                          <linearGradient id="chatSyncGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#34d399" />
                            <stop offset="100%" stopColor="#10b981" />
                          </linearGradient>
                        </defs>
                        <path fill="url(#chatSyncGradient)" transform="scale(-1,1)" transform-origin="center" d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2z"/>
                      </svg>
                    </div>
                    <div className="flex flex-col">
                      <h3 className="font-medium">Messages Sync</h3>
                      <span className="text-xs text-muted-foreground">Sync messaging clients</span>
                    </div>
                  </div>

                  <button
                    onClick={() => setMessagesSyncExpanded(!messagesSyncExpanded)}
                    className={`h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 ${
                      iMessageSynced || whatsAppConnected || telegramConnected || connectedIntegrations.some(i => i.name === 'gmail' && i.status === 'CONNECTED')
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90'
                    }`}
                  >
                    {iMessageSynced || whatsAppConnected || telegramConnected || connectedIntegrations.some(i => i.name === 'gmail' && i.status === 'CONNECTED') ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                  </button>
                </div>

                {/* Expanded messaging options */}
                {messagesSyncExpanded && (
                  <div className="border-t border-border">
                    {/* iMessage */}
                    {handlers.iMessage?.isAvailable ? (
                      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                        <div className="flex items-center gap-3">
                          <svg className="w-6 h-6" viewBox="0 0 24 24">
                            <defs>
                              <linearGradient id="imessageGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stopColor="#5bf675" />
                                <stop offset="100%" stopColor="#1fcc3f" />
                              </linearGradient>
                            </defs>
                            <rect width="24" height="24" rx="5" fill="url(#imessageGrad)" />
                            <path fill="white" d="M12 5C7.58 5 4 8.13 4 12c0 1.65.67 3.15 1.76 4.35L5 19l2.88-.93C9.05 18.66 10.48 19 12 19c4.42 0 8-3.13 8-7s-3.58-7-8-7z" />
                          </svg>
                          <span className="text-sm">iMessage</span>
                        </div>

                        <button
                          onClick={handleIMessageSync}
                          disabled={messageSyncLoading === 'imessage'}
                          className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                            iMessageSynced
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : 'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {messageSyncLoading === 'imessage' ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : iMessageSynced ? (
                            <Check className="w-3.5 h-3.5" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    ) : (
                      <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                        <div className="flex items-center gap-3">
                          <svg className="w-6 h-6" viewBox="0 0 24 24">
                            <defs>
                              <linearGradient id="imessageGradAlt" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stopColor="#5bf675" />
                                <stop offset="100%" stopColor="#1fcc3f" />
                              </linearGradient>
                            </defs>
                            <rect width="24" height="24" rx="5" fill="url(#imessageGradAlt)" />
                            <path fill="white" d="M12 5C7.58 5 4 8.13 4 12c0 1.65.67 3.15 1.76 4.35L5 19l2.88-.93C9.05 18.66 10.48 19 12 19c4.42 0 8-3.13 8-7s-3.58-7-8-7z" />
                          </svg>
                          <div className="flex items-center gap-2">
                            <span className="text-sm">iMessage</span>
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                              Desktop Only
                            </span>
                          </div>
                        </div>
                        <Button size="sm" variant="outline" asChild>
                          <a href="/download">Download for Mac</a>
                        </Button>
                      </div>
                    )}

                    {/* Gmail */}
                    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <svg className="w-6 h-6" viewBox="0 0 24 24">
                          <path fill="#EA4335" d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"/>
                        </svg>
                        <div className="flex flex-col">
                          <span className="text-sm">Gmail</span>
                          {connectedIntegrations.some(i => i.name === 'gmail' && i.status === 'CONNECTED' && i.config?.connectedEmail) && (
                            <span className="text-xs text-muted-foreground truncate max-w-[140px]">
                              {connectedIntegrations.find(i => i.name === 'gmail' && i.status === 'CONNECTED')?.config?.connectedEmail}
                            </span>
                          )}
                        </div>
                      </div>

                      <button
                        onClick={() => handleEmailConnect('gmail')}
                        disabled={connectingProvider === 'gmail'}
                        className={`h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 ${
                          connectedIntegrations.some(i => i.name === 'gmail' && i.status === 'CONNECTED')
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        {connectingProvider === 'gmail' ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : connectedIntegrations.some(i => i.name === 'gmail' && i.status === 'CONNECTED') ? (
                          <Check className="w-3.5 h-3.5" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>

                    {/* WhatsApp */}
                    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <svg className="w-6 h-6" viewBox="0 0 24 24">
                          <rect width="24" height="24" rx="5" fill="#25D366" />
                          <path fill="white" d="M12 4c-4.42 0-8 3.58-8 8 0 1.41.37 2.73 1.01 3.88L4 20l4.26-1.12A7.93 7.93 0 0 0 12 20c4.42 0 8-3.58 8-8s-3.58-8-8-8zm4.14 11.07c-.17.48-1 .93-1.38.99-.37.06-.84.09-1.35-.09-.31-.11-.71-.25-1.23-.49-2.16-1-3.57-3.18-3.68-3.33-.1-.15-.86-1.14-.86-2.18s.55-1.55.74-1.76c.2-.21.43-.27.57-.27h.42c.13 0 .31-.05.48.37.18.43.61 1.49.66 1.59.05.1.08.22.02.35-.07.14-.1.22-.2.34-.1.12-.21.26-.3.35-.1.1-.2.2-.09.4.12.2.53.87 1.13 1.41.78.7 1.43.91 1.63 1.02.2.1.32.09.44-.06.12-.14.5-.58.64-.78.13-.2.27-.16.45-.1.18.07 1.15.54 1.34.64.2.1.33.15.38.23.05.09.05.51-.12.99z"/>
                        </svg>
                        <span className="text-sm">WhatsApp</span>
                      </div>

                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        Coming Soon
                      </span>
                    </div>

                    {/* Telegram */}
                    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <svg className="w-6 h-6" viewBox="0 0 24 24">
                          <rect width="24" height="24" rx="5" fill="#229ED9" />
                          <path fill="white" d="M5.5 11.5l10.7-4.3c.6-.24 1.1.12.9.92l-1.9 9c-.14.64-.52.8-1.06.5l-2.9-2.1-1.4 1.4c-.12.1-.2.2-.4.2-.26 0-.37-.15-.5-.52l-1.1-3.5-2.7-.84c-.32-.11-.34-.41.06-.56zm4.7 1.7l.6 2.55.17-1.85 4.5-4c.2-.18-.05-.27-.32-.1l-5.5 3.4z" transform="translate(12, 12) scale(1.05) translate(-12, -12)"/>
                        </svg>
                        <span className="text-sm">Telegram</span>
                      </div>

                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        Coming Soon
                      </span>
                    </div>

                    {/* Facebook Messenger */}
                    <div className="px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <svg className="w-6 h-6" viewBox="0 0 24 24">
                          <defs>
                            <linearGradient id="messengerGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                              <stop offset="0%" stopColor="#00B2FF" />
                              <stop offset="100%" stopColor="#006AFF" />
                            </linearGradient>
                          </defs>
                          <rect width="24" height="24" rx="5" fill="url(#messengerGrad)" />
                          <path fill="white" d="M12 4c-4.42 0-8 3.13-8 7 0 2.2 1.1 4.16 2.8 5.45V19l2.4-1.32c.64.18 1.32.27 2.03.27h.77c4.42 0 8-3.13 8-7s-3.58-7-8-7zm.8 9.43l-2.04-2.17-3.98 2.17 4.37-4.64 2.09 2.17 3.93-2.17-4.37 4.64z" transform="scale(0.85) translate(2.1, 2.1)"/>
                        </svg>
                        <span className="text-sm">Messenger</span>
                      </div>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        Coming Soon
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Claude Code Credentials */}
              {handlers.claudeCode?.isAvailable ? (
                <div className="border border-border rounded-lg bg-card/60 overflow-hidden">
                  <div className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
                        <img src={claudeIcon} alt="Claude Code" className="w-5 h-5" />
                      </div>
                      <div className="flex flex-col">
                        <h3 className="font-medium">Claude Code</h3>
                        <span className="text-xs text-muted-foreground">
                          Sync Claude Code credentials to reduce usage costs
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={handleClaudeCodeSync}
                      disabled={claudeCodeSyncLoading}
                      className={`h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 ${
                        claudeCodeSynced
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90'
                      }`}
                    >
                      {claudeCodeSyncLoading ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : claudeCodeSynced ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  {claudeCodeSyncLoading && claudeCodeStatus && (
                    <div className="px-4 py-2 flex items-center gap-2 border-t border-border/50">
                      <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                      <span className="text-xs text-muted-foreground">{claudeCodeStatus}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between p-4 border border-border rounded-lg bg-card/60">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
                      <img src={claudeIcon} alt="Claude Code" className="w-5 h-5" />
                    </div>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">Claude Code</h3>
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                          Desktop Only
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        Sync Claude Code credentials to reduce usage costs
                      </span>
                    </div>
                  </div>
                  <Button size="sm" variant="outline" asChild>
                    <a href="/download">Download for Mac</a>
                  </Button>
                </div>
              )}

              {/* Socials - Expandable Section */}
              <div className="rounded-lg border border-border bg-card/60 overflow-hidden">
                {/* Main row */}
                <div className="p-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-background">
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
                        <defs>
                          <linearGradient id="socialsGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="#8b5cf6" />
                            <stop offset="100%" stopColor="#6366f1" />
                          </linearGradient>
                        </defs>
                        <circle cx="5" cy="12" r="2.5" fill="url(#socialsGradient)"/>
                        <circle cx="19" cy="5" r="2.5" fill="url(#socialsGradient)"/>
                        <circle cx="19" cy="19" r="2.5" fill="url(#socialsGradient)"/>
                        <line x1="7.5" y1="11" x2="16.5" y2="6" stroke="url(#socialsGradient)" strokeWidth="1.5"/>
                        <line x1="7.5" y1="13" x2="16.5" y2="18" stroke="url(#socialsGradient)" strokeWidth="1.5"/>
                      </svg>
                    </div>
                    <div className="flex flex-col">
                      <h3 className="font-medium">Socials</h3>
                      <span className="text-xs text-muted-foreground">Connect social media accounts</span>
                    </div>
                  </div>

                  <button
                    onClick={() => setSocialsExpanded(!socialsExpanded)}
                    className="h-9 w-9 rounded-lg flex items-center justify-center transition-all duration-200 bg-primary text-primary-foreground hover:bg-primary/90"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>

                {/* Expanded social options */}
                {socialsExpanded && (
                  <div className="border-t border-border">
                    {/* Twitter/X */}
                    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <svg className="w-6 h-6" viewBox="0 0 24 24">
                          <rect width="24" height="24" rx="5" fill="#000000" />
                          <path fill="white" d="M13.3 10.75L18.18 5h-1.16l-4.23 4.99L9.26 5H5l5.11 7.55L5 19h1.16l4.47-5.27L14.74 19H19l-5.7-8.25zm-1.58 1.87l-.52-.75L6.68 5.92h1.77l3.32 4.83.52.75 4.33 6.29h-1.77l-3.53-5.17z" transform="scale(0.72) translate(4.7, 4.7)"/>
                        </svg>
                        <span className="text-sm">Twitter/X</span>
                      </div>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        Coming Soon
                      </span>
                    </div>

                    {/* LinkedIn */}
                    <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                      <div className="flex items-center gap-3">
                        <svg className="w-6 h-6" viewBox="0 0 24 24">
                          <rect width="24" height="24" rx="5" fill="#0A66C2" />
                          <path fill="white" d="M8.34 18H5.66V9.75h2.68V18zM7 8.62a1.56 1.56 0 1 1 0-3.12 1.56 1.56 0 0 1 0 3.12zM18.34 18h-2.67v-4.02c0-.96-.02-2.19-1.33-2.19-1.34 0-1.54 1.04-1.54 2.12V18h-2.68V9.75h2.57v1.12h.04c.36-.68 1.23-1.39 2.53-1.39 2.7 0 3.2 1.78 3.2 4.1V18z" transform="scale(0.85) translate(2.1, 2.1)"/>
                        </svg>
                        <span className="text-sm">LinkedIn</span>
                      </div>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        Coming Soon
                      </span>
                    </div>

                    {/* Instagram */}
                    <div className="px-4 py-2 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <svg className="w-6 h-6" viewBox="0 0 24 24">
                          <defs>
                            <linearGradient id="igGrad" x1="0%" y1="100%" x2="100%" y2="0%">
                              <stop offset="0%" stopColor="#FFDC80" />
                              <stop offset="25%" stopColor="#F77737" />
                              <stop offset="50%" stopColor="#E1306C" />
                              <stop offset="75%" stopColor="#C13584" />
                              <stop offset="100%" stopColor="#833AB4" />
                            </linearGradient>
                          </defs>
                          <rect width="24" height="24" rx="5" fill="url(#igGrad)" />
                          <rect x="6" y="6" width="12" height="12" rx="3.5" stroke="white" strokeWidth="1.5" fill="none" />
                          <circle cx="12" cy="12" r="3" stroke="white" strokeWidth="1.5" fill="none" />
                          <circle cx="16.5" cy="7.5" r="1" fill="white" />
                        </svg>
                        <span className="text-sm">Instagram</span>
                      </div>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        Coming Soon
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Atlas Browser Data Modal */}
      <AtlasPasswordModal
        isOpen={atlasModalOpen}
        onClose={() => {
          setAtlasModalOpen(false);
          setPendingAtlasBrowser(null);
        }}
        onSync={handleAtlasSync}
        onOpenKeychain={handleOpenKeychain}
        syncType="browser data"
      />

      {/* Apple Passwords Modal */}
      <ApplePasswordsModal
        isOpen={applePasswordsModalOpen}
        onClose={() => setApplePasswordsModalOpen(false)}
        onSync={handleApplePasswordsSync}
      />

      {/* Atlas Passwords Modal */}
      <AtlasPasswordModal
        isOpen={atlasPasswordsModalOpen}
        onClose={() => setAtlasPasswordsModalOpen(false)}
        onSync={handleAtlasPasswordsSync}
        onOpenKeychain={handleOpenKeychain}
        syncType="passwords"
      />
    </div>
  );
}

