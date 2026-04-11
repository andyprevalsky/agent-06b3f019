/**
 * STATE MACHINE: SystemMessagesPanel
 * STATIC: Renders system messages in a scrollable card.
 */

import { ScrollArea } from '@/components/ui/scroll-area';

import type { Message } from '../types';

export function SystemMessagesPanel({ messages }: { messages: Message[] }) {
  return (
    <div className="absolute top-4 right-28 max-w-md z-10">
      <div className="bg-card dark:bg-navi-light-black border border-border dark:border-navi-light-light-black rounded-lg p-4 shadow-lg">
        <h3 className="text-sm font-semibold mb-2">System Messages</h3>
        <ScrollArea className="max-h-48">
          <div className="space-y-2">
            {messages.map((msg) => (
              <div
                key={msg.message_id}
                className="text-xs p-2 bg-blue-500/10 dark:bg-blue-500/20 border border-blue-500/30 rounded"
              >
                <p>{msg.text}</p>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
