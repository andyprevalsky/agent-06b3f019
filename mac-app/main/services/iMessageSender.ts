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

    // Escape special characters in message for AppleScript
    // Order matters: escape backslashes first, then quotes, then newlines
    const escapedMessage = message
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');

    // Modern AppleScript approach - works on macOS Monterey+
    // Uses 'send' with a buddy lookup that's more reliable
    const script = `
tell application "Messages"
  set targetBuddy to buddy "${normalizedRecipient}" of (1st account whose service type is iMessage)
  send "${escapedMessage}" to targetBuddy
end tell
`;

    try {
      await execFileAsync('osascript', ['-e', script]);
    } catch (error) {
      // If that fails, try the alternative approach using text chat
      const altScript = `
tell application "Messages"
  set targetService to 1st account whose service type is iMessage
  set targetBuddy to participant "${normalizedRecipient}" of targetService
  send "${escapedMessage}" to targetBuddy
end tell
`;
      try {
        await execFileAsync('osascript', ['-e', altScript]);
      } catch (altError) {
        // Final fallback - create new message via URL scheme and GUI automation
        throw new Error(`Failed to send iMessage: ${error}`);
      }
    }
  }
}
