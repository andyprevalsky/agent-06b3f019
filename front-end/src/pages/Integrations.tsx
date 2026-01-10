/**
 * STATE MACHINE: Integrations
 *
 *                              [LOADING]
 *                                  |
 *                                  v (fetchIntegrations)
 *       +-------------------[IDLE/READY]-------------------+
 *       |                      |    |                      |
 *       | (file upload)        |    |  (connect provider)  | (handler click)
 *       v                      |    v                      v
 * [FILE_UPLOADING]             |  [CONNECTING_PROVIDER]  [HANDLER_UPLOADING]
 *   uploading=name             |    connectingProvider     uploading=name
 *       |                      |         |                      |
 *       v (success/error)      |         v (popup closes)       v
 *       +----------------------+---------+----------------------+
 *                              v
 *                         [IDLE/READY]
 *
 * States:
 * - loadingIntegrations: true --> LOADING
 * - uploading: string | null --> FILE_UPLOADING or HANDLER_UPLOADING
 * - connectingProvider: 'gmail' | null --> CONNECTING_PROVIDER
 * - error: string | null (shown as banner)
 * - success: string | null (shown as banner)
 * - connectedIntegrations: list of connected integrations
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Linkedin, Twitter, MessageSquare, Mail, MessageCircle, Send, Instagram, Facebook, Chrome, Loader2, Users, Upload, RefreshCw, type LucideIcon } from 'lucide-react';
import { useIntegrationHandlers } from '@/contexts/IntegrationHandlersContext';
import { getStoredSession } from '@/lib/supabase';

const API_BASE_URL = (import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const API_BASE_WITH_PATH = API_BASE_URL.endsWith('/api') ? API_BASE_URL : `${API_BASE_URL}/api`;

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

interface Integration {
  name: string;
  Icon: LucideIcon;
  handlerKey?: 'iMessage' | 'chromeCookies';
  provider?: 'gmail';
  fileUpload?: 'vcf' | 'email-zip';
  /** The key used in the backend to identify this integration */
  backendKey?: string;
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

  const fetchIntegrations = useCallback(async () => {
    try {
      const headers = getAuthHeaders();
      const response = await fetch(`${API_BASE_WITH_PATH}/integrations`, {
        headers,
      });
      if (response.ok) {
        const data = await response.json();
        setConnectedIntegrations(data.integrations || []);
      }
    } catch (err) {
      console.error('Failed to fetch integrations:', err);
    } finally {
      setLoadingIntegrations(false);
    }
  }, []);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  const getConnectedIntegration = (integration: Integration): ConnectedIntegration | undefined => {
    const key = integration.backendKey || integration.provider || integration.name.toLowerCase();
    return connectedIntegrations.find(
      (ci) => ci.name.toLowerCase() === key.toLowerCase() && ci.status === 'CONNECTED'
    );
  };

  const integrations: Integration[] = [
    // { name: 'Contacts (VCF)', Icon: Users, fileUpload: 'vcf', backendKey: 'contacts' },
    // { name: 'Email Export (ZIP)', Icon: Upload, fileUpload: 'email-zip', backendKey: 'email' },
    { name: 'Gmail', Icon: Mail, provider: 'gmail', backendKey: 'gmail' },
    { name: 'iMessage', Icon: MessageSquare, handlerKey: 'iMessage', backendKey: 'imessage' },
    { name: 'Browser Credentials', Icon: Chrome, handlerKey: 'chromeCookies', backendKey: 'chrome_cookies' },
    { name: 'Twitter/X', Icon: Twitter },
    { name: 'LinkedIn', Icon: Linkedin },
    { name: 'WhatsApp', Icon: MessageCircle },
    { name: 'Telegram', Icon: Send },
    { name: 'Instagram', Icon: Instagram },
    { name: 'Facebook Messenger', Icon: Facebook },
  ];

  const handleUpload = async (handlerKey: 'iMessage' | 'chromeCookies', integrationName: string) => {
    setUploading(integrationName);
    setError(null);

    try {
      const handler = handlers[handlerKey];
      if (handler?.onClick) {
        await handler.onClick();
      }
      // Refetch integrations after successful upload
      await fetchIntegrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setUploading(null);
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
            integrations.map((integration) => {
              const Icon = integration.Icon;
              const handler = integration.handlerKey ? handlers[integration.handlerKey] : undefined;
              const hasHandler = handler?.isAvailable;
              const isEmailProvider = Boolean(integration.provider);
              const isConnecting =
                isEmailProvider && connectingProvider === integration.provider;
              const isUploading = uploading === integration.name;
              const connected = getConnectedIntegration(integration);
              const isConnected = Boolean(connected);

              const buttonDisabled = (() => {
                if (integration.fileUpload) {
                  return uploading !== null;
                }
                if (integration.provider) {
                  if (isConnecting) {
                    return true;
                  }
                  return connectingProvider !== null && connectingProvider !== integration.provider;
                }
                if (integration.handlerKey) {
                  if (!hasHandler) {
                    return true;
                  }
                  return uploading !== null;
                }
                return true;
              })();

              const handleClick = () => {
                if (integration.fileUpload === 'vcf') {
                  vcfInputRef.current?.click();
                  return;
                }
                if (integration.fileUpload === 'email-zip') {
                  emailZipInputRef.current?.click();
                  return;
                }
                if (integration.provider) {
                  return handleEmailConnect(integration.provider);
                }
                if (integration.handlerKey && hasHandler) {
                  return handleUpload(integration.handlerKey, integration.name);
                }
                setError('This integration is not available yet.');
              };

              const renderButtonContent = () => {
                if (integration.fileUpload && isUploading) {
                  return (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Uploading...
                    </>
                  );
                }
                if (integration.fileUpload) {
                  return isConnected ? 'Re-upload' : 'Upload';
                }
                if (integration.provider && isConnecting) {
                  return (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Connecting...
                    </>
                  );
                }
                if (integration.handlerKey && isUploading) {
                  return (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Connecting...
                    </>
                  );
                }
                if (isConnected) {
                  return <RefreshCw className="h-4 w-4" />;
                }
                return 'Connect';
              };

              // Build connection info text
              const getConnectionInfo = (): string | null => {
                if (!connected) return null;
                
                // For email providers, show the connected email
                if (connected.config?.connectedEmail) {
                  return connected.config.connectedEmail;
                }
                
                // For iMessage, show contact/message counts
                if (connected.config?.contacts || connected.config?.messages) {
                  const parts = [];
                  if (connected.config.contacts) {
                    parts.push(`${connected.config.contacts} contacts`);
                  }
                  if (connected.config.messages) {
                    parts.push(`${connected.config.messages} messages`);
                  }
                  return parts.join(', ');
                }
                
                // For Chrome Cookies, show cookie count
                if (connected.config?.cookieCount) {
                  return `${connected.config.cookieCount} cookies synced`;
                }
                
                return null;
              };

              const connectionInfo = getConnectionInfo();

              // Desktop-only integrations on web
              const isDesktopOnly = integration.handlerKey && !hasHandler;

              return (
                <div
                  key={integration.name}
                  className="flex items-center justify-between p-4 border border-border rounded-lg bg-card/60"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 flex items-center justify-center">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="flex flex-col">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{integration.name}</h3>
                        {isDesktopOnly && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            Desktop Only
                          </span>
                        )}
                      </div>
                      {isConnected && (
                        <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                          Connected{connectionInfo && <span className="text-muted-foreground">· {connectionInfo}</span>}
                        </span>
                      )}
                    </div>
                  </div>
                  {isDesktopOnly ? (
                    <Button
                      size="sm"
                      variant="outline"
                      asChild
                    >
                      <a href="/download">
                        Download for Mac
                      </a>
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant={isConnected ? 'outline' : 'default'}
                      onClick={handleClick}
                      disabled={buttonDisabled}
                      title={isConnected ? 'Reconnect' : undefined}
                    >
                      {renderButtonContent()}
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

