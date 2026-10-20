/**
 * STATE MACHINE: PinnedQuestion (Rose Desktop, UI ledger row 47)
 *
 * A code agent's `display(..., placement: "pinned")` question, rendered fixed
 * directly above the query box (never inline in the trajectory).
 *
 * SELECTION (PinnedQuestionMount, derived from agent messages):
 *   [NONE]   <-- flag off, no pinned question, or every one answered/dismissed
 *   [PINNED] <-- oldest question with no `question_answer` and not closed locally
 *
 * CARD:
 *   [IDLE] --(click option | press its number)--> [ANSWERING]
 *   [IDLE] --(press Other's number)--> focus Other input
 *   [IDLE] --(Enter in Other, non-empty)--> [ANSWERING]
 *   [ANSWERING] --ok--> answer echoed into the code agent's transcript → [UNPINNED]
 *   [ANSWERING] --error--> [IDLE] + error line (question stays pinned)
 *   [IDLE] --(✕)--> [UNPINNED] (dismissed for this session; not answered)
 *
 * Number keys are ignored while focus is in any text field (the query box keeps them).
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Loader2, X } from 'lucide-react';

import {
  answerPinnedQuestion,
  codeAgentLabel,
  type CodeAgentSender,
  type PinnedQuestionDisplay,
} from '../hooks/codeAgentContract';
import { addLocalEcho, closeQuestion } from '../hooks/codeAgentLocalState';
import { usePendingQuestion } from '../hooks/codeAgentSteering';
import { ProviderIcon } from './claudeCodeChip.shared';

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
  sender: CodeAgentSender | null;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
  answering?: boolean;
  error?: string | null;
}

export function PinnedQuestionCard({
  question,
  sender,
  onAnswer,
  onDismiss,
  answering = false,
  error = null,
}: PinnedQuestionCardProps) {
  const [other, setOther] = useState('');
  const otherRef = useRef<HTMLInputElement>(null);
  const label = sender ? codeAgentLabel(sender.provider) : 'Agent';
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
            {sender ? (
              <ProviderIcon codeProvider={sender.provider} className="h-4 w-4 flex-shrink-0" />
            ) : null}
            <span>{label} asks</span>
            {answering && <Loader2 className={`h-3.5 w-3.5 animate-spin ${MUTED}`} />}
            <button
              type="button"
              aria-label="Dismiss question"
              onClick={onDismiss}
              className={`ml-auto rounded p-0.5 hover:text-foreground dark:hover:text-[#ecece8] ${MUTED}`}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="whitespace-pre-wrap">{question.question}</div>
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
                <span
                  className={`w-3.5 flex-none font-mono text-[12.5px] font-semibold ${MUTED}`}
                >
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
 * Mount point above the query box: renders the oldest pending pinned question
 * of the selected agent (Rose Desktop only) and owns the answer request.
 */
export function PinnedQuestionMount() {
  const { pending, agentId } = usePendingQuestion();
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const questionId = pending?.question.question_id;
  const taskId = pending?.sender?.task_id;

  useEffect(() => {
    setError(null);
  }, [questionId]);

  const onAnswer = useCallback(
    async (answer: string) => {
      if (!questionId || !agentId) return;
      setAnswering(true);
      setError(null);
      try {
        await answerPinnedQuestion(agentId, questionId, answer);
        if (taskId) addLocalEcho(taskId, answer);
        closeQuestion(questionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send answer');
      } finally {
        setAnswering(false);
      }
    },
    [agentId, questionId, taskId],
  );

  if (!pending) return null;
  return (
    <PinnedQuestionCard
      key={pending.question.question_id}
      question={pending.question}
      sender={pending.sender}
      answering={answering}
      error={error}
      onAnswer={(answer) => void onAnswer(answer)}
      onDismiss={() => closeQuestion(pending.question.question_id)}
    />
  );
}
