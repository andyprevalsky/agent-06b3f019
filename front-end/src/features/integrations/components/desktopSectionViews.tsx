import type { MeetingNotesProvider } from '../types';
/**
 * Section/row view models for the Rose Desktop integrations list.
 *
 * Pure builders (no state machine): existing hook state in, ordered
 * `{ title, rows }` out. Order, icons and connect actions match the stock
 * page exactly; every icon is the stock app-icon tile (DropdownIconFrame
 * preset + the existing glyph/asset). Each row shows its ONE account; Gmail
 * addresses and Plaid institutions keep listing several, as the stock page
 * does. Compute rows render through DesktopComputeRow (they own a hook); this
 * file only contributes Compute's static Gemini row.
 *
 * Team sharing: every shareable account (iMessage, Gmail addresses, WhatsApp,
 * Plaid institutions, LinkedIn, Granola, Fireflies) carries its `share` caption
 * from shareTarget; Browser Cookies, Passwords, File System and Pebble Index 01
 * rows never ask for one.
 */

import { INTEGRATION_CATALOG } from '../config';
import type { IntegrationCatalogKey } from '../types';
import applePasswordsIcon from '@/assets/apple-passwords-icon.png';
import chatgptIcon from '@/assets/chatgpt-icon.webp';
import chromeIcon from '@/assets/chrome-icon.png';
import geminiIcon from '@/assets/gemini-icon.png';

import type { useBrowserSync } from '../hooks/useBrowserSync';
import type { useComputeSync } from '../hooks/useComputeSync';
import type { useGmailConnect } from '../hooks/useGmailConnect';
import type { useIntegrationActions } from '../hooks/useIntegrationActions';
import type { useIntegrationData } from '../hooks/useIntegrationData';
import { gmailAccounts } from '../hooks/useIntegrationData';
import type { useMessagesSync } from '../hooks/useMessagesSync';
import type { usePasswordSync } from '../hooks/usePasswordSync';
import type { usePlaidIntegration } from '../hooks/usePlaidIntegration';
import type { useGithubRepos } from '../hooks/useGithubRepos';
import type { MeetingNotesConnections } from '../types';
import { MEETING_NOTES_PROVIDERS, meetingNotesProviders } from '../config';
import BrowserIcon from './BrowserIcon';
import { BrowserCookiesIcon } from './BrowserCookiesSection';
import type {
  DesktopAccountView,
  DesktopIcon,
  DesktopIntegrationView,
} from './DesktopIntegrationRow';
import {
  countDetail,
  GMAIL_LIGHT_PHASE,
  gmailAccountViews,
  plaidAccountViews,
  plaidItemIds,
  rowSyncFor,
  singleAccount,
  stringConfig,
  type RemovalPort,
} from './desktopAccounts';
import {
  BrowserDropdownIconPreset,
  dropdownIconImageClassName,
  DropdownIconPreset,
} from './DropdownIconFrame';
import { AccountTeamShare } from '@/components/teams/TeamSharing';
import type { AccountShareLookup, AccountShareTarget } from '@/hooks/useTeams';
import { FileSystemIcon } from './FileSystemSection';
import { PebbleIndexIcon } from './PebbleIndexSection';
import {
  GmailIcon,
  IMessageIcon,
  MessengerIcon,
  TelegramIcon,
  WhatsAppIcon,
} from './MessageSyncIcons';
import { visibleInstitutionItems } from './plaidItemView';
import PlaidLogoIcon from './PlaidLogoIcon';
import { InstagramIcon, LinkedInIcon, XIcon } from './SocialsSection';
import { MeetingNotesIcon } from './MeetingNotesProviderCard';
import { meetingNotesDetail } from '../hooks/meetingNotesView';

export interface DesktopIntegrationsProps {
  search: string;
  isBrowserCookiesAvailable: boolean;
  isPasskeysAvailable: boolean;
  isIMessageAvailable: boolean;
  isWhatsAppAvailable: boolean;
  isClaudeCodeAvailable: boolean;
  isGptCodeAvailable: boolean;
  isFileSystemAvailable: boolean;
  isFullySignedIn: boolean;
  onPebbleIndexConnect: () => void;
  data: ReturnType<typeof useIntegrationData>;
  browser: ReturnType<typeof useBrowserSync>;
  passwords: ReturnType<typeof usePasswordSync>;
  compute: ReturnType<typeof useComputeSync>;
  messages: ReturnType<typeof useMessagesSync>;
  gmail: ReturnType<typeof useGmailConnect>;
  actions: ReturnType<typeof useIntegrationActions>;
  plaid: ReturnType<typeof usePlaidIntegration>;
  meetingNotes: MeetingNotesConnections;
  github: ReturnType<typeof useGithubRepos>;
}

export interface DesktopSectionView {
  catalogKey: IntegrationCatalogKey;
  title: string;
  description?: string;
  rows: DesktopIntegrationView[];
}

const shareCaption = (target: AccountShareTarget | undefined) =>
  target && <AccountTeamShare {...target} />;

const tile = (preset: DesktopIcon['preset'], glyph: JSX.Element): DesktopIcon => ({
  preset,
  glyph,
});

const img = (src: string) => (
  <img src={src} alt="" aria-hidden="true" className={dropdownIconImageClassName} />
);

function availability(available: boolean, accounts: DesktopAccountView[]) {
  return available || accounts.length > 0 ? ('ready' as const) : ('desktop-only' as const);
}

function comingSoon(key: string, name: string, icon: DesktopIcon): DesktopIntegrationView {
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
      icon: tile(DropdownIconPreset.browserMain, <BrowserCookiesIcon />),
      accounts: [],
      availability: p.isBrowserCookiesAvailable ? 'ready' : 'desktop-only',
    };
    return [view];
  }
  return [...names].map(([type, name]): DesktopIntegrationView => {
    const row = rows.find((i) => i.name === type);
    const accounts = singleAccount(
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
      icon: tile(
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

/** Apple Passwords & Passkeys is one stock row: Apple Passwords first, else the first passkey store. */
function appleCredentialsRow(p: DesktopIntegrationsProps) {
  const rows = p.data.connectedIntegrations;
  return (
    rows.find((i) => i.name === 'apple_passwords') ??
    rows.find((i) => i.name.endsWith('_passkeys') && i.status !== 'NOT_CONNECTED')
  );
}

function passwordRows(p: DesktopIntegrationsProps, removal: RemovalPort) {
  const rows = p.data.connectedIntegrations;
  const find = (name: string) => rows.find((i) => i.name === name);
  const loading = p.passwords.passwordSyncLoading;
  const chrome = singleAccount(
    find('chrome_passwords'),
    { displayName: 'Chrome passwords', label: 'Chrome', localSyncing: loading === 'chrome' },
    removal,
  );
  const appleRow = appleCredentialsRow(p);
  const apple = singleAccount(
    appleRow,
    {
      displayName: 'Apple Passwords & Passkeys',
      label: appleRow?.name === 'apple_passwords' ? 'Apple Passwords' : 'Passkeys',
    },
    removal,
  );
  const atlas = singleAccount(
    find('atlas_passwords'),
    {
      displayName: 'ChatGPT Atlas passwords',
      label: 'ChatGPT Atlas',
      localSyncing: loading === 'atlas',
    },
    removal,
  );
  const views: DesktopIntegrationView[] = [
    {
      key: 'chrome-passwords',
      name: 'Chrome',
      icon: tile(DropdownIconPreset.chrome, img(chromeIcon)),
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
      icon: tile(DropdownIconPreset.applePasswords, img(applePasswordsIcon)),
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
      icon: tile(DropdownIconPreset.atlas, img(chatgptIcon)),
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

function gmailRow(
  p: DesktopIntegrationsProps,
  shareTarget: AccountShareLookup,
): DesktopIntegrationView {
  const rows = p.data.connectedIntegrations;
  const row = rows.find((i) => i.name === 'gmail');
  const accounts = gmailAccountViews(rows, {
    disconnectingEmail: p.gmail.disconnectingEmail,
    resyncingEmail: p.gmail.resyncingEmail,
    onDisconnect: (email) => void p.actions.onGmailDisconnect(email),
    onResync: (email) => void p.actions.onGmailResync(email),
  }).map((account) => ({ ...account, share: shareCaption(shareTarget('gmail', account.label)) }));
  const ownIds = gmailAccounts(row).map((account) => [account.email]);
  return {
    key: 'gmail',
    name: 'Gmail',
    icon: tile(DropdownIconPreset.gmail, <GmailIcon />),
    accounts,
    availability: 'ready',
    onConnect: () => void p.actions.onGmailConnect(),
    connecting: p.gmail.connectingProvider === 'gmail',
    multiAccount: true,
    rowSync: rowSyncFor(row, ownIds, { lightPhase: GMAIL_LIGHT_PHASE }),
  };
}

function messageRows(
  p: DesktopIntegrationsProps,
  removal: RemovalPort,
  shareTarget: AccountShareLookup,
) {
  const rows = p.data.connectedIntegrations;
  const find = (name: string) => rows.find((i) => i.name === name);
  const loading = p.messages.messageSyncLoading;
  const imessageRow = find('imessage');
  const imessage = singleAccount(
    imessageRow,
    {
      displayName: 'iMessage',
      label: stringConfig(imessageRow, 'handle') ?? 'This Mac',
      detail: countDetail(imessageRow?.config?.messages, 'messages'),
      localSyncing: loading === 'imessage',
    },
    removal,
  ).map((account) => ({ ...account, share: shareCaption(shareTarget('imessage')) }));
  const whatsappRow = find('whatsapp');
  const whatsapp = singleAccount(
    whatsappRow,
    {
      displayName: 'WhatsApp',
      label: stringConfig(whatsappRow, 'phone') ?? 'Linked device',
      localSyncing: loading === 'whatsapp',
    },
    removal,
  ).map((account) => ({ ...account, share: shareCaption(shareTarget('whatsapp')) }));
  const views: DesktopIntegrationView[] = [
    {
      key: 'imessage',
      name: 'iMessage',
      icon: tile(DropdownIconPreset.imessage, <IMessageIcon gradientId="desktopImessageGrad" />),
      accounts: imessage,
      availability: availability(p.isIMessageAvailable, imessage),
      onConnect: p.isIMessageAvailable ? () => void p.actions.onIMessageSync() : undefined,
      connecting: loading === 'imessage',
    },
    gmailRow(p, shareTarget),
    {
      key: 'whatsapp',
      name: 'WhatsApp',
      icon: tile(DropdownIconPreset.whatsapp, <WhatsAppIcon />),
      accounts: whatsapp,
      availability: availability(p.isWhatsAppAvailable, whatsapp),
      onConnect: p.isWhatsAppAvailable ? () => void p.actions.onWhatsAppConnect() : undefined,
      connecting: loading === 'whatsapp',
    },
    comingSoon('telegram', 'Telegram', tile(DropdownIconPreset.telegram, <TelegramIcon />)),
    comingSoon('messenger', 'Messenger', tile(DropdownIconPreset.messenger, <MessengerIcon />)),
  ];
  return views;
}

function plaidRow(
  p: DesktopIntegrationsProps,
  shareTarget: AccountShareLookup,
): DesktopIntegrationView {
  const rows = p.data.connectedIntegrations;
  const accounts = plaidAccountViews(rows, p.plaid, (itemId) =>
    shareCaption(shareTarget('plaid', itemId)),
  );
  const ownIds = visibleInstitutionItems(p.plaid.items).map(plaidItemIds);
  return {
    key: 'plaid',
    name: 'Plaid',
    icon: tile(DropdownIconPreset.plaid, <PlaidLogoIcon />),
    accounts,
    availability: 'ready',
    onConnect: p.plaid.onConnect,
    connecting: p.plaid.connectLoading,
    multiAccount: true,
    rowSync: rowSyncFor(
      rows.find((i) => i.name === 'plaid'),
      ownIds,
    ),
    extra:
      p.plaid.error !== null && p.plaid.error !== '' ? (
        <p className="ml-[46px] mt-1 text-xs text-destructive">{p.plaid.error}</p>
      ) : undefined,
  };
}

function socialRows(
  p: DesktopIntegrationsProps,
  removal: RemovalPort,
  shareTarget: AccountShareLookup,
) {
  const linkedinRow = p.data.connectedIntegrations.find((i) => i.name === 'linkedin');
  const accounts = singleAccount(
    linkedinRow,
    { displayName: 'LinkedIn', label: stringConfig(linkedinRow, 'name') ?? 'LinkedIn account' },
    removal,
  ).map((account) => ({ ...account, share: shareCaption(shareTarget('linkedin')) }));
  const views: DesktopIntegrationView[] = [
    comingSoon('x', 'X', tile(DropdownIconPreset.x, <XIcon />)),
    {
      key: 'linkedin',
      name: 'LinkedIn',
      icon: tile(DropdownIconPreset.linkedin, <LinkedInIcon />),
      accounts,
      availability: availability(p.isBrowserCookiesAvailable, accounts),
      onConnect: p.isBrowserCookiesAvailable ? () => void p.actions.onLinkedInSync() : undefined,
      connecting: p.messages.linkedinSyncLoading,
    },
    comingSoon('instagram', 'Instagram', tile(DropdownIconPreset.instagram, <InstagramIcon />)),
  ];
  return views;
}

function meetingNotesRow(
  p: DesktopIntegrationsProps,
  removal: RemovalPort,
  provider: MeetingNotesProvider,
  shareTarget: AccountShareLookup,
): DesktopIntegrationView {
  const row = p.data.connectedIntegrations.find((i) => i.name === provider);
  const connection = p.meetingNotes[provider];
  const { name } = meetingNotesProviders[provider];
  const label = connection.status?.accountEmail ?? name;
  const expired = connection.status?.status === 'EXPIRED';
  const accounts = singleAccount(
    row,
    {
      displayName: name,
      label,
      detail: meetingNotesDetail(connection, provider),
      localSyncing: connection.busy === 'sync',
    },
    removal,
  ).map((account) => ({
    ...account,
    onResync: () => void (expired ? connection.connect() : connection.sync()),
    resyncLabel: expired ? `Reconnect ${name}` : `Sync ${name} now`,
    resyncing: connection.busy === 'sync' || connection.busy === 'connect',
    share: shareCaption(shareTarget(provider, connection.status?.accountEmail)),
  }));
  return {
    key: provider,
    name,
    icon: tile(
      provider === 'fireflies' ? DropdownIconPreset.fireflies : DropdownIconPreset.granola,
      <MeetingNotesIcon provider={provider} />,
    ),
    accounts,
    availability: 'ready',
    onConnect: () => void connection.connect(),
    connecting: connection.busy === 'connect',
    extra:
      connection.error !== null ? (
        <p className="ml-[46px] mt-1 text-xs text-destructive">{connection.error}</p>
      ) : undefined,
  };
}

function fileSystemRow(p: DesktopIntegrationsProps): DesktopIntegrationView {
  return {
    key: 'file-system',
    name: 'File System',
    icon: tile(DropdownIconPreset.fileSystem, <FileSystemIcon />),
    accounts: [],
    availability: p.isFileSystemAvailable ? 'ready' : 'desktop-only',
    // FE-only placeholder, exactly as the stock section: the click stays idle.
    onConnect: p.isFileSystemAvailable ? () => undefined : undefined,
  };
}

function pebbleIndexRow(p: DesktopIntegrationsProps): DesktopIntegrationView {
  return {
    key: 'pebble-index',
    name: 'Pebble Index 01',
    icon: tile(DropdownIconPreset.pebbleIndex, <PebbleIndexIcon />),
    accounts: [],
    // The ring posts to Rose's webhook, so Connect opens the guided setup (no sync state).
    availability: 'ready',
    onConnect: p.onPebbleIndexConnect,
  };
}

/** Sections in the stock order; Compute and Banks need a fully signed-in account.
 * Meeting note taker groups providers; "Other" is last with Pebble Index 01. */
export function desktopSectionViews(
  p: DesktopIntegrationsProps,
  removal: RemovalPort,
  shareTarget: AccountShareLookup,
): DesktopSectionView[] {
  const sections: DesktopSectionView[] = [
    {
      catalogKey: 'browsers',
      title: INTEGRATION_CATALOG.browsers.title,
      rows: browserCookieRows(p, removal),
    },
    {
      catalogKey: 'passwords',
      title: INTEGRATION_CATALOG.passwords.title,
      rows: passwordRows(p, removal),
    },
    {
      catalogKey: 'messages',
      title: INTEGRATION_CATALOG.messages.title,
      rows: messageRows(p, removal, shareTarget),
    },
  ];
  if (p.isFullySignedIn) {
    sections.push({
      catalogKey: 'compute',
      title: INTEGRATION_CATALOG.compute.title,
      rows: [
        comingSoon(
          'gemini',
          'Gemini Subscription',
          tile(DropdownIconPreset.gemini, img(geminiIcon)),
        ),
      ],
    });
    sections.push({
      catalogKey: 'banks',
      title: INTEGRATION_CATALOG.banks.title,
      rows: [plaidRow(p, shareTarget)],
    });
  }
  sections.push({
    catalogKey: 'socials',
    title: INTEGRATION_CATALOG.socials.title,
    rows: socialRows(p, removal, shareTarget),
  });
  sections.push({
    catalogKey: 'files',
    title: INTEGRATION_CATALOG.files.title,
    rows: [fileSystemRow(p)],
  });
  if (p.isFullySignedIn) {
    sections.push({
      catalogKey: 'meetingNotes',
      title: INTEGRATION_CATALOG.meetingNotes.title,
      rows: MEETING_NOTES_PROVIDERS.map((provider) =>
        meetingNotesRow(p, removal, provider, shareTarget),
      ),
    });
  }
  sections.push({
    catalogKey: 'pebble',
    title: INTEGRATION_CATALOG.pebble.title,
    rows: [pebbleIndexRow(p)],
  });
  return sections;
}
