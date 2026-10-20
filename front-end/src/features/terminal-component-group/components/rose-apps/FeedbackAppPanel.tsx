/**
 * STATE MACHINE: FeedbackAppPanel (Feedback in the right-panel slot)
 *
 *   [EDITING] --Submit (non-empty)--> [SENDING] --ok--> [SENT] (thanks + "Send more")
 *                                              --fail--> [EDITING] + error
 *   [SENT] --Send more--> [EDITING]
 *
 * Same submitFeedback call as the stock sidebar's Feedback popover.
 */

import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { submitFeedback } from '../../hooks';

export function FeedbackAppPanel() {
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const text = input.trim();
    if (text === '' || sending) return;
    setSending(true);
    setError(null);
    try {
      await submitFeedback(text);
      setInput('');
      setSent(true);
    } catch {
      setError('Could not send feedback');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <div className="space-y-3 p-5 text-[13px]">
        <p className="text-green-600 dark:text-green-400">Thank you for your feedback!</p>
        <button
          type="button"
          onClick={() => setSent(false)}
          className="font-semibold text-[#e8507f]"
        >
          Send more
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 p-5 text-[13px]">
      <textarea
        aria-label="Feedback"
        value={input}
        rows={6}
        placeholder="Share your thoughts..."
        disabled={sending}
        onChange={(e) => setInput(e.target.value)}
        className="w-full resize-y rounded-[10px] border border-[#eef0f3] bg-[#fafafb] px-3 py-2.5 outline-none dark:border-white/[0.09] dark:bg-[#2f2f2c] dark:text-[#ecece8]"
      />
      {error !== null && (
        <p role="alert" className="text-[#e5484d]">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={sending || input.trim() === ''}
        className="flex h-9 items-center justify-center self-end rounded-[10px] bg-[#0a0a0a] px-4 font-semibold text-white disabled:opacity-40"
      >
        {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit'}
      </button>
    </div>
  );
}
