#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { selectChatPhaseModels } from '../../providers/chat/phaseModels';
import { getPool, poolForModel } from '../../providers/rose/pools';

const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');

assert.equal(phases.router, 'rose-labs/rose-1-flash');
assert.equal(phases.generator, 'rose-labs/rose-1-flash');
assert.equal(phases.routerProviderRoute, undefined);
assert.equal(phases.generatorProviderRoute, undefined);
const pool = poolForModel(phases.router);
assert.equal(pool, 'rose-1-flash');
assert.equal(getPool('rose-1-flash').cerebrasModel, 'qwen-3.8-27b');
process.stdout.write('chat phases use rose-fast pool path (no provider_route override)\n');
