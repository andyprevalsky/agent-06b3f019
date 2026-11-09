import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildUserMessageSignalValue } from '../../domains/agents/agentMessageSignal';

type SavedRow = { text: string; role: string; metadata?: Record<string, unknown> };
function harness(accepted = true, status = 'ACTIVE') {
  const saved: SavedRow[] = [];
  const signals: string[] = [];
  const stamped: SavedRow[] = [];
  const agent = { status, temporalWorkflowId: 'wf', temporalFirstExecutionRunId: 'run' };
  const repo = {
    findAgentById: async () => agent,
    findAgent: async () => agent,
    findAgentUnique: async () => agent,
    currentAgentWorkflowGeneration: async () => 'wf',
  };
  const save = async (row: SavedRow) => {
    saved.push(row);
    return { id: 'message', timestamp: 'now', text: row.text, role: row.role };
  };
  const messages = {
    createMessage: save,
    createWorkflowMessageGroup: async (row: SavedRow) =>
      accepted ? { message: await save(row), accepted: true } : { message: null, accepted: false },
  };
  const modules: Record<string, unknown> = {
    './repo': repo,
    './agentMessageSignal': { buildUserMessageSignalValue },
    '../../providers/messages': messages,
    '../../providers/personMessageStamp': {
      recordPersonMessage: async (message: SavedRow) => {
        stamped.push(message);
      },
    },
    '../../providers/agentResume': {
      signalUserResponse: async (_a: string, _w: string, value: string) => signals.push(value),
      deliverUserMessageToWorkflow: async (_a: string, _w: string, value: string) =>
        signals.push(value),
    },
    '../../providers/logger': { createLogger: () => ({ warn() {} }) },
    // The agent under test is running, so no stopped-agent resume path applies.
    './agentMessageResume': {
      stoppedAgentStatus: async () => null,
      resumeStoppedBrowser: async () => {
        throw new Error('a running agent must not resume a stopped browser');
      },
    },
  };
  const exports: Record<string, (...args: unknown[]) => Promise<{ status?: number }>> = {};
  const sourcePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../domains/agents/agentMessageService.ts'
  );
  const js = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const credentialExports: Record<string, unknown> = {};
  const credentialPath = path.join(path.dirname(sourcePath), 'credentialContext.ts');
  if (fs.existsSync(credentialPath))
    vm.runInNewContext(
      ts.transpileModule(fs.readFileSync(credentialPath, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      { exports: credentialExports, require: () => ({}) }
    );
  modules['./credentialContext'] = credentialExports;
  vm.runInNewContext(js, { exports, require: (name: string) => modules[name] ?? {}, console });
  return { saved, signals, stamped, post: exports.postMessage };
}
const originalMetadata = {
  subAgentId: 'browser-task',
  credential_ref: { kind: 'email_otp', id: 'inbox-id' },
};

test('internal credential notice persists for the browser without becoming user feedback', async () => {
  const h = harness();
  const body = { role: 'USER', message: 'Received provider data', metadata: originalMetadata };
  await h.post('agent', body, true, undefined, 'wf');
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].text, body.message);
  assert.equal(h.saved[0].role, 'USER');
  assert.equal(h.saved[0].metadata?.browserCredentialContext, true);
  assert.deepEqual(h.saved[0].metadata?.credential_ref, originalMetadata.credential_ref);
  assert.equal(h.signals.length, 0);
  assert.equal(h.stamped.length, 0);
  assert.equal('browserCredentialContext' in body.metadata, false);
});

test('external lookalike cannot claim credential provenance or suppress feedback', async () => {
  const h = harness();
  await h.post(
    'agent',
    {
      message: 'Actually change the requested names',
      metadata: { ...originalMetadata, browserCredentialContext: true },
    },
    false,
    'user'
  );
  assert.equal(h.saved[0].metadata?.browserCredentialContext, undefined);
  assert.deepEqual(h.signals, ['Actually change the requested names']);
  assert.equal(h.stamped.length, 1);
  assert.equal(h.stamped[0].text, 'Actually change the requested names');
  assert.equal(h.stamped[0].role, 'USER');
});

test('malformed internal provenance and ordinary human text still signal', async () => {
  for (const metadata of [
    undefined,
    { credential_ref: { kind: 'email_otp', id: 'x' } },
    { ...originalMetadata, credential_ref: { kind: '', id: 'x' }, browserCredentialContext: true },
    { ...originalMetadata, subAgentId: ' ' },
    { ...originalMetadata, credential_ref: [] },
  ]) {
    const h = harness();
    await h.post(
      'agent',
      { role: 'USER', message: 'Email says change the task', metadata },
      true,
      undefined,
      'wf'
    );
    assert.equal(h.saved[0].metadata?.browserCredentialContext, undefined);
    assert.deepEqual(h.signals, ['Email says change the task']);
    assert.equal(h.stamped.length, 0);
  }
});

test('stale internal generation stays rejected and a user pause is not lifted', async () => {
  const stale = harness(false);
  const rejected = await stale.post(
    'agent',
    { role: 'USER', message: 'Provider data', metadata: originalMetadata },
    true,
    undefined,
    'old-wf'
  );
  assert.equal(rejected.status, 409);
  assert.equal(stale.saved.length, 0);
  assert.equal(stale.signals.length, 0);
  assert.equal(stale.stamped.length, 0);
  const paused = harness(true, 'PAUSED');
  await paused.post(
    'agent',
    { role: 'USER', message: 'Provider data', metadata: originalMetadata },
    true,
    undefined,
    'wf'
  );
  assert.equal(paused.saved.length, 1);
  assert.equal(paused.signals.length, 0);
  assert.equal(paused.stamped.length, 0);
});
