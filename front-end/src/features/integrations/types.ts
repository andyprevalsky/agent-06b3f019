export interface ConnectedIntegration {
  id: string;
  name: string;
  status: 'NOT_CONNECTED' | 'CONNECTED' | 'SYNCING' | 'SYNC_FAILED' | 'EXPIRED';
  isActive: boolean;
  config?: {
    connectedEmail?: string;
    connectedEmails?: string[];
    provider?: string;
    contacts?: number;
    messages?: number;
    cookieCount?: number;
    [key: string]: unknown;
  };
  lastSuccessfulSyncAt?: string;
}

export type AccordionSection = 'browsers' | 'passwords' | 'messagesSync' | 'compute' | 'socials';

export type PasswordSyncType = 'chrome' | 'apple' | 'atlas';

export type MessageSyncType = 'imessage' | 'whatsapp' | 'telegram';
