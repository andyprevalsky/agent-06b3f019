/** The Mac launcher's automatic screenshot reaches the chat model with a may-be-unrelated note. */
import assert from 'node:assert/strict';
import { mock } from 'node:test';

async function main(): Promise<void> {
  await mock.module('../../providers/storage', {
    namedExports: { downloadFromStorage: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  });
  const { AUTO_CAPTURED_SCREENSHOT_NOTE, buildMultimodalContentFromFile } =
    await import('../../providers/chat/chatMultimodal');
  const { filePointerSchema } = await import('../../domains/agents/types');

  const pointer = {
    id: '00000000-0000-4000-8000-000000000001',
    storage_path: 'u/shot.png',
    original_filename: 'Screenshot 2026-10-24 at 15.04.09.png',
    mime_type: 'image/png',
    size_bytes: 4,
    created_at: '2026-10-24T22:04:09.000Z',
  };

  // createAgent keeps the flag instead of stripping it as an unknown key.
  assert.equal(filePointerSchema.parse({ ...pointer, auto_captured: true }).auto_captured, true);

  const auto = await buildMultimodalContentFromFile('what is this error', {
    ...pointer,
    auto_captured: true,
  });
  assert.deepEqual(
    auto.map((block) => block.type),
    ['text', 'image_url', 'text']
  );
  assert.equal(auto[2]?.text, `[${AUTO_CAPTURED_SCREENSHOT_NOTE}]`);
  assert.match(AUTO_CAPTURED_SCREENSHOT_NOTE, /may not be relevant/);

  const chosen = await buildMultimodalContentFromFile('what is this error', pointer);
  assert.deepEqual(
    chosen.map((block) => block.type),
    ['text', 'image_url']
  );
  process.stdout.write('PASS chat multimodal marks the auto-captured launcher screenshot\n');
}

void main();
