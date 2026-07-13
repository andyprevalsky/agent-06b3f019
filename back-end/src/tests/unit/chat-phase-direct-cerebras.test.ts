#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { selectChatPhaseModels } from '../../providers/chat/phaseModels';

const phases = selectChatPhaseModels('rose-labs/rose-1-ultra');

assert.equal(phases.routerProviderRoute, 'openrouter-cerebras');
assert.equal(phases.generatorProviderRoute, 'openrouter-cerebras');
process.stdout.write('chat phases use OpenRouter pinned to Cerebras\n');
