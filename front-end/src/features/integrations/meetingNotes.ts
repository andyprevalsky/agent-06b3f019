/** Shared provider metadata for the meeting note taker category. */
export type MeetingNotesProvider = 'granola' | 'fireflies';

export const MEETING_NOTES_TITLE = 'Meeting note taker';
export const MEETING_NOTES_DESCRIPTION = 'granola.ai, fireflies.ai, etc.';
export const MEETING_NOTES_PUBLIC_ORIGIN = 'https://www.roselabs.ai';
export const MEETING_NOTES_PROVIDERS = ['granola', 'fireflies'] as const;

export const meetingNotesProviders = {
  granola: { name: 'Granola', domain: 'granola.ai', meetingDocument: 'granola_note' },
  fireflies: { name: 'Fireflies', domain: 'fireflies.ai', meetingDocument: 'fireflies_note' },
} as const;

export const meetingNotesCallbackPath = (provider: MeetingNotesProvider) =>
  `/integrations/${provider}/callback`;
export const meetingNotesReturnKey = (provider: MeetingNotesProvider) =>
  `rose.${provider}.returnPath`;
