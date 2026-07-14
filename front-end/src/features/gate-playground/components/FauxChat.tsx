// FauxChat — presentational only. Recreates the real terminal chat surface
// (UserBubble / DefaultBubble / ToolMessage styling from
// features/terminal-component-group) so the Gate card can be previewed in
// context, and renders a non-interactive copy of the query box. The gate is
// injected via `children`. No state, no network.

import type { ReactNode } from 'react';
import { ArrowUp, Bot, Paperclip, Search, ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FauxMsg, GatePreset } from '../presets';

function UserBubble({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="inline-block max-w-[80%] rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 backdrop-blur-md dark:bg-primary/20">
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">{text}</p>
      </div>
    </div>
  );
}

function AssistantBubble({ text }: { text: string }): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="inline-block max-w-[80%] rounded-lg border border-purple-500/30 bg-purple-500/10 px-4 py-2 dark:bg-purple-500/20">
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">{text}</p>
      </div>
    </div>
  );
}

function ToolRow({ msg }: { msg: FauxMsg }): JSX.Element {
  const Icon = msg.tool === 'cart' ? ShoppingCart : Search;
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Icon className="h-4 w-4 shrink-0" />
      <span>{msg.text}</span>
      <span className="text-xs text-emerald-500">done</span>
    </div>
  );
}

function Message({ msg }: { msg: FauxMsg }): JSX.Element {
  if (msg.role === 'USER') return <UserBubble text={msg.text} />;
  if (msg.role === 'TOOL') return <ToolRow msg={msg} />;
  return <AssistantBubble text={msg.text} />;
}

/** Non-interactive replica of QueryInputShell + InputContainer. */
function FauxQueryBox(): JSX.Element {
  return (
    <div className="rounded-xl border border-border p-3 shadow-lg">
      <div className="px-3">
        <div className="min-h-[44px] py-2 text-base leading-6 text-muted-foreground">
          Message Rose…
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 px-3 pt-2">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Paperclip className="h-4 w-4" />
          <span className="text-xs">rose-1-ultra</span>
        </div>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-60">
          <ArrowUp className="h-4 w-4" />
        </div>
      </div>
    </div>
  );
}

/** iMessage-style plain-text render of what the gate texts over SMS. */
export function SmsPreview({ preset }: { preset: GatePreset }): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="pl-1 text-xs text-muted-foreground">Rose · SMS</span>
      <div className="max-w-[80%] rounded-2xl rounded-bl-md bg-[#e9e9eb] px-4 py-2 text-sm text-black dark:bg-[#26252a] dark:text-white">
        {preset.smsBody}
      </div>
    </div>
  );
}

export function FauxChat({
  preset,
  dark,
  children,
}: {
  preset: GatePreset;
  dark: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cn(dark && 'dark')}>
      <div className="flex flex-col rounded-2xl border border-border bg-background text-foreground">
        {/* faux terminal header */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-purple-500/15">
            <Bot className="h-3.5 w-3.5 text-purple-500" />
          </div>
          <span className="text-sm font-medium">Rose</span>
          <span className="ml-auto text-xs text-muted-foreground">preview</span>
        </div>

        {/* message stream */}
        <div className="flex flex-col gap-4 px-4 py-5">
          {preset.thread.map((msg, i) => (
            <Message key={`${msg.role}-${i}`} msg={msg} />
          ))}
          {/* the gate under design */}
          <div className="flex flex-col items-start">{children}</div>
          {/* waiting hint (mirrors AttentionMessage) */}
          <div className="flex items-center gap-2 text-amber-500">
            <span
              className="h-4 w-4 rounded-full border-2 border-dashed border-amber-500"
              style={{ animation: 'spin 3s linear infinite' }}
            />
            <span className="text-xs font-medium">
              Rose will continue working after you respond
            </span>
          </div>
        </div>

        {/* query box */}
        <div className="border-t border-border px-4 py-3">
          <FauxQueryBox />
        </div>
      </div>
    </div>
  );
}
