/**
 * STATE MACHINE: categoryModels (pure mapping — no state)
 *
 * [hook state] --buildCategories--> [CategoryModel[]] --> RingCarousel + SubConnectionCard
 *
 * System context:
 *   OnboardingData composes the integrations-page hooks and feeds their state
 *   here; each builder maps one ring category to its sub-connection rows,
 *   reusing the integrations page's icons so onboarding cannot drift from it.
 */

import type { ReactNode } from 'react';

import BrowserIcon from '@/features/integrations/components/BrowserIcon';
import {
  BrowserDropdownIconPreset,
  DropdownIconPreset,
  dropdownIconImageClassName,
} from '@/features/integrations/components/DropdownIconFrame';
import {
  GmailIcon,
  IMessageIcon,
  TelegramIcon,
  WhatsAppIcon,
} from '@/features/integrations/components/MessageSyncIcons';
import PlaidLogoIcon from '@/features/integrations/components/PlaidLogoIcon';
import {
  InstagramIcon,
  LinkedInIcon,
  XIcon,
} from '@/features/integrations/components/SocialsSection';
import type { BrowserInfo, BrowserType } from '@/features/integration-handlers-context';

import { RING_GLYPHS } from './ringGlyphs';
import type { SubRowModel, SubRowState } from './SubConnectionCard';

import chromeIcon from '../../../../assets/chrome-icon.png';
import chatgptIcon from '../../../../assets/chatgpt-icon.webp';
import applePasswordsIcon from '../../../../assets/apple-passwords-icon.png';
import claudeIcon from '../../../../assets/claude-color.svg';
import geminiIcon from '../../../../assets/gemini-icon.png';

export interface CategoryModel {
  id: string;
  name: string;
  desc: string;
  glyph: ReactNode;
  connected: boolean;
  rows: SubRowModel[];
  emptyText?: string;
  footerError?: string | null;
}

export interface CategoryInputs {
  browsers: {
    installed: BrowserInfo[];
    connected: Set<BrowserType>;
    loading: BrowserType | null;
    onSync: (type: BrowserType) => void;
  };
  passwords: {
    chromeSynced: boolean;
    appleSynced: boolean;
    atlasSynced: boolean;
    loading: 'chrome' | 'apple' | 'passkeys' | 'atlas' | null;
    onChromeSync: () => void;
    onAppleConnect: () => void;
    onAtlasConnect: () => void;
  };
  compute: {
    claudeSynced: boolean;
    gptSynced: boolean;
    claudeLoading: boolean;
    gptLoading: boolean;
    onClaudeSync: () => void;
    onGptSync: () => void;
  };
  messages: {
    iMessageSynced: boolean;
    whatsAppConnected: boolean;
    telegramConnected: boolean;
    connectedEmails: string[];
    iMessageLoading: boolean;
    chatLoading: 'whatsapp' | 'telegram' | null;
    gmailLoading: boolean;
    onIMessageSync: () => void;
    onWhatsAppConnect: () => void;
    onTelegramConnect: () => void;
    onGmailConnect: () => void;
  };
  socials: {
    linkedInStarted: boolean;
    linkedInLoading: boolean;
    onLinkedInSync: () => void;
  };
  financials: {
    bankNames: string[];
    loading: boolean;
    error: string | null;
    onConnect: () => void;
  };
}

function rowState(connected: boolean, loading: boolean): SubRowState {
  if (connected) return 'connected';
  if (loading) return 'loading';
  return 'idle';
}

const imgClass = dropdownIconImageClassName;

function browsersCategory(b: CategoryInputs['browsers']): CategoryModel {
  return {
    id: 'browsers',
    name: 'Browser Sync',
    desc: 'Sync browsing data for web automation',
    glyph: RING_GLYPHS.browsers,
    connected: b.connected.size > 0,
    emptyText:
      'No supported browsers detected. Install Safari, Chrome, Edge, Brave, Arc, or another supported browser.',
    rows: b.installed.map((browser) => ({
      key: browser.type,
      label: browser.name,
      icon: <BrowserIcon type={browser.type} className={imgClass} />,
      ...BrowserDropdownIconPreset(browser.type),
      state: rowState(b.connected.has(browser.type), b.loading === browser.type),
      onConnect: () => b.onSync(browser.type),
    })),
  };
}

function passwordsCategory(p: CategoryInputs['passwords']): CategoryModel {
  return {
    id: 'passwords',
    name: 'Passwords',
    desc: 'Auto-fill login credentials',
    glyph: RING_GLYPHS.passwords,
    connected: p.chromeSynced || p.appleSynced || p.atlasSynced,
    rows: [
      {
        key: 'chrome',
        label: 'Chrome',
        icon: <img src={chromeIcon} alt="Chrome" className={imgClass} />,
        ...DropdownIconPreset.chrome,
        state: rowState(p.chromeSynced, p.loading === 'chrome'),
        onConnect: p.onChromeSync,
      },
      {
        key: 'apple',
        label: 'Apple Passwords & Passkeys',
        icon: <img src={applePasswordsIcon} alt="Apple Passwords" className={imgClass} />,
        ...DropdownIconPreset.applePasswords,
        state: rowState(p.appleSynced, p.loading === 'passkeys' || p.loading === 'apple'),
        onConnect: p.onAppleConnect,
      },
      {
        key: 'atlas',
        label: 'ChatGPT Atlas',
        icon: <img src={chatgptIcon} alt="ChatGPT Atlas" className={imgClass} />,
        ...DropdownIconPreset.atlas,
        state: rowState(p.atlasSynced, p.loading === 'atlas'),
        onConnect: p.onAtlasConnect,
      },
    ],
  };
}

function computeCategory(c: CategoryInputs['compute']): CategoryModel {
  return {
    id: 'compute',
    name: 'Compute',
    desc: 'Bring your own AI subscriptions',
    glyph: RING_GLYPHS.compute,
    connected: c.claudeSynced || c.gptSynced,
    rows: [
      {
        key: 'claude',
        label: 'Claude Subscription',
        icon: <img src={claudeIcon} alt="Claude" className={imgClass} />,
        ...DropdownIconPreset.claude,
        state: rowState(c.claudeSynced, c.claudeLoading),
        onConnect: c.onClaudeSync,
      },
      {
        key: 'chatgpt',
        label: 'ChatGPT Subscription',
        icon: <img src={chatgptIcon} alt="ChatGPT" className={imgClass} />,
        ...DropdownIconPreset.chatgpt,
        state: rowState(c.gptSynced, c.gptLoading),
        onConnect: c.onGptSync,
      },
      {
        key: 'gemini',
        label: 'Gemini',
        icon: <img src={geminiIcon} alt="Gemini" className={imgClass} />,
        ...DropdownIconPreset.gemini,
        state: 'coming-soon',
      },
    ],
  };
}

function messagesCategory(m: CategoryInputs['messages']): CategoryModel {
  return {
    id: 'messages',
    name: 'Messages',
    desc: 'Sync messaging clients',
    glyph: RING_GLYPHS.messages,
    connected:
      m.iMessageSynced ||
      m.whatsAppConnected ||
      m.telegramConnected ||
      m.connectedEmails.length > 0,
    rows: [
      {
        key: 'imessage',
        label: 'iMessage',
        icon: <IMessageIcon gradientId="onbIMessageGrad" />,
        ...DropdownIconPreset.imessage,
        state: rowState(m.iMessageSynced, m.iMessageLoading),
        onConnect: m.onIMessageSync,
      },
      {
        key: 'whatsapp',
        label: 'WhatsApp',
        icon: <WhatsAppIcon />,
        ...DropdownIconPreset.whatsapp,
        state: rowState(m.whatsAppConnected, m.chatLoading === 'whatsapp'),
        onConnect: m.onWhatsAppConnect,
      },
      {
        key: 'telegram',
        label: 'Telegram',
        icon: <TelegramIcon />,
        ...DropdownIconPreset.telegram,
        state: rowState(m.telegramConnected, m.chatLoading === 'telegram'),
        onConnect: m.onTelegramConnect,
      },
      {
        key: 'gmail',
        label: 'Gmail',
        icon: <GmailIcon />,
        ...DropdownIconPreset.gmail,
        state: rowState(m.connectedEmails.length > 0, m.gmailLoading),
        onConnect: m.onGmailConnect,
        chips: m.connectedEmails,
      },
    ],
  };
}

function socialsCategory(s: CategoryInputs['socials']): CategoryModel {
  return {
    id: 'socials',
    name: 'Socials',
    desc: 'Connect social media accounts',
    glyph: RING_GLYPHS.socials,
    connected: s.linkedInStarted,
    rows: [
      { key: 'x', label: 'X', icon: <XIcon />, ...DropdownIconPreset.x, state: 'coming-soon' },
      {
        key: 'linkedin',
        label: 'LinkedIn',
        icon: <LinkedInIcon />,
        ...DropdownIconPreset.linkedin,
        state: rowState(s.linkedInStarted, s.linkedInLoading),
        onConnect: s.onLinkedInSync,
      },
      {
        key: 'instagram',
        label: 'Instagram',
        icon: <InstagramIcon />,
        ...DropdownIconPreset.instagram,
        state: 'coming-soon',
      },
    ],
  };
}

function financialsCategory(f: CategoryInputs['financials']): CategoryModel {
  return {
    id: 'financials',
    name: 'Financials',
    desc: 'Connect your financial accounts',
    glyph: RING_GLYPHS.financials,
    connected: f.bankNames.length > 0,
    footerError: f.error,
    rows: [
      {
        key: 'plaid',
        label: 'Your Bank',
        icon: <PlaidLogoIcon className="h-5 w-5 text-[#111111]" />,
        ...DropdownIconPreset.plaid,
        state: rowState(f.bankNames.length > 0, f.loading),
        onConnect: f.onConnect,
        chips: f.bankNames,
      },
    ],
  };
}

export function buildCategories(inputs: CategoryInputs): CategoryModel[] {
  return [
    browsersCategory(inputs.browsers),
    passwordsCategory(inputs.passwords),
    computeCategory(inputs.compute),
    messagesCategory(inputs.messages),
    socialsCategory(inputs.socials),
    financialsCategory(inputs.financials),
  ];
}
