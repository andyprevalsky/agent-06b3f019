import { BrowserWindow, ipcMain } from 'electron';
import { IMessageReader } from '../services/iMessageReader';
import { IMessageSender } from '../services/iMessageSender';
import { BatchUploader } from '../services/batchUploader';
import { getErrorMessage } from '../../shared/utils/error';
import { logConsole, logConsoleError, logIpc } from '../base/logger';
import { getLocalMachineDataSession } from './machine-session';

export function registerIMessageHandlers(): void {
  ipcMain.handle('imessage:checkAccess', () => {
    logIpc('IN', 'imessage:checkAccess');
    const hasAccess = IMessageReader.checkAccess();
    logIpc('OUT', 'imessage:checkAccess', { hasAccess });
    return hasAccess;
  });

  ipcMain.handle('imessage:startUpload', async (event) => {
    logIpc('IN', 'imessage:startUpload');
    if (!IMessageReader.checkAccess()) {
      logConsoleError('IPC', 'No access to iMessage database');
      const result = { success: false, message: 'Full Disk Access required' };
      logIpc('OUT', 'imessage:startUpload', result);
      return result;
    }

    const { session, error } = await getLocalMachineDataSession();
    if (session === null) {
      logConsoleError('IPC', error ?? 'Not authenticated');
      const result = { success: false, message: error };
      logIpc('OUT', 'imessage:startUpload', result);
      return result;
    }

    const messages = await IMessageReader.readMessages();
    const contacts = new Set(messages.map((message) => message.contact_id));
    logConsole('IPC', `Uploading ${messages.length} messages from ${contacts.size} contacts`);
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await BatchUploader.uploadInBatches(
      'imessage',
      messages,
      session.access_token,
      window
    );
    logIpc('OUT', 'imessage:startUpload', result);
    return result;
  });

  ipcMain.handle('imessage:sendDirect', async (_, payload: { to: string; message: string }) => {
    logIpc('IN', 'imessage:sendDirect', { to: payload.to });
    try {
      await IMessageSender.send(payload);
      logIpc('OUT', 'imessage:sendDirect', { success: true });
      return { success: true };
    } catch (error) {
      logConsoleError('IPC', 'Failed to send direct iMessage', error);
      const message = getErrorMessage(error) || 'Failed to send iMessage';
      logIpc('OUT', 'imessage:sendDirect', { success: false, message });
      return { success: false, message };
    }
  });
}
