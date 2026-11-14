/**
 * LLM human detector for parked calls: decides whether the latest utterance
 * heard on hold is a live person (re-enter the call) or automated hold audio.
 */
import { archiveBindingFor } from '../../providers/archiveRootResolver';
import { z } from 'zod';

import { HUMAN_DETECTOR_MODEL } from './config';
import { recordHoldDetectorUsage } from './repoHold';
import { createLogger } from '../../providers/logger';
import { createStreamingCompletion } from '../../providers/rose/client';
import { responseModel } from '../../providers/rose/schema';
import type { CompletionMessage } from '../../providers/rose/types';

const log = createLogger('VapiHoldDetector');

export const HUMAN_DETECTOR_SYSTEM_PROMPT = `You watch a phone line while the caller is on hold. You get speech-to-text of what was said on the line, oldest first, and decide whether the LATEST utterance comes from a live person who has just picked up and is talking to the caller.

Automated hold audio is not a live person: recorded announcements, music or song lyrics, estimated-wait or queue-position messages, advertisements, website or app promotions, menu prompts, "your call is important to us", "please stay on the line", and anything that repeats an earlier utterance.

A live person usually greets the caller directly, gives their name, thanks them for holding, asks how they can help, or asks a question and waits for an answer.

Return live_human=true only when the latest utterance is from such a person. When unsure, return false: a person who is really there will speak again.`;

const HumanDetectionSchema = z.object({
  live_human: z
    .boolean()
    .describe('True only when the latest utterance is a live person talking to the caller.'),
  reason: z.string().describe('One short sentence explaining the decision.'),
});

export type HumanDetection = z.infer<typeof HumanDetectionSchema>;

export interface HumanDetectorInput {
  earlierUtterances: string[];
  latestUtterance: string;
  agentId?: string | null;
  userId?: string | null;
  sessionId?: string;
}

export type HumanDetector = (input: HumanDetectorInput) => Promise<HumanDetection>;

export function buildHumanDetectorMessages(input: HumanDetectorInput): CompletionMessage[] {
  const earlier =
    input.earlierUtterances.length > 0
      ? input.earlierUtterances.map((text, index) => `${index + 1}. ${text}`).join('\n')
      : '(nothing yet)';
  return [
    { role: 'system', content: HUMAN_DETECTOR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Earlier on this line (oldest first):\n${earlier}\n\nLatest utterance:\n${input.latestUtterance}`,
    },
  ];
}

// rose-1-mini waterfall mean ($0.75 / $4.00 per MTok), as in challengeLlmClassifier.
function detectorCostCents(model: string, promptTokens: number, completionTokens: number): number {
  if (model.endsWith('-claude') || model.endsWith('-gpt')) return 0;
  return (promptTokens * 0.075 + completionTokens * 0.4) / 1000;
}

export type DetectorCompletionStream = typeof createStreamingCompletion;

/** Fails safe to "still on hold": an outage must not re-enter on hold music. */
async function detectWith(
  streamCompletion: DetectorCompletionStream,
  input: HumanDetectorInput
): Promise<HumanDetection> {
  try {
    const stream = await streamCompletion({
      model: HUMAN_DETECTOR_MODEL,
      messages: buildHumanDetectorMessages(input),
      max_tokens: 150,
      temperature: 0,
      response_model: responseModel('HoldHumanDetection', HumanDetectionSchema),
      dump_context: {
        call_site: 'vapi_hold_human_detector',
        ...(await archiveBindingFor({ agentId: input.agentId, userId: input.userId })),
        config: { session_id: input.sessionId ?? null },
      },
    });
    let text = '';
    let actualModel = HUMAN_DETECTOR_MODEL;
    let promptTokens = 0;
    let completionTokens = 0;
    for await (const chunk of stream) {
      if (chunk.actual_model) actualModel = chunk.actual_model;
      text += chunk.choices[0]?.delta?.content ?? '';
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0;
        completionTokens = chunk.usage.completion_tokens ?? 0;
      }
    }
    const parsed = HumanDetectionSchema.parse(JSON.parse(text.trim()));
    const { agentId, userId } = input;
    if (
      typeof agentId === 'string' &&
      agentId !== '' &&
      typeof userId === 'string' &&
      userId !== ''
    ) {
      await recordHoldDetectorUsage({
        agentId,
        userId,
        model: actualModel,
        promptTokens,
        completionTokens,
        costCents: detectorCostCents(actualModel, promptTokens, completionTokens),
      }).catch((error: unknown) => {
        log.warn('Failed to record hold detector usage', {
          agent_id: input.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    log.info('Hold human detector result', {
      session_id: input.sessionId,
      agent_id: input.agentId ?? null,
      live_human: parsed.live_human,
      reason: parsed.reason.slice(0, 200),
      latest: input.latestUtterance.slice(0, 200),
      actual_model: actualModel,
    });
    return parsed;
  } catch (error) {
    log.warn('Hold human detector failed; staying on hold', {
      session_id: input.sessionId,
      agent_id: input.agentId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      live_human: false,
      reason: `detector_error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const createHumanDetector =
  (streamCompletion: DetectorCompletionStream): HumanDetector =>
  (input) =>
    detectWith(streamCompletion, input);

export const detectLiveHuman: HumanDetector = createHumanDetector(createStreamingCompletion);
