/**
 * Cemented regression for the 2026-08-20 prod web_search lifecycle failure:
 * Cerebras archived `zai-glm-4.7`, so every chat request 404'd into the
 * OpenRouter waterfall (gemini 400 → kimi-k3 9–30s) and the final-answer
 * marker missed the 5s / 15s budgets after web_search FINISHED.
 *
 * This test fails if we reintroduce an archived / chat-dead id or GLM-only
 * body fields (`clear_thinking`) that would 400 and re-arm the waterfall.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ARCHIVED_CEREBRAS_CHAT_MODEL,
  buildCerebrasChatBody,
  CEREBRAS_CHAT_MODEL,
  CEREBRAS_CHAT_REASONING_EFFORT,
  CHAT_DEAD_CEREBRAS_MODEL,
} from '../../providers/rose/cerebrasRoute';
import { OPENROUTER_CEREBRAS_MODEL } from '../../providers/rose/openrouterCerebrasRoute';

describe('cerebras chat model inventory', () => {
  it('does not pin synchronous chat to the archived Cerebras GLM id', () => {
    assert.equal(ARCHIVED_CEREBRAS_CHAT_MODEL, 'zai-glm-4.7');
    assert.notEqual(
      CEREBRAS_CHAT_MODEL,
      ARCHIVED_CEREBRAS_CHAT_MODEL,
      'CEREBRAS_CHAT_MODEL must leave the archived zai-glm-4.7 id'
    );
    assert.equal(CEREBRAS_CHAT_MODEL, 'gpt-oss-120b');
    assert.notEqual(CEREBRAS_CHAT_MODEL, CHAT_DEAD_CEREBRAS_MODEL);
    assert.equal(OPENROUTER_CEREBRAS_MODEL, 'openai/gpt-oss-120b');
  });

  it('builds a Cerebras body gpt-oss-120b accepts (no clear_thinking, effort low)', () => {
    const body = buildCerebrasChatBody({
      messages: [{ role: 'user', content: 'Include CHATWEBSEARCH marker verbatim.' }],
      temperature: 0.7,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'generator_response',
          strict: true,
          schema: {
            type: 'object',
            properties: { reasoning: { type: 'string' }, response: { type: 'string' } },
            required: ['reasoning', 'response'],
            additionalProperties: false,
          },
        },
      },
    });
    assert.equal(body.model, 'gpt-oss-120b');
    assert.equal(body.clear_thinking, undefined);
    assert.equal(body.reasoning_effort, CEREBRAS_CHAT_REASONING_EFFORT);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.stream, true);
  });
});
