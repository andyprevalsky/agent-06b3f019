/**
 * Generator final-answer attention lifecycle.
 *
 *   START(empty, seq0) -> accumulated RESPONSE updates -> SUCCESS(canonical)
 *                                                \-----> CANCEL(done + empty)
 *   speculative gate pending -> buffer all frames -> commit flush | discard none
 */

import { v4 as uuidv4 } from 'uuid';
import type { TransactionalStreamGate } from './earlyDirectGenerator';
import { broadcastAttentionStream } from './supabaseBroadcast';

export interface GeneratorAttentionEvent {
  streamId: string;
  toolCallId: string;
  message: string;
  done: boolean;
  sequence: number;
}

export interface GeneratorAttentionLifecycle {
  readonly streamId: string;
  readonly toolCallId: string;
  start(): Promise<void>;
  update(accumulatedResponse: string): Promise<void>;
  complete(canonicalResponse: string): Promise<void>;
  cancel(): Promise<void>;
}

export function createGeneratorAttentionLifecycle(params: {
  agentId: string;
  streamGate?: TransactionalStreamGate;
  broadcast?: (event: GeneratorAttentionEvent) => Promise<void> | void;
}): GeneratorAttentionLifecycle {
  const streamId = uuidv4();
  const toolCallId = uuidv4();
  let sequence = 0;
  let lastMessage = '';
  let terminal = false;
  const broadcast =
    params.broadcast ?? ((event) => broadcastAttentionStream(params.agentId, event));
  const emit = (event: GeneratorAttentionEvent): Promise<void> => {
    const delivery = async (): Promise<void> => {
      await broadcast(event);
    };
    return params.streamGate ? params.streamGate.emit(delivery) : delivery();
  };

  return {
    streamId,
    toolCallId,
    start: () => emit({ streamId, toolCallId, message: '', done: false, sequence: sequence++ }),
    async update(accumulatedResponse): Promise<void> {
      if (
        terminal ||
        accumulatedResponse.length === 0 ||
        accumulatedResponse === lastMessage ||
        !accumulatedResponse.startsWith(lastMessage)
      ) {
        return;
      }
      lastMessage = accumulatedResponse;
      await emit({
        streamId,
        toolCallId,
        message: accumulatedResponse,
        done: false,
        sequence: sequence++,
      });
    },
    async complete(canonicalResponse): Promise<void> {
      if (terminal) return;
      terminal = true;
      lastMessage = canonicalResponse;
      await emit({
        streamId,
        toolCallId,
        message: canonicalResponse,
        done: true,
        sequence: sequence++,
      });
    },
    async cancel(): Promise<void> {
      if (terminal) return;
      terminal = true;
      await emit({ streamId, toolCallId, message: '', done: true, sequence: sequence++ });
    },
  };
}
