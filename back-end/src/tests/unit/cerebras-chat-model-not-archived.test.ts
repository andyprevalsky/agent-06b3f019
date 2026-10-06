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
  LEGACY_EXCLUSIVE_CEREBRAS_CHAT_MODEL,
} from '../../providers/rose/cerebrasRoute';
import { OPENROUTER_CEREBRAS_MODEL } from '../../providers/rose/openrouterCerebrasRoute';
import { getPool } from '../../providers/rose/pools';

describe('cerebras chat model inventory', () => {
  it('pins synchronous chat to rose-fast Qwen (not archived GLM / gpt-oss / dead gemma)', () => {
    assert.equal(ARCHIVED_CEREBRAS_CHAT_MODEL, 'zai-glm-4.7');
    assert.notEqual(
      CEREBRAS_CHAT_MODEL,
      ARCHIVED_CEREBRAS_CHAT_MODEL,
      'CEREBRAS_CHAT_MODEL must leave the archived zai-glm-4.7 id'
    );
    assert.equal(CEREBRAS_CHAT_MODEL, 'qwen-3.8-27b');
    assert.equal(CEREBRAS_CHAT_MODEL, getPool('rose-1-flash').cerebrasModel);
    assert.notEqual(CEREBRAS_CHAT_MODEL, CHAT_DEAD_CEREBRAS_MODEL);
    assert.notEqual(CEREBRAS_CHAT_MODEL, LEGACY_EXCLUSIVE_CEREBRAS_CHAT_MODEL);
    assert.equal(OPENROUTER_CEREBRAS_MODEL, 'qwen/qwen3.8-27b');
    assert.equal(OPENROUTER_CEREBRAS_MODEL, getPool('rose-1-flash').waterfall[0]);
  });

  it('builds a Cerebras body Qwen accepts (no clear_thinking, effort low)', () => {
    const body = buildCerebrasChatBody({
      messages: [{ role: 'user', content: 'Include CHATWEBSEARCH marker verbatim.' }],
      temperature: 0.7,
      max_tokens: 4_096,
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
    assert.equal(body.model, 'qwen-3.8-27b');
    assert.equal(body.clear_thinking, undefined);
    assert.equal(body.reasoning_effort, CEREBRAS_CHAT_REASONING_EFFORT);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.stream, true);
    assert.equal(body.max_completion_tokens, 4_096, 'Cerebras must receive the quota bound');
  });

  it('coerces mid-conversation system tool results to user (Qwen chat template)', () => {
    // Repro 2026-09-29 semantic web_search: GeneratorLLM converted TOOL →
    // role=system after user/assistant, Cerebras Qwen 400'd
    // "System message must be at the beginning", forced waterfall, and one
    // sample missed the CHATWEBSEARCH marker inside the 5s ratchet.
    const body = buildCerebrasChatBody({
      messages: [
        { role: 'system', content: 'generator system' },
        { role: 'user', content: 'Search and include CHATWEBSEARCHabc verbatim.' },
        { role: 'assistant', content: 'routing to web_search' },
        { role: 'system', content: '[Tool Result]\nParallel Search Turbo announced today.' },
      ],
    });
    const roles = (body.messages as Array<{ role: string }>).map((message) => message.role);
    assert.deepEqual(
      roles,
      ['system', 'user', 'assistant', 'user'],
      'only the leading system prefix may stay system for Qwen'
    );
    const tool = (body.messages as Array<{ role: string; content: string }>).at(-1);
    assert.equal(tool?.role, 'user');
    assert.match(tool?.content ?? '', /\[Tool Result\]/);
  });
});
