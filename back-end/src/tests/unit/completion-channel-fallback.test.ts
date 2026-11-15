/** Actual completion sender with external transports isolated. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  deliverNotificationMessage,
  MAX_NOTIFICATION_CORRECTIONS,
  NotificationDeliveryError,
} from '../../providers/smsSupervisor/notificationDelivery';
import {
  SMS_TEMPLATES,
  getAgentShareUrl,
  getAgentUrl,
  ROSE_LABS_URL,
} from '../../providers/smsTemplates';
import { SMS_MAX_BODY_CHARACTERS } from '../../providers/smsDeliveryContract';
import { isEmojiOnlyMessage } from '../../providers/smsSupervisor/emoji';

const source = new URL('../../providers/smsSupervisor/outboundEvents.ts', import.meta.url);
const code = ts.transpileModule(readFileSync(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sent: { channel: string; text: string }[] = [];
let uncertain = false;
const noop = () => {};
const stubs: Record<string, unknown> = {
  '../logger': { createLogger: () => ({ info: noop, warn: noop, error: noop }) },
  '../smsQueue': { getUserPhone: async () => '+15555550123' },
  './channelDelivery': {
    sendOnChannel: async (channel: string, _phone: string, text: string) => {
      sent.push({ channel, text });
      return uncertain ? { success: false, error: 'connection lost' } : { success: true };
    },
  },
  '../whatsappReachability': {
    markWhatsAppReachable: async () => {},
    markWhatsAppUnreachable: async () => {},
  },
  '../smsTemplates': { SMS_TEMPLATES, getAgentShareUrl, getAgentUrl, ROSE_LABS_URL },
  './mmsAttachment': { rehostMmsAttachmentUrl: async () => null },
  './sessionStore': { appendLifecycleSms: async () => {} },
  './notificationDelivery': {
    deliverNotificationMessage,
    MAX_NOTIFICATION_CORRECTIONS,
    NotificationDeliveryError,
  },
  './writeLockBody': {},
  '../smsDeliveryContract': { SMS_MAX_BODY_CHARACTERS },
  './emoji': { isEmojiOnlyMessage },
  '../messagingAgentInteraction': { recordMessagingAgentInteraction: async () => {} },
  // An accepted final answer is immutable: the concise compose step must never run.
  './notificationLlm': {
    composeLifecycleNotification: async () => {
      throw new Error('final answers must not be recomposed');
    },
  },
  './notificationCards': {
    approvalNotificationContent: () => {
      throw new Error('completion must not build an approval card');
    },
    plannerNotificationContent: () => {
      throw new Error('completion must not build a planner card');
    },
  },
};
const exported: Record<string, (...args: unknown[]) => Promise<{ success: boolean }>> = {};
vm.runInNewContext(code, {
  exports: exported,
  require: (key: string) => {
    assert(key in stubs, `unexpected dependency ${key}`);
    return stubs[key];
  },
  AbortSignal,
  console,
});
async function main() {
  // Finish texts link the agent's share page (roselabs.ai/a/<id>, with its link preview).
  const url = getAgentShareUrl('completion-fixture');
  for (const answer of ['x'.repeat(SMS_MAX_BODY_CHARACTERS + 1), '😀', '👨‍👩‍👧‍👦']) {
    sent.length = 0;
    const result = await exported.notifyCompletion(
      'u',
      { id: 'completion-fixture' },
      'Summary',
      [],
      ['SMS'],
      answer
    );
    assert.equal(result.success, true);
    assert.equal(sent.length, 1);
    assert(sent[0].text.includes(url) && sent[0].text.length <= SMS_MAX_BODY_CHARACTERS);
    sent.length = 0;
    await exported.notifyCompletion(
      'u',
      { id: 'completion-fixture' },
      'Summary',
      [],
      ['SMS', 'WHATSAPP'],
      answer
    );
    assert.equal(sent.length, 2);
    assert(sent[0].text.includes(url));
    assert.equal(sent[1].text, answer, 'SMS fallback must not replace the WhatsApp answer');
  }
  for (const answer of ['4', 'x'.repeat(SMS_MAX_BODY_CHARACTERS)]) {
    sent.length = 0;
    await exported.notifyCompletion(
      'u',
      { id: 'completion-fixture' },
      'Summary',
      [],
      ['SMS'],
      answer
    );
    assert.deepEqual(sent, [{ channel: 'SMS', text: answer }]);
  }
  uncertain = true;
  sent.length = 0;
  const failed = await exported.notifyCompletion(
    'u',
    { id: 'completion-fixture' },
    'Summary',
    [],
    ['SMS'],
    '4'
  );
  assert.equal(failed.success, false);
  assert.equal(sent.length, 1, 'uncertain delivery must not be retried');
  process.stdout.write('completion channel fallback PASS\n');
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
