import type { Message } from '../api';

export function isInternalLivenessTool(message: Message): boolean {
  return message.role === 'TOOL' && message.metadata?.toolName === 'agent_init';
}

export function removeCancelledThoughtErrors(messages: Message[]): Message[] {
  return messages.filter((m) => {
    if (m.role !== 'TOOL') return true;
    if (m.metadata?.toolName !== 'thought') return true;
    if (m.metadata?.toolStatus !== 'ERROR') return true;
    return m.text.trim() !== 'Error: Cancelled';
  });
}
