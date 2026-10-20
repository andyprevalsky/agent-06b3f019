/**
 * Section/row view models for the Rose Desktop integrations list.
 *
 * Pure builders (no state machine): existing hook state in, ordered
 * `{ title, rows }` out. Order and icons match the stock page exactly.
 * Compute rows render through DesktopComputeRow (they own a hook); this file
 * only contributes Compute's static Gemini row.
 */

import applePasswordsIcon from '@/assets/apple-passwords-icon.png';
import chatgptIcon from '@/assets/chatgpt-icon.webp';
import chromeIcon from '@/assets/chrome-icon.png';
import geminiIcon from '@/assets/gemini-icon.png';

import type { useBrowserSync } from '../hooks/useBrowserSync';
import type { useComputeSync } from '../hooks/useComputeSync';
import type { useGmailConnect } from '../hooks/useGmailConnect';
import type { useIntegrationActions } from '../hooks/useIntegrationActions';
import type { useIntegrationData } from '../hooks/useIntegrationData';
import type { useMessagesSync } from '../hooks/useMessagesSync';
import type { usePasswordSync } from '../hooks/usePasswordSync';
import type { usePlaidIntegration } from '../hooks/usePlaidIntegration';
import BrowserIcon from './BrowserIcon';
import { BrowserCookiesIcon } from './BrowserCookiesSection';
import type { DesktopAccountView, DesktopIntegrationView } from './DesktopIntegrationRow';
import {
  countDetail,
  gmailAccountViews,
  passkeyRows,
  plaidAccountViews,
  rowAccounts,
  stringConfig,
  type RemovalPort,
} from './desktopAccounts';
import DropdownIconFrame, {
  BrowserDropdownIconPreset,
  dropdownIconImageClassName,
  DropdownIconPreset,
} from './DropdownIconFrame';
import { FileSystemIcon } from './FileSystemSection';
import {
  GmailIcon,
  IMessageIcon,
  MessengerIcon,
  TelegramIcon,
  WhatsAppIcon,
} from './MessageSyncIcons';
import PlaidLogoIcon from './PlaidLogoIcon';
import { InstagramIcon, LinkedInIcon, XIcon } from './SocialsSection';

export interface DesktopIntegrationsProps {
  isBrowserCookiesAvailable: boolean;
  isPasskeysAvailable: boolean;
  isIMessageAvailable: boolean;
  isWhatsAppAvailable: boolean;
  isClaudeCodeAvailable: boolean;
  isGptCodeAvailable: boolean;
  isFileSystemAvailable: boolean;
  isFullySignedIn: boolean;
  data: ReturnType<typeof useIntegrationData>;
  browser: ReturnType<typeof useBrowserSync>;
  passwords: ReturnType<typeof usePasswordSync>;
  compute: ReturnType<typeof useComputeSync>;
  messages: ReturnType<typeof useMessagesSync>;
  gmail: ReturnType<typeof useGmailConnect>;
  actions: ReturnType<typeof useIntegrationActions>;
  plaid: ReturnType<typeof usePlaidIntegration>;
}

export interface DesktopSectionView {
  title: string;
  rows: DesktopIntegrationView[];
}

type Preset = { iconScale?: number; iconFit?: 'contain' | 'cover' | 'fill' };

function framed(preset: Preset, child: JSX.Element, className?: string): JSX.Element {
  return (
    <DropdownIconFrame {...preset} className={className}>
      {child}
    </DropdownIconFrame>
  );
}

const img = (src: string) => (
  <img src={src} alt="" aria-hidden="true" className={dropdownIconImageClassName} />
);

function availability(available: boolean, accounts: DesktopAccountView[]) {
  return available || accounts.length > 0 ? ('ready' as const) : ('desktop-only' as const);
}

function comingSoon(key: string, name: string, icon: JSX.Element): DesktopIntegrationView {
  return { key, name, icon, accounts: [], availability: 'coming-soon' };
}

function browserCookieRows(p: DesktopIntegrationsProps, removal: RemovalPort) {
  const rows = p.data.connectedIntegrations;
  const names = new Map(p.browser.installedBrowsers.map((b) => [b.type as string, b.name]));
  for (const type of p.data.connectedBrowsers) {
    if (!names.has(type)) names.set(type, type.charAt(0).toUpperCase() + type.slice(1));
  }
  if (names.size === 0) {
    const view: DesktopIntegrationView = {
      key: 'browser-cookies',
      name: 'Browser Cookies',
      icon: framed(DropdownIconPreset.browserMain, <BrowserCookiesIcon />),
      accounts: [],
      availability: p.isBrowserCookiesAvailable ? 'ready' : 'desktop-only',
    };
    return [view];
  }
  return [...names].map(([type, name]): DesktopIntegrationView => {
    const row = rows.find((i) => i.name === type);
    const accounts = rowAccounts(
      row,
      {
        displayName: name,
        label: stringConfig(row, 'profile') ?? 'Default profile',
        detail: countDetail(row?.config?.cookieCount, 'cookies'),
        localSyncing: p.browser.browserSyncLoading === type,
      },
      removal,
    );
    return {
      key: `browser-${type}`,
      name,
      icon: framed(
        BrowserDropdownIconPreset(type),
        <BrowserIcon type={type as never} className={dropdownIconImageClassName} />,
      ),
      accounts,
      availability: availability(p.isBrowserCookiesAvailable, accounts),
      onConnect: p.isBrowserCookiesAvailable
        ? () => void p.actions.onBrowserSync(type as never)
        : undefined,
      connecting: p.browser.browserSyncLoading === type,
    };
  });
}

function passwordRows(p: DesktopIntegrationsProps, removal: RemovalPort) {
  const rows = p.data.connectedIntegrations;
  const find = (name: string) => rows.find((i) => i.name === name);
  const loading = p.passwords.passwordSyncLoading;
  const chrome = rowAccounts(
    find('chrome_passwords'),
    {
      displayName: 'Chrome passwords',
      label: 'Default profile',
      localSyncing: loading === 'chrome',
    },
    removal,
  );
  const apple = [
    ...rowAccounts(
      find('apple_passwords'),
      { displayName: 'Apple', label: 'Apple Passwords' },
      removal,
    ),
    ...passkeyRows(rows).flatMap((row) =>
      rowAccounts(row, { displayName: 'Passkeys', label: 'Passkeys' }, removal),
    ),
  ];
  const atlas = rowAccounts(
    find('atlas_passwords'),
    { displayName: 'ChatGPT Atlas', label: 'Default profile', localSyncing: loading === 'atlas' },
    removal,
  );
  const views: DesktopIntegrationView[] = [
    {
      key: 'chrome-passwords',
      name: 'Chrome',
      icon: framed(DropdownIconPreset.chrome, img(chromeIcon)),
      accounts: chrome,
      availability: availability(p.isBrowserCookiesAvailable, chrome),
      onConnect: p.isBrowserCookiesAvailable
        ? () => void p.actions.onChromePasswordsSync()
        : undefined,
      connecting: loading === 'chrome',
    },
    {
      key: 'apple-passwords',
      name: 'Apple Passwords & Passkeys',
      icon: framed(DropdownIconPreset.applePasswords, img(applePasswordsIcon)),
      accounts: apple,
      availability: availability(p.isPasskeysAvailable, apple),
      onConnect: p.isPasskeysAvailable
        ? () => p.passwords.openCredentialExchangeModal()
        : undefined,
      connecting: loading === 'passkeys',
    },
    {
      key: 'atlas-passwords',
      name: 'ChatGPT Atlas',
      icon: framed(DropdownIconPreset.atlas, img(chatgptIcon)),
      accounts: atlas,
      availability: availability(p.isBrowserCookiesAvailable, atlas),
      onConnect: p.isBrowserCookiesAvailable
        ? () => p.passwords.setAtlasPasswordsModalOpen(true)
        : undefined,
      connecting: loading === 'atlas',
    },
  ];
  return views;
}

function messageRows(p: DesktopIntegrationsProps, removal: RemovalPort) {
  const rows = p.data.connectedIntegrations;
  const find = (name: string) => rows.find((i) => i.name === name);
  const loading = p.messages.messageSyncLoading;
  const imessageRow = find('imessage');
  const imessage = rowAccounts(
    imessageRow,
    {
      displayName: 'iMessage',
      label: stringConfig(imessageRow, 'handle') ?? 'This Mac',
      detail: countDetail(imessageRow?.config?.messages, 'messages'),
      localSyncing: loading === 'imessage',
    },
    removal,
  );
  const gmail = gmailAccountViews(rows, {
    disconnectingEmail: p.gmail.disconnectingEmail,
    resyncingEmail: p.gmail.resyncingEmail,
    onDisconnect: (email) => void p.actions.onGmailDisconnect(email),
    onResync: (email) => void p.actions.onGmailResync(email),
  });
  const whatsappRow = find('whatsapp');
  const whatsapp = rowAccounts(
    whatsappRow,
    {
      displayName: 'WhatsApp',
      label: stringConfig(whatsappRow, 'phone') ?? 'Linked device',
      localSyncing: loading === 'whatsapp',
    },
    removal,
  );
  const views: DesktopIntegrationView[] = [
    {
      key: 'imessage',
      name: 'iMessage',
      icon: framed(DropdownIconPreset.imessage, <IMessageIcon gradientId="desktopImessageGrad" />),
      accounts: imessage,
      availability: availability(p.isIMessageAvailable, imessage),
      onConnect: p.isIMessageAvailable ? () => void p.actions.onIMessageSync() : undefined,
      connecting: loading === 'imessage',
    },
    {
      key: 'gmail',
      name: 'Gmail',
      icon: framed(DropdownIconPreset.gmail, <GmailIcon />),
      accounts: gmail,
      availability: 'ready',
      onConnect: () => void p.actions.onGmailConnect(),
      connecting: p.gmail.connectingProvider === 'gmail',
    },
    {
      key: 'whatsapp',
      name: 'WhatsApp',
      icon: framed(DropdownIconPreset.whatsapp, <WhatsAppIcon />),
      accounts: whatsapp,
      availability: availability(p.isWhatsAppAvailable, whatsapp),
      onConnect: p.isWhatsAppAvailable ? () => void p.actions.onWhatsAppConnect() : undefined,
      connecting: loading === 'whatsapp',
    },
    comingSoon('telegram', 'Telegram', framed(DropdownIconPreset.telegram, <TelegramIcon />)),
    comingSoon('messenger', 'Messenger', framed(DropdownIconPreset.messenger, <MessengerIcon />)),
  ];
  return views;
}

function plaidRow(p: DesktopIntegrationsProps): DesktopIntegrationView {
  const accounts = plaidAccountViews(p.data.connectedIntegrations, p.plaid);
  return {
    key: 'plaid',
    name: 'Plaid',
    icon: framed(DropdownIconPreset.plaid, <PlaidLogoIcon />),
    accounts,
    availability: 'ready',
    onConnect: p.plaid.onConnect,
    connecting: p.plaid.connectLoading,
    extra:
      p.plaid.error !== null && p.plaid.error !== '' ? (
        <p className="ml-[46px] mt-1 text-xs text-destructive">{p.plaid.error}</p>
      ) : undefined,
  };
}

function socialRows(p: DesktopIntegrationsProps, removal: RemovalPort) {
  const row = p.data.connectedIntegrations.find((i) => i.name === 'linkedin');
  const accounts = rowAccounts(
    row,
    { displayName: 'LinkedIn', label: stringConfig(row, 'name') ?? 'LinkedIn account' },
    removal,
  );
  const views: DesktopIntegrationView[] = [
    comingSoon('x', 'X', framed(DropdownIconPreset.x, <XIcon />)),
    {
      key: 'linkedin',
      name: 'LinkedIn',
      icon: framed(DropdownIconPreset.linkedin, <LinkedInIcon />),
      accounts,
      availability: availability(p.isBrowserCookiesAvailable, accounts),
      onConnect: p.isBrowserCookiesAvailable ? () => void p.actions.onLinkedInSync() : undefined,
      connecting: p.messages.linkedinSyncLoading,
    },
    comingSoon('instagram', 'Instagram', framed(DropdownIconPreset.instagram, <InstagramIcon />)),
  ];
  return views;
}

function fileSystemRow(p: DesktopIntegrationsProps): DesktopIntegrationView {
  return {
    key: 'file-system',
    name: 'File System',
    icon: framed(DropdownIconPreset.fileSystem, <FileSystemIcon />),
    accounts: [],
    availability: p.isFileSystemAvailable ? 'ready' : 'desktop-only',
    // FE-only placeholder, exactly as the stock section: the click stays idle.
    onConnect: p.isFileSystemAvailable ? () => undefined : undefined,
  };
}

/** Sections in the stock order; Compute and Banks need a fully signed-in account. */
export function desktopSectionViews(
  p: DesktopIntegrationsProps,
  removal: RemovalPort,
): DesktopSectionView[] {
  const sections: DesktopSectionView[] = [
    { title: 'Browser Cookies', rows: browserCookieRows(p, removal) },
    { title: 'Passwords', rows: passwordRows(p, removal) },
    { title: 'Messages', rows: messageRows(p, removal) },
  ];
  if (p.isFullySignedIn) {
    sections.push({
      title: 'Compute',
      rows: [
        comingSoon(
          'gemini',
          'Gemini Subscription',
          framed(DropdownIconPreset.gemini, img(geminiIcon)),
        ),
      ],
    });
    sections.push({ title: 'Banks & Financial Accounts', rows: [plaidRow(p)] });
  }
  sections.push({ title: 'Socials', rows: socialRows(p, removal) });
  sections.push({ title: 'File System', rows: [fileSystemRow(p)] });
  return sections;
}
