import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface IMessagePayload {
  to: string;
  message: string;
}

export class IMessageSender {
  static async send({ to, message }: IMessagePayload): Promise<void> {
    if (!to || !message) {
      throw new Error('Recipient and message are required');
    }

    const normalizedRecipient = to.trim();

    const script = `
on run {targetPhone, targetMessage}
  tell application "Messages"
    activate
    set targetService to 1st service whose service type = iMessage
    set targetBuddy to buddy targetPhone of targetService
    send targetMessage to targetBuddy
  end tell
end run
`;

    await execFileAsync('osascript', ['-e', script, normalizedRecipient, message]);
  }
}



