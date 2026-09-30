#!/usr/bin/env tsx
/**
 * Cross-verify every structured-output finalize seam against the same
 * miss matrix. A hole in one caller of this class (empty / reasoning-only
 * / ambiguous / junk JSON) used to kill a turn via finalText().
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  finalizeRouterDecisionFromStream,
  requireRouterDecision,
} from '../../providers/chat/routerDecision';
import { requireGeneratorParsedJson } from '../../providers/chat/generatorLlm';
import {
  ChatLlmTransientMissError,
  regenerateOnChatStructuredMiss,
} from '../../providers/chat/chatStructuredRetry';
import { parseGeneratedResponseSchemaJson } from '../../providers/setResponseSchema';
import { finalizeSupervisorResponse } from '../../providers/smsSupervisor/supervisorLlm';
import {
  StructuredOutputAccumulator,
  StructuredOutputCardinalityError,
} from '../../providers/rose/structuredOutput';

const here = dirname(fileURLToPath(import.meta.url));

function contentAcc(text: string, itemId: string, phase: string): StructuredOutputAccumulator {
  const acc = new StructuredOutputAccumulator();
  if (text) {
    acc.addChunk({
      kind: 'content',
      data: {
        text,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        phase,
      },
    });
  }
  return acc;
}

function ambiguousAcc(): StructuredOutputAccumulator {
  const acc = new StructuredOutputAccumulator();
  acc.addChunk({
    kind: 'content',
    data: {
      text: '{"answer":"one"}',
      item_id: 'final-1',
      output_index: 0,
      content_index: 0,
      phase: 'final_answer',
    },
  });
  acc.addChunk({
    kind: 'content',
    data: {
      text: '{"answer":"two"}',
      item_id: 'final-2',
      output_index: 1,
      content_index: 0,
      phase: 'final_answer',
    },
  });
  return acc;
}

function expectTypedMiss(kind: ChatLlmTransientMissError['kind'], fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    assert.ok(
      error instanceof ChatLlmTransientMissError && error.kind === kind,
      `expected ${kind} miss, got ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  assert.fail(`expected ${kind} miss`);
}

function expectThrown(pattern: RegExp, fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), pattern);
    return;
  }
  assert.fail(`expected throw matching ${pattern}`);
}

function assertDegradePath(name: string, acc: StructuredOutputAccumulator): void {
  assert.doesNotThrow(() => acc.currentText(), `${name}: currentText must not throw`);
  assert.equal(acc.currentText(), '', `${name}: degrade text is empty`);
  assert.throws(() => acc.finalText(), StructuredOutputCardinalityError);

  const router = finalizeRouterDecisionFromStream({
    structuredOutput: acc,
    accumulatedJson: '',
    deadlineExpired: false,
  });
  expectTypedMiss('empty', () =>
    requireRouterDecision({ finalized: router, deadlineExpired: false })
  );
  expectTypedMiss('empty', () => requireGeneratorParsedJson(acc.currentText()));
  expectThrown(/LLM returned no content/, () =>
    parseGeneratedResponseSchemaJson(acc.currentText())
  );
  const sms = finalizeSupervisorResponse([], acc, name);
  assert.equal(sms.tool_calls.length, 0, `${name}: SMS must nudge-retry`);
}

function testDegradeMatrix(): void {
  assertDegradePath('empty', new StructuredOutputAccumulator());
  assertDegradePath(
    'reasoning-only',
    contentAcc('thinking about the answer', 'reasoning:0', 'reasoning')
  );
  assertDegradePath('commentary-only', contentAcc('aside', 'commentary:0', 'commentary'));
  assertDegradePath('ambiguous', ambiguousAcc());
}

function testJunkJsonIsTypedMissNotCardinality(): void {
  const primitive = contentAcc(JSON.stringify('Red'), 'primitive', 'final_answer');
  assert.equal(primitive.currentText(), '"Red"');
  expectTypedMiss('parse', () =>
    requireRouterDecision({
      finalized: finalizeRouterDecisionFromStream({
        structuredOutput: primitive,
        accumulatedJson: primitive.currentText(),
        deadlineExpired: false,
      }),
      deadlineExpired: false,
    })
  );
  expectTypedMiss('parse', () => requireGeneratorParsedJson(primitive.currentText()));
  expectThrown(/failed schema/i, () => parseGeneratedResponseSchemaJson(primitive.currentText()));
  assert.equal(finalizeSupervisorResponse([], primitive, '').tool_calls.length, 0);

  const emptyObject = contentAcc('{}', 'empty-obj', 'final_answer');
  expectTypedMiss('parse', () =>
    requireRouterDecision({
      finalized: finalizeRouterDecisionFromStream({
        structuredOutput: emptyObject,
        accumulatedJson: '{}',
        deadlineExpired: false,
      }),
      deadlineExpired: false,
    })
  );
  expectTypedMiss('parse', () => requireGeneratorParsedJson('{}'));
  expectThrown(/failed schema/i, () => parseGeneratedResponseSchemaJson('{}'));
}

function testHealthyResponsesStillParse(): void {
  const routerAcc = contentAcc(
    JSON.stringify({ action: 'direct_answer', reasoning: 'ok' }),
    'router',
    'final_answer'
  );
  assert.equal(
    requireRouterDecision({
      finalized: finalizeRouterDecisionFromStream({
        structuredOutput: routerAcc,
        accumulatedJson: '',
        deadlineExpired: false,
      }),
      deadlineExpired: false,
    }).action,
    'direct_answer'
  );

  assert.equal(
    requireGeneratorParsedJson(JSON.stringify({ reasoning: 'r', response: 'hello' })).response,
    'hello'
  );
  assert.equal(
    parseGeneratedResponseSchemaJson(
      JSON.stringify({ reasoning: 'need it', fields: [{ name: 'population', type: 'int' }] })
    ).fields[0]?.name,
    'population'
  );

  const smsAcc = contentAcc(
    JSON.stringify({
      reasoning: 'answering',
      tool_calls: [{ tool: 'send_user_message', arguments: { message: 'ok' } }],
    }),
    'sms',
    'final_answer'
  );
  assert.equal(finalizeSupervisorResponse([], smsAcc, '').tool_calls[0]?.tool, 'send_user_message');
}

async function testCardinalityIsRetriedAsEmptyMiss(): Promise<void> {
  let attempts = 0;
  const result = await regenerateOnChatStructuredMiss({
    callSite: 'chat_router',
    agentId: 'matrix',
    attempt: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new StructuredOutputCardinalityError(
          'Expected one structured output item, received 0'
        );
      }
      return 'recovered';
    },
  });
  assert.equal(result, 'recovered');
  assert.equal(attempts, 2);
}

function testProductionCallersDoNotUseFinalText(): void {
  const files = [
    '../../providers/chat/routerLlm.ts',
    '../../providers/chat/routerDecision.ts',
    '../../providers/chat/generatorLlm.ts',
    '../../providers/setResponseSchema.ts',
    '../../providers/smsSupervisor/supervisorLlm.ts',
    '../../providers/credentialPropagationClassifier.ts',
    '../../domains/credential-propagation/classifier.ts',
    '../../providers/chat/chatStructuredRetry.ts',
  ];
  for (const relative of files) {
    const source = readFileSync(join(here, relative), 'utf8');
    assert.equal(source.includes('.finalText()'), false, `${relative} must not call finalText()`);
  }
}

async function main(): Promise<void> {
  testDegradeMatrix();
  testJunkJsonIsTypedMissNotCardinality();
  testHealthyResponsesStillParse();
  await testCardinalityIsRetriedAsEmptyMiss();
  testProductionCallersDoNotUseFinalText();
  process.stdout.write('PASS structured-output-miss-matrix (5 cases)\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
