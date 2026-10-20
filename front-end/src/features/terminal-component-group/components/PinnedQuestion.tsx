/**
 * STATE MACHINE: PinnedQuestion (Rose Desktop, UI ledger row 47; L-DISPLAY contract)
 *
 * An agent's `display(..., placement: "pinned")` question, rendered fixed
 * directly above the query box (never inline in the trajectory).
 *
 * SELECTION (PinnedQuestionMount):
 *   [NONE]   <-- flag off, no open pin, or every one answered/dismissed
 *   [PINNED] <-- 1. oldest pin row of the open agent still IN_PROGRESS
 *                2. else the oldest unanswered pin a DESCENDANT agent routed to
 *                   this agent (existing attention-request subscription)
 *
 * CARD:
 *   [IDLE] --(click option | press its number)--> [ANSWERING]
 *   [IDLE] --(press Other's number, allow_other)--> focus Other input
 *   [IDLE] --(Enter in Other, non-empty)--> [ANSWERING]
 *   [IDLE] --(✕)--> [ANSWERING] with {dismiss: true}
 *   [ANSWERING] --2xx--> answer echoed into the code agent's transcript → [UNPINNED]
 *                        (first answer wins; the row's FINISHED update also unpins)
 *   [ANSWERING] --404--> [UNPINNED] (the question no longer exists)
 *   [ANSWERING] --403 | 400 | other--> [IDLE] + the server's error line (stays pinned)
 *
 * Number keys are ignored while focus is in any text field (the query box keeps them).
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Loader2, X } from 'lucide-react';

import {
  PinnedQuestionAnswerError,
  answerPinnedQuestion,
  type PinnedQuestionDisplay,
  type PinnedQuestionReply,
  type RequestingAgent,
} from '../hooks/codeAgentContract';
import { addLocalEcho, closeQuestion } from '../hooks/codeAgentLocalState';
import { usePendingQuestion } from '../hooks/codeAgentSteering';
import { ProviderIcon } from './claudeCodeChip.shared';
import { InlineMediaGallery } from './inline-media/InlineMediaGallery';

const MUTED = 'text-muted-foreground dark:text-[#a3a39d]';

function isTextField(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (element as HTMLElement).isContentEditable === true
  );
}

export interface PinnedQuestionCardProps {
  question: PinnedQuestionDisplay;
  requester: RequestingAgent | null;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
  answering?: boolean;
  error?: string | null;
  /** Agent that owns the question's media items (signs their URLs). */
  mediaAgentId?: string;
}

export function PinnedQuestionCard({
  question,
  requester,
  onAnswer,
  onDismiss,
  answering = false,
  error = null,
  mediaAgentId,
}: PinnedQuestionCardProps) {
  const [other, setOther] = useState('');
  const otherRef = useRef<HTMLInputElement>(null);
  const label = requester?.label ?? 'Agent';
  const provider = requester?.provider;
  const otherNumber = question.options.length + 1;

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (answering || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextField(document.activeElement)) return;
      const n = Number(event.key);
      if (!Number.isInteger(n) || n < 1) return;
      if (n <= question.options.length) {
        event.preventDefault();
        onAnswer(question.options[n - 1].label);
      } else if (n === otherNumber && question.allow_other) {
        event.preventDefault();
        otherRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [answering, onAnswer, otherNumber, question]);

  const onOtherKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter' && other.trim() && !answering) {
      event.preventDefault();
      onAnswer(other.trim());
    }
  };

  return (
    <div className="mb-3 w-full">
      <div className="mx-auto max-w-4xl">
        <section
          data-testid="pinned-question"
          aria-label={`${label} asks`}
          className="rounded-xl border border-border bg-white/90 px-4 py-3.5 text-sm text-foreground shadow-[0_6px_20px_rgba(20,20,40,.10)] backdrop-blur-md dark:border-white/[.09] dark:bg-[#262624] dark:text-[#ecece8] dark:shadow-[0_6px_20px_rgba(0,0,0,.35)]"
        >
          <div className="mb-2 flex items-center gap-2 font-medium">
            {provider ? (
              <ProviderIcon codeProvider={provider} className="h-4 w-4 flex-shrink-0" />
            ) : null}
            <span>{label} asks</span>
            {answering && <Loader2 className={`h-3.5 w-3.5 animate-spin ${MUTED}`} />}
            <button
              type="button"
              aria-label="Dismiss question"
              disabled={answering}
              onClick={onDismiss}
              className={`ml-auto rounded p-0.5 hover:text-foreground disabled:opacity-60 dark:hover:text-[#ecece8] ${MUTED}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="whitespace-pre-wrap">{question.question}</div>
          {question.items.length > 0 && (
            <InlineMediaGallery files={question.items} agentId={mediaAgentId} className="mt-2" />
          )}
          <ol className="mt-2.5 flex flex-col gap-0.5" aria-label="Answers">
            {question.options.map((option, index) => (
              <li key={`${index}-${option.label}`}>
                <button
                  type="button"
                  disabled={answering}
                  onClick={() => onAnswer(option.label)}
                  className="group flex w-full items-start gap-3 rounded-lg px-2 py-[7px] text-left text-[13.5px] leading-snug hover:bg-black/[.04] disabled:opacity-60 dark:hover:bg-white/[.06]"
                >
                  <span
                    className={`w-3.5 flex-none pt-px font-mono text-[12.5px] font-semibold group-hover:text-[#e8507f] ${MUTED}`}
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <b className="font-semibold group-hover:text-[#e8507f]">{option.label}</b>
                    {option.recommended && (
                      <span className={`ml-1 text-[11.5px] font-medium ${MUTED}`}>Recommended</span>
                    )}
                    {option.description && (
                      <span className={`block text-[12.5px] ${MUTED}`}>{option.description}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
            {question.allow_other && (
              <li className="flex items-center gap-3 px-2 py-[7px] text-[13.5px]">
                <span className={`w-3.5 flex-none font-mono text-[12.5px] font-semibold ${MUTED}`}>
                  {otherNumber}
                </span>
                <input
                  ref={otherRef}
                  value={other}
                  disabled={answering}
                  onChange={(event) => setOther(event.target.value)}
                  onKeyDown={onOtherKeyDown}
                  placeholder="Other…"
                  aria-label="Other answer"
                  className="min-w-0 flex-1 border-0 border-b border-border bg-transparent py-[3px] outline-none focus:border-[#e8507f] dark:border-white/[.12] dark:placeholder:text-[#a3a39d]"
                />
              </li>
            )}
          </ol>
          {error && (
            <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Mount point above the query box: renders the oldest open pinned question of
 * the selected agent or one of its descendants (Rose Desktop only) and owns the
 * answer / dismiss request.
 */
export function PinnedQuestionMount() {
  const { pending, agentId, refetchAttention } = usePendingQuestion();
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const questionId = pending?.question.question_id;
  // The endpoint accepts the pin's own agent or the agent it is routed to.
  const targetAgentId = pending?.question.routed_agent_id ?? agentId;
  const taskId = pending?.requester?.task_id;

  useEffect(() => {
    setError(null);
  }, [questionId]);

  const send = useCallback(
    async (reply: PinnedQuestionReply) => {
      if (!questionId || !targetAgentId) return;
      setAnswering(true);
      setError(null);
      try {
        await answerPinnedQuestion(targetAgentId, questionId, reply);
        if (taskId && 'answer' in reply) addLocalEcho(taskId, reply.answer);
        closeQuestion(questionId);
        refetchAttention();
      } catch (err) {
        if (err instanceof PinnedQuestionAnswerError && err.status === 404) {
          closeQuestion(questionId);
          refetchAttention();
        } else {
          setError(err instanceof Error ? err.message : 'Failed to send answer');
        }
      } finally {
        setAnswering(false);
      }
    },
    [questionId, refetchAttention, targetAgentId, taskId],
  );

  if (!pending) return null;
  return (
    <PinnedQuestionCard
      key={pending.question.question_id}
      question={pending.question}
      requester={pending.requester}
      answering={answering}
      error={error}
      mediaAgentId={pending.ownerAgentId ?? undefined}
      onAnswer={(answer) => void send({ answer })}
      onDismiss={() => void send({ dismiss: true })}
    />
  );
}
