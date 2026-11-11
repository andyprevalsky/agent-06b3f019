/** Searchable integration groups shared by the stock and Rose Desktop catalogs.
 * A match keeps the complete group, including connected accounts and actions.
 */
import { MEETING_NOTES_TITLE, meetingNotesProviders } from './meetingNotes';
export const INTEGRATION_CATALOG = {
  iphone: { title: 'Cloud iPhone', aliases: 'ios mobile phone apps device' },
  browsers: {
    title: 'Browser Cookies',
    aliases:
      'chrome safari edge brave arc opera vivaldi chromium atlas browser cookies sessions websites login',
  },
  passwords: {
    title: 'Passwords',
    aliases: 'chrome apple icloud keychain passkeys credentials atlas passwords autofill',
  },
  messages: {
    title: 'Messages',
    aliases: 'imessage gmail google mail email whatsapp telegram messenger chat messages inbox',
  },
  compute: {
    title: 'Compute',
    aliases:
      'claude anthropic claude.ai chatgpt codex openai chatgpt.com gemini google subscriptions models ai coding',
  },
  banks: {
    title: 'Banks & Financial Accounts',
    aliases: 'plaid plaid.com bank financial accounts money transactions balance',
  },
  socials: {
    title: 'Socials',
    aliases: 'x twitter x.com linkedin linkedin.com instagram instagram.com social contacts',
  },
  files: { title: 'File System', aliases: 'files folders documents disk mac local filesystem' },
  meetingNotes: {
    title: MEETING_NOTES_TITLE,
    aliases: `${Object.values(meetingNotesProviders)
      .map(({ name, domain }) => `${name} ${domain}`)
      .join(' ')} meeting notes transcript transcripts summary summaries recording calls`,
  },
  pebble: { title: 'Other', aliases: 'pebble index 01 ring wearable audio recording webhook' },
} as const;
export type IntegrationCatalogKey = keyof typeof INTEGRATION_CATALOG;
export function integrationMatchesSearch(key: IntegrationCatalogKey, query: string): boolean {
  const entry = INTEGRATION_CATALOG[key];
  const text = `${entry.title} ${entry.aliases}`.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => text.includes(token));
}
export function hasIntegrationSearchResults(query: string, signedIn: boolean): boolean {
  return (Object.keys(INTEGRATION_CATALOG) as IntegrationCatalogKey[]).some(
    (key) =>
      (signedIn || !['compute', 'banks', 'meetingNotes'].includes(key)) &&
      integrationMatchesSearch(key, query),
  );
}
