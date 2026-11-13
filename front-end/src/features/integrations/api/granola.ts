/** Compatibility exports for existing Granola consumers. */
import {
  fetchMeetingNotesStatusApi,
  startMeetingNotesSignInApi,
  completeMeetingNotesSignInApi,
  syncMeetingNotesApi,
  disconnectMeetingNotesApi,
} from './meetingNotes';
export type { MeetingNotesStatus as GranolaStatus } from './meetingNotes';
export const fetchGranolaStatusApi = () => fetchMeetingNotesStatusApi('granola');
export const startGranolaSignInApi = (redirectUri: string) =>
  startMeetingNotesSignInApi('granola', redirectUri);
export const completeGranolaSignInApi = (code: string, state: string) =>
  completeMeetingNotesSignInApi('granola', code, state);
export const syncGranolaApi = () => syncMeetingNotesApi('granola');
export const disconnectGranolaApi = () => disconnectMeetingNotesApi('granola');
