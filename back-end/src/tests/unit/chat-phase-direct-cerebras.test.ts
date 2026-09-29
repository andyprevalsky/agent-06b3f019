#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import { CEREBRAS_CHAT_MODEL } from '../../providers/rose/cerebrasRoute';
import { getPool, poolForModel } from '../../providers/rose/pools';

const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');

assert.equal(phases.router, 'rose-labs/rose-1-flash');
assert.equal(phases.generator, 'rose-labs/rose-1-flash');
assert.equal(phases.routerProviderRoute, 'direct-cerebras');
assert.equal(phases.generatorProviderRoute, 'direct-cerebras');
const pool = poolForModel(phases.router);
assert.equal(pool, 'rose-1-flash');
assert.equal(getPool('rose-1-flash').cerebrasModel, 'qwen-3.8-27b');
assert.equal(
  CEREBRAS_CHAT_MODEL,
  getPool('rose-1-flash').cerebrasModel,
  'exclusive chat model must match rose-fast cerebras inventory'
);
process.stdout.write('chat phases pin direct-cerebras hedge on rose-fast Qwen (not gpt-oss)\n');
