/* eslint-disable max-lines, max-lines-per-function, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-floating-promises, @typescript-eslint/no-misused-promises --
 * OnboardingData orchestrates 5 distinct integration flows (browser auth, passwords,
 * Gmail OAuth, messaging, Claude Code) with tightly coupled state. Splitting it into
 * per-integration components requires a dedicated refactor that's out of scope for the
 * format-and-lint pass. TODO: track refactor in a follow-up issue; remove this block
 * once the file has been decomposed.
 */
import { useState, useEffect, useRef } from 'react';
import { Loader2, ArrowRight, RefreshCw } from 'lucide-react';
import { usePlaidLink, type PlaidLinkOnSuccessMetadata } from 'react-plaid-link';
import AtlasPasswordModal from '../../../components/AtlasPasswordModal';
import WhatsAppQRModal from '../../../components/WhatsAppQRModal';
import TelegramAuthModal from '../../../components/TelegramAuthModal';
import PasskeysModal from '@/components/PasskeysModal';
import ConnectedStatusText from '@/features/integrations/components/ConnectedStatusText';
import DropdownIconFrame, {
  browserDropdownIconPreset,
  dropdownIconImageClassName,
  dropdownIconPreset,
} from '@/features/integrations/components/DropdownIconFrame';
import PasskeysConnectRow from '@/features/integrations/components/PasskeysConnectRow';
import PlaidLogoIcon from '@/features/integrations/components/PlaidLogoIcon';
import type { BrowserInfo, BrowserType, Integration } from '../types';
import type { AutoFillSettingsResult, PasskeyImportResult } from '../../../../shared/types/ipc';
import { useOnboardingDataApi } from '../hooks';
import { getErrorMessageOrFallback } from '../../../../shared/utils/error';

// Browser icons
import chromeIcon from '../../../assets/chrome-icon.png';
import chatgptIcon from '../../../assets/chatgpt-icon.webp';
import braveIcon from '../../../assets/brave-icon.webp';

interface OnboardingDataProps {
  onComplete: () => void;
}

const AUTO_FILL_PERMISSION_TIMEOUT_MS = 120_000;
const AUTO_FILL_PERMISSION_POLL_MS = 250;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function hasPasskeysIntegration(integrations: Integration[]): boolean {
  return integrations.some(
    (i) => i.status === 'CONNECTED' && i.isActive === true && i.name.endsWith('_passkeys')
  );
}

// Browser icon component
const BrowserIcon = ({
  type,
  className = 'w-4 h-4',
}: {
  type: BrowserType;
  className?: string;
}) => {
  switch (type) {
    case 'chrome':
      return <img src={chromeIcon} alt="Chrome" className={className} />;
    case 'edge':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <defs>
            <linearGradient id="edge1" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#0078D4" />
              <stop offset="100%" stopColor="#1AEBFF" />
            </linearGradient>
            <linearGradient id="edge2" x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#50E6FF" />
              <stop offset="100%" stopColor="#32BEDD" />
            </linearGradient>
          </defs>
          <path
            fill="url(#edge1)"
            d="M24 4C12.95 4 4 12.95 4 24c0 6.63 3.23 12.5 8.2 16.15 1.15-5.35 5.8-9.35 11.35-9.35 3.05 0 5.85 1.2 7.95 3.15C37.5 31.5 42 28.1 42 24c0-11.05-8.05-20-18-20z"
          />
          <path
            fill="url(#edge2)"
            d="M23.55 30.8c-5.55 0-10.2 4-11.35 9.35C16.35 43.1 20 44 24 44c11.05 0 20-8.95 20-20 0 4.1-4.5 7.5-10.5 9.95-2.1-1.95-4.9-3.15-7.95-3.15z"
          />
        </svg>
      );
    case 'brave':
      return <img src={braveIcon} alt="Brave" className={`${className} bg-white rounded`} />;
    case 'arc':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <defs>
            <linearGradient id="arcGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FF6B6B" />
              <stop offset="25%" stopColor="#FF8E53" />
              <stop offset="50%" stopColor="#FFCD56" />
              <stop offset="75%" stopColor="#6BCB77" />
              <stop offset="100%" stopColor="#4D96FF" />
            </linearGradient>
          </defs>
          <circle cx="24" cy="24" r="20" fill="url(#arcGrad)" />
          <circle cx="24" cy="24" r="12" fill="white" />
        </svg>
      );
    case 'opera':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <ellipse cx="24" cy="24" rx="20" ry="22" fill="#FF1B2D" />
          <ellipse cx="24" cy="24" rx="10" ry="16" fill="white" />
        </svg>
      );
    case 'vivaldi':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="22" fill="#EF3939" />
          <path
            fill="white"
            d="M24 8c-8.8 0-16 7.2-16 16s7.2 16 16 16c4 0 7.6-1.5 10.4-3.9L24 24l10.4-12.1C31.6 9.5 28 8 24 8z"
          />
        </svg>
      );
    case 'chromium':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="22" fill="#4587F3" />
          <path fill="#7BAAF7" d="M24 2C12.95 2 4 10.95 4 22h20l9.5-16.5A21.9 21.9 0 0024 2z" />
          <path
            fill="#A8C7FA"
            d="M4 22c0 11.05 8.95 20 20 20 4.57 0 8.78-1.53 12.17-4.1L26.5 22H4z"
          />
          <path fill="#669DF6" d="M24 42c8.28 0 15.35-5.03 18.37-12.2L33.5 16.5 24 22v20z" />
          <circle cx="24" cy="24" r="10" fill="white" />
          <circle cx="24" cy="24" r="8" fill="#4587F3" />
        </svg>
      );
    case 'atlas':
      return <img src={chatgptIcon} alt="ChatGPT" className={`${className} rounded`} />;
    case 'safari':
      return (
        <svg className={className} viewBox="0 0 48 48">
          <defs>
            <radialGradient id="safariDial" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#4FD8FF" />
              <stop offset="100%" stopColor="#0A6CFF" />
            </radialGradient>
          </defs>
          <circle cx="24" cy="24" r="21" fill="url(#safariDial)" />
          <circle cx="24" cy="24" r="17" fill="none" stroke="white" strokeOpacity="0.8" />
          <path d="M24 8v4M24 36v4M8 24h4M36 24h4" stroke="white" strokeWidth="2" />
          <path d="M29 19 19 29l-2-2 10-10z" fill="#EF4444" />
          <path d="M19 29 29 19l2 2-10 10z" fill="white" />
          <circle cx="24" cy="24" r="2.5" fill="white" />
        </svg>
      );
    default:
      return (
        <svg className={className} viewBox="0 0 48 48">
          <circle cx="24" cy="24" r="20" fill="#888" />
          <circle cx="24" cy="24" r="8" fill="white" />
        </svg>
      );
  }
};

const OnboardingData = ({ onComplete }: OnboardingDataProps) => {
  const onboardingDataApi = useOnboardingDataApi();
  const [connectedEmails, setConnectedEmails] = useState<string[]>([]);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  // Plaid (Banking) state
  const [plaidLoading, setPlaidLoading] = useState(false);
  const [connectedBanks, setConnectedBanks] = useState<string[]>([]);
  const [plaidLinkToken, setPlaidLinkToken] = useState<string | null>(null);
  const [plaidError, setPlaidError] = useState<string | null>(null);

  // Browser sync state
  const [installedBrowsers, setInstalledBrowsers] = useState<BrowserInfo[]>([]);
  const [connectedBrowsers, setConnectedBrowsers] = useState<Set<BrowserType>>(new Set());
  const [browserSyncLoading, setBrowserSyncLoading] = useState<BrowserType | null>(null);
  const [browsersExpanded, setBrowsersExpanded] = useState(false);
  const [atlasModalOpen, setAtlasModalOpen] = useState(false);
  const [pendingAtlasBrowser, setPendingAtlasBrowser] = useState<BrowserType | null>(null);

  // Passwords state
  const [passwordsExpanded, setPasswordsExpanded] = useState(false);
  const [passkeysModalOpen, setPasskeysModalOpen] = useState(false);
  const [atlasPasswordsModalOpen, setAtlasPasswordsModalOpen] = useState(false);
  const [chromePasswordsSynced, setChromePasswordsSynced] = useState(false);
  const [applePasswordsSynced, setApplePasswordsSynced] = useState(false);
  const [passkeysSynced, setPasskeysSynced] = useState(false);
  const [atlasPasswordsSynced, setAtlasPasswordsSynced] = useState(false);
  const [passwordSyncLoading, setPasswordSyncLoading] = useState<
    'chrome' | 'passkeys' | 'atlas' | null
  >(null);
  const pendingPasskeyImport = useRef<{
    resolve: (result: PasskeyImportResult) => void;
    reject: (error: Error) => void;
    timeoutId: number;
  } | null>(null);
  // Chat Sync state
  const [chatSyncExpanded, setChatSyncExpanded] = useState(false);

  const [iMessageSynced, setIMessageSynced] = useState(false);
  const [whatsAppConnected, setWhatsAppConnected] = useState(false);
  const [telegramConnected, setTelegramConnected] = useState(false);
  const [chatSyncLoading, setChatSyncLoading] = useState<
    'imessage' | 'whatsapp' | 'telegram' | null
  >(null);
  const [whatsAppQRModalOpen, setWhatsAppQRModalOpen] = useState(false);
  const [whatsAppQRCode, setWhatsAppQRCode] = useState<string | null>(null);
  const [telegramAuthModalOpen, setTelegramAuthModalOpen] = useState(false);
  const whatsAppQRCleanupRef = useRef<(() => void) | null>(null);

  // Socials state
  const [socialsExpanded, setSocialsExpanded] = useState(false);
  const [linkedinSyncLoading, setLinkedinSyncLoading] = useState(false);

  // Accordion behavior - expand one section, collapse others
  const handleBrowsersExpand = () => {
    setBrowsersExpanded(!browsersExpanded);
    if (!browsersExpanded) {
      setPasswordsExpanded(false);
      setChatSyncExpanded(false);
      setSocialsExpanded(false);
    }
  };

  const handlePasswordsExpand = () => {
    setPasswordsExpanded(!passwordsExpanded);
    if (!passwordsExpanded) {
      setBrowsersExpanded(false);
      setChatSyncExpanded(false);
      setSocialsExpanded(false);
    }
  };

  const handleChatSyncExpand = () => {
    setChatSyncExpanded(!chatSyncExpanded);
    if (!chatSyncExpanded) {
      setBrowsersExpanded(false);
      setPasswordsExpanded(false);
      setSocialsExpanded(false);
    }
  };

  const handleSocialsExpand = () => {
    setSocialsExpanded(!socialsExpanded);
    if (!socialsExpanded) {
      setBrowsersExpanded(false);
      setPasswordsExpanded(false);
      setChatSyncExpanded(false);
    }
  };

  // Clean up WhatsApp QR listener on unmount
  useEffect(() => {
    return () => {
      whatsAppQRCleanupRef.current?.();
    };
  }, []);

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

        // Fetch existing integrations via api layer
        const integrations: Integration[] = await onboardingDataApi.fetchIntegrations();

        // Check for browser integrations (chrome, edge, atlas, etc.)
        const validBrowserTypes = [
          'chrome',
          'edge',
          'brave',
          'arc',
          'opera',
          'vivaldi',
          'chromium',
          'atlas',
          'safari',
          'firefox',
        ];
        const newConnectedBrowsers = new Set<BrowserType>();
        for (const integration of integrations) {
          if (validBrowserTypes.includes(integration.name) && integration.status === 'CONNECTED') {
            newConnectedBrowsers.add(integration.name as BrowserType);
          }
        }
        setConnectedBrowsers(newConnectedBrowsers);

        // Check for password integrations
        const chromeIntegration = integrations.find(
          (i: Integration) => i.name === 'chrome' && i.status === 'CONNECTED'
        );
        setChromePasswordsSynced(!!chromeIntegration);

        const applePasswordsIntegration = integrations.find(
          (i: Integration) => i.name === 'apple_passwords' && i.status === 'CONNECTED'
        );
        setApplePasswordsSynced(!!applePasswordsIntegration);

        const atlasPasswordsIntegration = integrations.find(
          (i: Integration) => i.name === 'atlas_passwords' && i.status === 'CONNECTED'
        );
        setAtlasPasswordsSynced(!!atlasPasswordsIntegration);
        setPasskeysSynced(hasPasskeysIntegration(integrations));

        // Check for gmail integration(s) - use connectedEmails array if available, fallback to connectedEmail
        // Treat CONNECTED or SYNCING as connected (SYNCING means OAuth succeeded, just processing emails)
        const gmailIntegration = integrations.find((i) => i.name === 'gmail');
        const isGmailConnected =
          gmailIntegration?.status === 'CONNECTED' || gmailIntegration?.status === 'SYNCING';
        if (isGmailConnected) {
          if (
            gmailIntegration.config?.connectedEmails &&
            gmailIntegration.config.connectedEmails.length > 0
          ) {
            setConnectedEmails(gmailIntegration.config.connectedEmails);
          } else if (gmailIntegration.config?.connectedEmail) {
            setConnectedEmails([gmailIntegration.config.connectedEmail]);
          }
        }

        // Check for messaging integrations
        const imessageIntegration = integrations.find(
          (i: Integration) => i.name === 'imessage' && i.status === 'CONNECTED'
        );
        setIMessageSynced(!!imessageIntegration);

        const whatsappIntegration = integrations.find(
          (i: Integration) => i.name === 'whatsapp' && i.status === 'CONNECTED'
        );
        setWhatsAppConnected(!!whatsappIntegration);

        const telegramIntegration = integrations.find(
          (i: Integration) => i.name === 'telegram' && i.status === 'CONNECTED'
        );
        setTelegramConnected(!!telegramIntegration);

        // Hydrate connected banks (Plaid items)
        try {
          const plaidItems = await onboardingDataApi.fetchPlaidItems();
          setConnectedBanks(
            plaidItems
              .filter((i) => i.status === 'ACTIVE')
              .map((i) => i.institutionName ?? 'Connected institution')
          );
        } catch (err) {
          // Plaid hydration failures are non-fatal during onboarding.
          console.error('Failed to fetch Plaid items:', err);
        }
      } catch (err) {
        console.error('Failed to fetch data:', err);
      } finally {
        setInitialLoading(false);
      }
    };

    fetchData();
  }, [onboardingDataApi]);

  // Continue is only available when at least one browser is connected and at least one email
  const canContinue = connectedBrowsers.size > 0 && connectedEmails.length > 0;

  const refreshCredentialIntegrations = async () => {
    const integrations = await onboardingDataApi.fetchIntegrations();
    const applePasswordsIntegration = integrations.find(
      (i: Integration) =>
        i.name === 'apple_passwords' && i.status === 'CONNECTED' && i.isActive === true
    );
    setApplePasswordsSynced(!!applePasswordsIntegration);
    setPasskeysSynced(hasPasskeysIntegration(integrations));
  };

  const finishPendingPasskeyImport = (result: PasskeyImportResult) => {
    const pending = pendingPasskeyImport.current;
    if (pending === null) return;

    window.clearTimeout(pending.timeoutId);
    pendingPasskeyImport.current = null;

    const importedPasskeys = result.passkeyCount ?? result.count ?? 0;
    const importedPasswords = result.passwordCount ?? 0;
    if (result.success && (importedPasskeys > 0 || importedPasswords > 0)) {
      pending.resolve(result);
      return;
    }

    pending.reject(new Error(result.message ?? 'No credentials were transferred'));
  };

  const waitForPasskeyImport = () => {
    if (pendingPasskeyImport.current !== null) {
      window.clearTimeout(pendingPasskeyImport.current.timeoutId);
      pendingPasskeyImport.current.reject(new Error('A newer Apple Passwords sync was started'));
      pendingPasskeyImport.current = null;
    }

    return new Promise<PasskeyImportResult>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingPasskeyImport.current = null;
        reject(new Error('Apple Passwords did not send Rose an import token'));
      }, 120_000);
      pendingPasskeyImport.current = { resolve, reject, timeoutId };
    });
  };

  const waitForAutoFillEnabled = async (
    initialResult: AutoFillSettingsResult
  ): Promise<AutoFillSettingsResult> => {
    if (initialResult.enabled === true) {
      return initialResult;
    }
    if (!window.api?.checkAutoFillSettings) {
      throw new Error('Enable Rose in AutoFill, then click Sync again');
    }

    const deadline = Date.now() + AUTO_FILL_PERMISSION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await wait(AUTO_FILL_PERMISSION_POLL_MS);
      const status = await window.api.checkAutoFillSettings();
      if (status.success && status.enabled === true) {
        return status;
      }
    }

    throw new Error('Timed out waiting for Rose AutoFill permission');
  };

  useEffect(() => {
    return window.api?.onPasskeysImportComplete?.((result) => {
      const importedPasskeys = result.passkeyCount ?? result.count ?? 0;
      const importedPasswords = result.passwordCount ?? 0;
      if (result.success && (importedPasskeys > 0 || importedPasswords > 0)) {
        setPasskeysModalOpen(false);
      }
      finishPendingPasskeyImport(result);
      setPasswordSyncLoading(null);
      void refreshCredentialIntegrations();
    });
  }, [onboardingDataApi]);

  useEffect(() => {
    return () => {
      if (pendingPasskeyImport.current !== null) {
        window.clearTimeout(pendingPasskeyImport.current.timeoutId);
        pendingPasskeyImport.current.reject(new Error('Apple Passwords sync was cancelled'));
        pendingPasskeyImport.current = null;
      }
    };
  }, []);

  // Handle browser sync click - syncs all browser data in parallel
  const handleBrowserSync = async (browserType: BrowserType) => {
    const browser = installedBrowsers.find((b) => b.type === browserType);
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
        setConnectedBrowsers((prev) => new Set([...prev, browserType]));
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
      const result = await window.api.syncBrowser(pendingAtlasBrowser, {
        keychainPassword: password,
      });
      if (result.success) {
        setConnectedBrowsers((prev) => new Set([...prev, pendingAtlasBrowser]));

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

  const handlePasskeysConnect = async () => {
    if (!window.api?.openAutoFillSettings) return;
    setPasswordSyncLoading('passkeys');
    try {
      const result = await window.api.openAutoFillSettings();
      if (!result.success) {
        throw new Error(result.message ?? 'Failed to open AutoFill settings');
      }
      const enabledResult = await waitForAutoFillEnabled(result);
      const passwordsResult = await window.api.openPasswordsApp();
      if (!passwordsResult.success) {
        throw new Error('Failed to open Apple Passwords');
      }
      await waitForPasskeyImport();
      return { ...enabledResult, openedPasswordsApp: true };
    } catch (err) {
      console.error('Failed to connect passkeys:', err);
      throw err;
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

  // Handle iMessage sync
  const handleIMessageSync = async () => {
    setChatSyncLoading('imessage');
    try {
      // Check for Full Disk Access first
      const hasAccess = await window.api.checkIMessageAccess();
      if (!hasAccess) {
        // Open Full Disk Access settings
        await window.api.openFullDiskAccessSettings();
        return;
      }

      // Start iMessage upload
      const result = await window.api.startIMessageUpload();
      if (result.success) {
        setIMessageSynced(true);
      } else {
        console.error('Failed to sync iMessage:', result.message);
      }
    } catch (err) {
      console.error('Failed to sync iMessage:', err);
    } finally {
      setChatSyncLoading(null);
    }
  };

  // Handle WhatsApp connect
  const handleWhatsAppConnect = async () => {
    if (!window.api.whatsapp) {
      console.error('WhatsApp API not available');
      return;
    }

    setChatSyncLoading('whatsapp');
    try {
      // Check if already has credentials
      const hasCredentials = await window.api.whatsapp.hasCredentials();
      if (hasCredentials) {
        // Try to connect with existing credentials
        const result = await window.api.whatsapp.connect();
        if (result.success) {
          setWhatsAppConnected(true);
          setChatSyncLoading(null);
          return;
        }
      }

      // Set up QR code listener (clean up previous one first)
      if (window.api.onWhatsAppQRCode) {
        whatsAppQRCleanupRef.current?.();
        whatsAppQRCleanupRef.current = window.api.onWhatsAppQRCode((qr: string) => {
          setWhatsAppQRCode(qr);
        });
      }

      // Open QR modal and start connection
      setWhatsAppQRModalOpen(true);
      const result = await window.api.whatsapp.connect();
      if (result.success) {
        setWhatsAppConnected(true);
        setWhatsAppQRModalOpen(false);
        setWhatsAppQRCode(null);
      } else {
        console.error('Failed to connect WhatsApp:', result.error);
      }
    } catch (err) {
      console.error('Failed to connect WhatsApp:', err);
    } finally {
      setChatSyncLoading(null);
    }
  };

  // Handle Telegram connect/resync
  const handleTelegramConnect = async () => {
    if (!window.api.telegram) {
      console.error('Telegram API not available');
      return;
    }

    setChatSyncLoading('telegram');
    try {
      // Check if already connected - if so, just resync historical
      const isConnected = await window.api.telegram.isConnected();
      if (isConnected) {
        console.log('Telegram already connected, resyncing historical...');
        const result = await window.api.telegram.syncHistorical();
        console.log(`Telegram resync complete: ${result.count ?? 0} messages`);
        setChatSyncLoading(null);
        return;
      }

      // Check if has saved session - try to reconnect
      const hasSession = await window.api.telegram.hasSession();
      if (hasSession) {
        // Try to connect with existing session (triggers historical sync automatically)
        const result = await window.api.telegram.connectWithExistingSession();
        if (result.success) {
          setTelegramConnected(true);
          setChatSyncLoading(null);
          return;
        }
      }

      // No session - open auth modal for phone/code flow
      setTelegramAuthModalOpen(true);
    } catch (err) {
      console.error('Failed to connect Telegram:', err);
    } finally {
      setChatSyncLoading(null);
    }
  };

  // Handle LinkedIn sync - spawns an agent to download LinkedIn data export
  const handleLinkedInSync = async () => {
    setLinkedinSyncLoading(true);
    try {
      await onboardingDataApi.spawnLinkedInSyncAgent();
      console.log('[LinkedIn] Sync agent started successfully');
    } catch (err) {
      console.error('[LinkedIn] Failed to start sync agent:', err);
    } finally {
      setLinkedinSyncLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Plaid (Banking) lifecycle
  // ---------------------------------------------------------------------------

  const handlePlaidSuccess = async (
    publicToken: string,
    metadata: PlaidLinkOnSuccessMetadata
  ): Promise<void> => {
    try {
      await onboardingDataApi.exchangePlaidPublicToken({
        publicToken,
        institutionId: metadata.institution?.institution_id,
        institutionName: metadata.institution?.name,
      });
      const items = await onboardingDataApi.fetchPlaidItems();
      setConnectedBanks(
        items
          .filter((i) => i.status === 'ACTIVE')
          .map((i) => i.institutionName ?? 'Connected institution')
      );
      setPlaidError(null);
    } catch (err) {
      setPlaidError(getErrorMessageOrFallback(err, 'Failed to connect bank'));
    } finally {
      setPlaidLoading(false);
      setPlaidLinkToken(null);
    }
  };

  const handlePlaidExit = (
    err: { display_message?: string; error_message?: string } | null
  ): void => {
    if (err) {
      setPlaidError(err.display_message ?? err.error_message ?? 'Plaid Link exited');
    }
    setPlaidLoading(false);
    setPlaidLinkToken(null);
  };

  const plaidLink = usePlaidLink({
    token: plaidLinkToken,
    onSuccess: (publicToken: string, metadata: PlaidLinkOnSuccessMetadata): void => {
      void handlePlaidSuccess(publicToken, metadata);
    },
    onExit: (err: { display_message?: string; error_message?: string } | null): void => {
      handlePlaidExit(err);
    },
  });

  useEffect(() => {
    if (plaidLinkToken !== null && plaidLink.ready) {
      plaidLink.open();
    }
  }, [plaidLinkToken, plaidLink.ready]);

  const handlePlaidConnect = async (): Promise<void> => {
    setPlaidError(null);
    setPlaidLoading(true);
    try {
      const tokenResp = await onboardingDataApi.createPlaidLinkToken();
      setPlaidLinkToken(tokenResp.link_token);
    } catch (err) {
      setPlaidError(getErrorMessageOrFallback(err, 'Failed to create Plaid link token'));
      setPlaidLoading(false);
    }
  };

  // Handle Gmail OAuth connect
  const handleGmailConnect = async () => {
    setGmailLoading(true);
    try {
      const authUrl = await onboardingDataApi.startGmailOAuth();

      const width = 500;
      const height = 600;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      // In Electron, window.open is intercepted by setWindowOpenHandler which opens
      // in the system browser and returns null. Use openExternal as primary path.
      const api = window.api;
      if (api?.openExternal) {
        await api.openExternal(authUrl);
      } else {
        window.open(
          authUrl,
          'gmail-oauth',
          `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`
        );
      }

      // Poll backend for integration status (works regardless of popup or external browser)
      const pollForConnection = setInterval(async () => {
        try {
          const integrations: Integration[] = await onboardingDataApi.fetchIntegrations();
          const gmailIntegration = integrations.find((i) => i.name === 'gmail');
          const isGmailConnected =
            gmailIntegration?.status === 'CONNECTED' || gmailIntegration?.status === 'SYNCING';

          if (isGmailConnected) {
            clearInterval(pollForConnection);
            if (
              gmailIntegration.config?.connectedEmails &&
              gmailIntegration.config.connectedEmails.length > 0
            ) {
              setConnectedEmails(gmailIntegration.config.connectedEmails);
            } else if (gmailIntegration.config?.connectedEmail) {
              const email = gmailIntegration.config.connectedEmail;
              setConnectedEmails((prev) => (prev.includes(email) ? prev : [...prev, email]));
            }
            setGmailLoading(false);
          }
        } catch (err) {
          console.error('Failed to poll integrations:', err);
        }
      }, 2000);

      // Stop polling after 2 minutes (user may have cancelled)
      setTimeout(() => {
        clearInterval(pollForConnection);
        setGmailLoading(false);
      }, 120000);
    } catch (err) {
      console.error('Failed to connect Gmail:', err);
      setGmailLoading(false);
    }
  };

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
        <h1 className="text-2xl font-semibold text-foreground mb-2">Connect your Data</h1>
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
                <DropdownIconFrame
                  {...dropdownIconPreset.browserMain}
                  isSynced={connectedBrowsers.size > 0}
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    <defs>
                      <radialGradient id="browserCookieGradient" cx="30%" cy="30%" r="70%">
                        <stop offset="26%" stopColor="rgb(9,78,255)" />
                        <stop offset="63%" stopColor="rgb(33,130,255)" />
                        <stop offset="100%" stopColor="rgb(57,182,255)" />
                      </radialGradient>
                    </defs>
                    <path
                      fill="url(#browserCookieGradient)"
                      d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
                    />
                  </svg>
                </DropdownIconFrame>
                <div>
                  <div className="font-medium text-sm text-foreground">Browser Sync</div>
                  <div className="text-xs text-muted-foreground">
                    Sync browsing data for web automation
                  </div>
                </div>
              </div>

              <button
                onClick={handleBrowsersExpand}
                className="h-10 w-10 rounded-lg flex items-center justify-center transition-all duration-200 bg-foreground text-background hover:bg-foreground/90"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {/* Expanded browser list */}
            {browsersExpanded && (
              <div className="border-t border-border">
                {installedBrowsers.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-muted-foreground">
                    No supported browsers detected. Install Safari, Chrome, Edge, Brave, Arc, or
                    another supported browser.
                  </div>
                ) : (
                  installedBrowsers.map((browser, index) => {
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
                          <DropdownIconFrame
                            {...browserDropdownIconPreset(browser.type)}
                            isSynced={isConnected}
                          >
                            <BrowserIcon
                              type={browser.type}
                              className={dropdownIconImageClassName}
                            />
                          </DropdownIconFrame>
                          <div className="flex flex-col items-start">
                            <span className="text-sm text-foreground">{browser.name}</span>
                            <ConnectedStatusText isConnected={isConnected} />
                          </div>
                        </div>

                        <button
                          onClick={() => handleBrowserSync(browser.type)}
                          disabled={isLoading}
                          className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                        >
                          {isLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Passwords Connector - Expandable Section */}
          <div className="rounded-xl border transition-all duration-200 bg-card border-border overflow-hidden">
            {/* Main row */}
            <div className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <DropdownIconFrame
                  {...dropdownIconPreset.passwordsMain}
                  isSynced={
                    chromePasswordsSynced ||
                    applePasswordsSynced ||
                    passkeysSynced ||
                    atlasPasswordsSynced
                  }
                >
                  <svg
                    className="w-5 h-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="url(#keyGradientOnboarding)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <defs>
                      <linearGradient
                        id="keyGradientOnboarding"
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="100%"
                      >
                        <stop offset="0%" stopColor="#f59e0b" />
                        <stop offset="100%" stopColor="#fcd34d" />
                      </linearGradient>
                    </defs>
                    <path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" />
                  </svg>
                </DropdownIconFrame>
                <div>
                  <div className="font-medium text-sm text-foreground">Passwords</div>
                  <div className="text-xs text-muted-foreground">Auto-fill login credentials</div>
                </div>
              </div>

              <button
                onClick={handlePasswordsExpand}
                className="h-10 w-10 rounded-lg flex items-center justify-center transition-all duration-200 bg-foreground text-background hover:bg-foreground/90"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {/* Expanded password options */}
            {passwordsExpanded && (
              <div className="border-t border-border">
                {/* Chrome passwords */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <DropdownIconFrame
                      {...dropdownIconPreset.chrome}
                      isSynced={chromePasswordsSynced}
                    >
                      <img src={chromeIcon} alt="Chrome" className={dropdownIconImageClassName} />
                    </DropdownIconFrame>
                    <div className="flex flex-col items-start">
                      <span className="text-sm text-foreground">Chrome</span>
                      <ConnectedStatusText isConnected={chromePasswordsSynced} />
                    </div>
                  </div>

                  <button
                    onClick={handleChromePasswordsSync}
                    disabled={passwordSyncLoading === 'chrome'}
                    className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  >
                    {passwordSyncLoading === 'chrome' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                <PasskeysConnectRow
                  isAvailable={Boolean(window.api?.openAutoFillSettings)}
                  isSynced={applePasswordsSynced || passkeysSynced}
                  isLoading={passwordSyncLoading === 'passkeys'}
                  onConnect={() => setPasskeysModalOpen(true)}
                />

                {/* ChatGPT Atlas Passwords */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <DropdownIconFrame
                      {...dropdownIconPreset.atlas}
                      isSynced={atlasPasswordsSynced}
                    >
                      <img
                        src={chatgptIcon}
                        alt="ChatGPT Atlas"
                        className={dropdownIconImageClassName}
                      />
                    </DropdownIconFrame>
                    <div className="flex flex-col items-start">
                      <span className="text-sm text-foreground">ChatGPT Atlas</span>
                      <ConnectedStatusText isConnected={atlasPasswordsSynced} />
                    </div>
                  </div>

                  <button
                    onClick={() => setAtlasPasswordsModalOpen(true)}
                    disabled={passwordSyncLoading === 'atlas'}
                    className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  >
                    {passwordSyncLoading === 'atlas' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Messages - Expandable */}
          <div className="rounded-xl border transition-all duration-200 bg-card border-border overflow-hidden">
            {/* Main row */}
            <div className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <DropdownIconFrame
                  {...dropdownIconPreset.messagesMain}
                  isSynced={
                    iMessageSynced ||
                    whatsAppConnected ||
                    telegramConnected ||
                    connectedEmails.length > 0
                  }
                >
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
                    <defs>
                      <linearGradient id="chatSyncGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="#34d399" />
                        <stop offset="100%" stopColor="#10b981" />
                      </linearGradient>
                    </defs>
                    <path
                      fill="url(#chatSyncGradient)"
                      transform="scale(-1,1)"
                      transform-origin="center"
                      d="M20 2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h14l4 4V4c0-1.1-.9-2-2-2z"
                    />
                  </svg>
                </DropdownIconFrame>
                <div>
                  <div className="font-medium text-sm text-foreground">Messages</div>
                  <div className="text-xs text-muted-foreground">Sync messaging clients</div>
                </div>
              </div>

              <button
                onClick={handleChatSyncExpand}
                className="h-10 w-10 rounded-lg flex items-center justify-center transition-all duration-200 bg-foreground text-background hover:bg-foreground/90"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {/* Expanded chat options */}
            {chatSyncExpanded && (
              <div className="border-t border-border">
                {/* iMessage */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <DropdownIconFrame {...dropdownIconPreset.imessage} isSynced={iMessageSynced}>
                      <svg className="w-6 h-6" viewBox="0 0 24 24">
                        <defs>
                          <linearGradient id="imessageGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#5bf675" />
                            <stop offset="100%" stopColor="#1fcc3f" />
                          </linearGradient>
                        </defs>
                        <rect width="24" height="24" rx="5" fill="url(#imessageGrad)" />
                        <path
                          fill="white"
                          d="M12 5C7.58 5 4 8.13 4 12c0 1.65.67 3.15 1.76 4.35L5 19l2.88-.93C9.05 18.66 10.48 19 12 19c4.42 0 8-3.13 8-7s-3.58-7-8-7z"
                        />
                      </svg>
                    </DropdownIconFrame>
                    <div className="flex flex-col items-start">
                      <span className="text-sm text-foreground">iMessage</span>
                      <ConnectedStatusText isConnected={iMessageSynced} />
                    </div>
                  </div>

                  <button
                    onClick={handleIMessageSync}
                    disabled={chatSyncLoading === 'imessage'}
                    className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  >
                    {chatSyncLoading === 'imessage' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* WhatsApp */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <DropdownIconFrame
                      {...dropdownIconPreset.whatsapp}
                      isSynced={whatsAppConnected}
                    >
                      <svg className="w-6 h-6" viewBox="0 0 24 24">
                        <rect width="24" height="24" rx="5" fill="#25D366" />
                        <path
                          fill="white"
                          d="M12 4c-4.42 0-8 3.58-8 8 0 1.41.37 2.73 1.01 3.88L4 20l4.26-1.12A7.93 7.93 0 0 0 12 20c4.42 0 8-3.58 8-8s-3.58-8-8-8zm4.14 11.07c-.17.48-1 .93-1.38.99-.37.06-.84.09-1.35-.09-.31-.11-.71-.25-1.23-.49-2.16-1-3.57-3.18-3.68-3.33-.1-.15-.86-1.14-.86-2.18s.55-1.55.74-1.76c.2-.21.43-.27.57-.27h.42c.13 0 .31-.05.48.37.18.43.61 1.49.66 1.59.05.1.08.22.02.35-.07.14-.1.22-.2.34-.1.12-.21.26-.3.35-.1.1-.2.2-.09.4.12.2.53.87 1.13 1.41.78.7 1.43.91 1.63 1.02.2.1.32.09.44-.06.12-.14.5-.58.64-.78.13-.2.27-.16.45-.1.18.07 1.15.54 1.34.64.2.1.33.15.38.23.05.09.05.51-.12.99z"
                        />
                      </svg>
                    </DropdownIconFrame>
                    <div className="flex flex-col items-start">
                      <span className="text-sm text-foreground">WhatsApp</span>
                      <ConnectedStatusText isConnected={whatsAppConnected} />
                    </div>
                  </div>

                  <button
                    onClick={handleWhatsAppConnect}
                    disabled={chatSyncLoading === 'whatsapp'}
                    className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  >
                    {chatSyncLoading === 'whatsapp' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* Telegram */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <DropdownIconFrame
                      {...dropdownIconPreset.telegram}
                      isSynced={telegramConnected}
                    >
                      <svg className="w-6 h-6" viewBox="0 0 24 24">
                        <rect width="24" height="24" rx="5" fill="#229ED9" />
                        <path
                          fill="white"
                          d="M5.5 11.5l10.7-4.3c.6-.24 1.1.12.9.92l-1.9 9c-.14.64-.52.8-1.06.5l-2.9-2.1-1.4 1.4c-.12.1-.2.2-.4.2-.26 0-.37-.15-.5-.52l-1.1-3.5-2.7-.84c-.32-.11-.34-.41.06-.56zm4.7 1.7l.6 2.55.17-1.85 4.5-4c.2-.18-.05-.27-.32-.1l-5.5 3.4z"
                          transform="translate(12, 12) scale(1.05) translate(-12, -12)"
                        />
                      </svg>
                    </DropdownIconFrame>
                    <div className="flex flex-col items-start">
                      <span className="text-sm text-foreground">Telegram</span>
                      <ConnectedStatusText isConnected={telegramConnected} />
                    </div>
                  </div>

                  <button
                    onClick={handleTelegramConnect}
                    disabled={chatSyncLoading === 'telegram'}
                    className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  >
                    {chatSyncLoading === 'telegram' ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* Gmail */}
                <div className="px-4 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <DropdownIconFrame
                      {...dropdownIconPreset.gmail}
                      isSynced={connectedEmails.length > 0}
                    >
                      <svg className="w-6 h-6" viewBox="0 0 24 24">
                        <path
                          fill="#EA4335"
                          d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"
                        />
                      </svg>
                    </DropdownIconFrame>
                    <div className="flex min-w-0 flex-col">
                      <span className="text-sm text-foreground">Gmail</span>
                      <ConnectedStatusText isConnected={connectedEmails.length > 0} />
                      {connectedEmails.length > 0 && (
                        <div className="mt-0.5 flex min-w-0 flex-col">
                          {connectedEmails.map((email) => (
                            <span key={email} className="truncate text-xs text-muted-foreground">
                              {email}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={handleGmailConnect}
                    disabled={gmailLoading}
                    className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  >
                    {gmailLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Socials - Expandable */}
          <div className="rounded-xl border transition-all duration-200 bg-card border-border overflow-hidden">
            {/* Main row */}
            <div className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <DropdownIconFrame {...dropdownIconPreset.socialsMain}>
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none">
                    <defs>
                      <linearGradient
                        id="socialsGradientOnboarding"
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="100%"
                      >
                        <stop offset="0%" stopColor="#8b5cf6" />
                        <stop offset="100%" stopColor="#6366f1" />
                      </linearGradient>
                    </defs>
                    <circle cx="5" cy="12" r="2.5" fill="url(#socialsGradientOnboarding)" />
                    <circle cx="19" cy="5" r="2.5" fill="url(#socialsGradientOnboarding)" />
                    <circle cx="19" cy="19" r="2.5" fill="url(#socialsGradientOnboarding)" />
                    <line
                      x1="7.5"
                      y1="11"
                      x2="16.5"
                      y2="6"
                      stroke="url(#socialsGradientOnboarding)"
                      strokeWidth="1.5"
                    />
                    <line
                      x1="7.5"
                      y1="13"
                      x2="16.5"
                      y2="18"
                      stroke="url(#socialsGradientOnboarding)"
                      strokeWidth="1.5"
                    />
                  </svg>
                </DropdownIconFrame>
                <div>
                  <div className="font-medium text-sm text-foreground">Socials</div>
                  <div className="text-xs text-muted-foreground">Connect social media accounts</div>
                </div>
              </div>

              <button
                onClick={handleSocialsExpand}
                className="h-10 w-10 rounded-lg flex items-center justify-center transition-all duration-200 bg-foreground text-background hover:bg-foreground/90"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {/* Expanded social options */}
            {socialsExpanded && (
              <div className="border-t border-border">
                {/* X */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <DropdownIconFrame {...dropdownIconPreset.x}>
                      <svg className="w-6 h-6" viewBox="0 0 24 24">
                        <rect width="24" height="24" rx="5" fill="#000000" />
                        <path
                          fill="white"
                          d="M13.3 10.75L18.18 5h-1.16l-4.23 4.99L9.26 5H5l5.11 7.55L5 19h1.16l4.47-5.27L14.74 19H19l-5.7-8.25zm-1.58 1.87l-.52-.75L6.68 5.92h1.77l3.32 4.83.52.75 4.33 6.29h-1.77l-3.53-5.17z"
                          transform="scale(0.72) translate(4.7, 4.7)"
                        />
                      </svg>
                    </DropdownIconFrame>
                    <span className="text-sm text-foreground">X</span>
                  </div>
                  <span className="text-xs text-muted-foreground italic">Coming soon</span>
                </div>

                {/* LinkedIn */}
                <div className="px-4 py-2 flex items-center justify-between border-b border-border/50">
                  <div className="flex items-center gap-3">
                    <DropdownIconFrame {...dropdownIconPreset.linkedin}>
                      <svg className="w-6 h-6" viewBox="0 0 24 24">
                        <rect width="24" height="24" rx="5" fill="#0A66C2" />
                        <path
                          fill="white"
                          d="M8.34 18H5.66V9.75h2.68V18zM7 8.62a1.56 1.56 0 1 1 0-3.12 1.56 1.56 0 0 1 0 3.12zM18.34 18h-2.67v-4.02c0-.96-.02-2.19-1.33-2.19-1.34 0-1.54 1.04-1.54 2.12V18h-2.68V9.75h2.57v1.12h.04c.36-.68 1.23-1.39 2.53-1.39 2.7 0 3.2 1.78 3.2 4.1V18z"
                          transform="scale(0.85) translate(2.1, 2.1)"
                        />
                      </svg>
                    </DropdownIconFrame>
                    <span className="text-sm text-foreground">LinkedIn</span>
                  </div>
                  <button
                    onClick={handleLinkedInSync}
                    disabled={linkedinSyncLoading}
                    className="h-8 w-8 rounded-md flex items-center justify-center transition-all duration-200 bg-muted hover:bg-muted/80 text-muted-foreground hover:text-foreground"
                  >
                    {linkedinSyncLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                {/* Instagram */}
                <div className="px-4 py-2 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <DropdownIconFrame {...dropdownIconPreset.instagram}>
                      <svg className="w-6 h-6" viewBox="0 0 24 24">
                        <defs>
                          <linearGradient id="igGradOnboarding" x1="0%" y1="100%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="#FFDC80" />
                            <stop offset="25%" stopColor="#F77737" />
                            <stop offset="50%" stopColor="#E1306C" />
                            <stop offset="75%" stopColor="#C13584" />
                            <stop offset="100%" stopColor="#833AB4" />
                          </linearGradient>
                        </defs>
                        <rect width="24" height="24" rx="5" fill="url(#igGradOnboarding)" />
                        <rect
                          x="6"
                          y="6"
                          width="12"
                          height="12"
                          rx="3.5"
                          stroke="white"
                          strokeWidth="1.5"
                          fill="none"
                        />
                        <circle
                          cx="12"
                          cy="12"
                          r="3"
                          stroke="white"
                          strokeWidth="1.5"
                          fill="none"
                        />
                        <circle cx="16.5" cy="7.5" r="1" fill="white" />
                      </svg>
                    </DropdownIconFrame>
                    <span className="text-sm text-foreground">Instagram</span>
                  </div>
                  <span className="text-xs text-muted-foreground italic">Coming soon</span>
                </div>
              </div>
            )}
          </div>

          {/* Banking (Plaid) */}
          <div className="rounded-xl border transition-all duration-200 bg-card border-border overflow-hidden">
            <div className="p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <DropdownIconFrame
                  {...dropdownIconPreset.plaid}
                  isSynced={connectedBanks.length > 0}
                >
                  <PlaidLogoIcon />
                </DropdownIconFrame>
                <div>
                  <div className="font-medium text-sm text-foreground">Banking</div>
                  <ConnectedStatusText isConnected={connectedBanks.length > 0} />
                  <div className="truncate text-xs text-muted-foreground">
                    {connectedBanks.length > 0
                      ? connectedBanks.join(', ')
                      : 'Connect a bank account via Plaid'}
                  </div>
                </div>
              </div>

              <button
                onClick={() => {
                  void handlePlaidConnect();
                }}
                disabled={plaidLoading}
                aria-label="Connect a bank via Plaid"
                className="h-10 w-10 rounded-lg flex items-center justify-center transition-all duration-200 bg-foreground text-background hover:bg-foreground/90 disabled:opacity-60"
              >
                {plaidLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
              </button>
            </div>
            {plaidError !== null && (
              <div className="px-4 py-2 border-t border-border/50 text-xs text-destructive">
                {plaidError}
              </div>
            )}
          </div>
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

      {/* Apple Passwords & Passkeys Modal */}
      <PasskeysModal
        isOpen={passkeysModalOpen}
        onClose={() => setPasskeysModalOpen(false)}
        onSync={handlePasskeysConnect}
      />

      {/* Atlas Passwords Modal (reuses AtlasPasswordModal for keychain password entry) */}
      <AtlasPasswordModal
        isOpen={atlasPasswordsModalOpen}
        onClose={() => setAtlasPasswordsModalOpen(false)}
        onSync={handleAtlasPasswordsSync}
        syncType="passwords"
      />

      {/* WhatsApp QR Modal */}
      <WhatsAppQRModal
        isOpen={whatsAppQRModalOpen}
        onClose={() => {
          setWhatsAppQRModalOpen(false);
          setWhatsAppQRCode(null);
        }}
        qrCode={whatsAppQRCode}
        isConnecting={chatSyncLoading === 'whatsapp'}
      />

      {/* Telegram Auth Modal */}
      <TelegramAuthModal
        isOpen={telegramAuthModalOpen}
        onClose={() => setTelegramAuthModalOpen(false)}
        onSuccess={() => {
          setTelegramConnected(true);
          setTelegramAuthModalOpen(false);
        }}
      />
    </div>
  );
};

export default OnboardingData;
