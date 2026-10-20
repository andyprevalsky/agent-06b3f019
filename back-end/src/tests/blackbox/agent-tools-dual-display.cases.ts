/** C18: one canonical display in the code task and owning conversation. */
import { mintAgentToolsToken } from '../../providers/agentTools/token';
import { prisma } from '../../providers/database';
import { deterministicMessageId } from '../../providers/messageIdempotency';
import {
  assert,
  childA,
  b64,
  cubeGlb,
  display,
  displayMessages,
  expectStatus,
  grandchildA,
  items,
  png,
  rootA,
  RUN,
  userA,
  type BlackboxTest,
  type DisplayItem,
} from './agent-tools.support';
export function dualDisplayCases(): BlackboxTest[] {
  return [
    {
      name: 'renderer: a code agent display lands in its own and its owning agent conversation with one canonical id',
      fn: async () => {
        const rowsWith = async (agentId: string, canonicalId: string) =>
          (await displayMessages(agentId)).filter(
            (r) =>
              (r.metadata as { display: { canonical_id?: string } }).display.canonical_id ===
              canonicalId
          );
        const token = (agentId: string, taskId: string) =>
          mintAgentToolsToken(userA, agentId, { provider: 'claude', taskId }).token;
        // Code agent spawned by a depth-1 agent: rows stay with that agent, never the root.
        const task = `task-dual-${RUN}`;
        const glb = cubeGlb([0.9, 0.5, 0.1, 1], `dual-${RUN}`);
        const first = await display(
          childA,
          { items: [b64(glb, 'dual.glb')], caption: 'Dual' },
          { bearer: token(childA, task) }
        );
        expectStatus(first, 201, 'code agent display');
        const [item] = items(first) as (DisplayItem & {
          canonical_id: string;
          parent_message_id: string;
        })[];
        assert(/^dsp_[0-9a-f]{32}$/.test(item.canonical_id), `canonical id ${item.canonical_id}`);
        const rows = await rowsWith(childA, item.canonical_id);
        assert(rows.length === 2, `own + parent rows, got ${rows.length}`);
        const meta = (r: (typeof rows)[number]) =>
          r.metadata as {
            subAgentId?: string;
            displayedBy?: { kind: string; task_id: string };
            excludeFromModel: boolean;
            display: { conversation: string; media_kind: string };
          };
        const own = rows.find((r) => meta(r).display.conversation === 'own');
        const parent = rows.find((r) => meta(r).display.conversation === 'parent');
        assert(
          own && meta(own).subAgentId === task && own.id === item.message_id,
          'own row grouped under the task'
        );
        assert(
          parent &&
            meta(parent).subAgentId === undefined &&
            meta(parent).displayedBy?.task_id === task,
          'parent row top-level in the owning agent, attributed to the code agent'
        );
        assert(
          parent.id === item.parent_message_id,
          'parent_message_id points at the mirrored row'
        );
        assert(
          rows.every((r) => meta(r).excludeFromModel && meta(r).display.media_kind === 'model'),
          'both rows UI-only'
        );
        assert(
          rows.every((r) => r.text === 'Dual'),
          'caption on both rows'
        );
        assert((await rowsWith(rootA, item.canonical_id)).length === 0, 'nothing reaches the root');

        // Retries (sequential + concurrent) add nothing to either conversation.
        const retries = await Promise.all(
          [0, 1, 2].map(() =>
            display(
              childA,
              { items: [b64(glb, 'dual.glb')], caption: 'Dual' },
              { bearer: token(childA, task) }
            )
          )
        );
        for (const res of retries) {
          expectStatus(res, 200, 'retry');
          assert(items(res)[0].status === 'duplicate', 'retry is a duplicate');
          assert(
            (items(res)[0] as { canonical_id?: string }).canonical_id === item.canonical_id,
            'same canonical id'
          );
        }
        assert((await rowsWith(childA, item.canonical_id)).length === 2, 'still exactly two rows');

        // A second code agent in the same owner showing the same bytes: its own row, no second parent row.
        const other = await display(
          childA,
          { items: [b64(glb, 'dual.glb')] },
          { bearer: token(childA, `${task}-b`) }
        );
        expectStatus(other, 201, 'second code agent');
        const otherItem = items(other)[0] as DisplayItem & {
          canonical_id: string;
          parent_message_id: string;
        };
        assert(
          otherItem.canonical_id === item.canonical_id,
          'canonical id is shared with the owning conversation'
        );
        const sharedRows = await rowsWith(childA, item.canonical_id);
        assert(sharedRows.length === 3, 'two task rows plus one parent row share the canonical id');
        assert(
          sharedRows.filter((r) => meta(r).display.conversation === 'parent').length === 1,
          'one parent row'
        );
        assert(
          otherItem.parent_message_id === item.parent_message_id,
          'owning conversation shows it once'
        );

        // A pre-dual-display generic key may still point at a task-grouped row.
        // Replaying it preserves history and creates a real top-level mirror.
        const oldBytes = cubeGlb([0.1, 0.2, 0.3, 1], `legacy-${RUN}`);
        const legacy = await display(
          childA,
          { items: [b64(oldBytes, 'legacy.glb')] },
          { bearer: token(childA, `${task}-legacy`) }
        );
        const legacyItem = items(legacy)[0] as DisplayItem & {
          canonical_id: string;
          parent_message_id: string;
        };
        const genericId = deterministicMessageId(childA, `display:${legacyItem.sha256}`);
        await prisma.message.update({
          where: { id: genericId },
          data: {
            metadata: {
              source: 'display',
              display: { placement: 'inline', kind: 'media', sha256: legacyItem.sha256 },
              subAgentId: `${task}-legacy`,
              task_id: `${task}-legacy`,
            },
          },
        });
        const replay = await display(
          childA,
          { items: [b64(oldBytes, 'legacy.glb')] },
          { bearer: token(childA, `${task}-legacy`) }
        );
        expectStatus(replay, 200, 'legacy replay');
        const replayItem = items(replay)[0] as DisplayItem & { parent_message_id: string };
        assert(
          replayItem.parent_message_id !== genericId,
          'legacy task row is not reused as parent mirror'
        );
        const repaired = await prisma.message.findUnique({
          where: { id: replayItem.parent_message_id },
        });
        assert(
          repaired && !(repaired.metadata as { subAgentId?: string }).subAgentId,
          'mirror is top-level'
        );
        assert(
          (await prisma.message.findUnique({ where: { id: genericId } })) !== null,
          'legacy row preserved'
        );
        const replayAgain = await display(
          childA,
          { items: [b64(oldBytes, 'legacy.glb')] },
          { bearer: token(childA, `${task}-legacy`) }
        );
        assert(
          (items(replayAgain)[0] as { parent_message_id?: string }).parent_message_id ===
            replayItem.parent_message_id,
          'legacy mirror retries reuse the same row'
        );

        // Deeper: a code agent under the grandchild writes only to the grandchild.
        const deep = await display(
          grandchildA,
          { items: [b64(png(), 'deep.png')] },
          { bearer: token(grandchildA, `${task}-deep`) }
        );
        expectStatus(deep, 201, 'depth-2 code agent');
        const deepId = (items(deep)[0] as { canonical_id: string }).canonical_id;
        assert((await rowsWith(grandchildA, deepId)).length === 2, 'two rows on the depth-2 owner');
        assert(
          (await rowsWith(childA, deepId)).length === 0 &&
            (await rowsWith(rootA, deepId)).length === 0,
          'none above it'
        );

        // A Rose agent's own display stays one row in its own conversation.
        const rose = await display(
          rootA,
          { items: [b64(png(), 'rose.png')] },
          { apiKeyUser: userA }
        );
        expectStatus(rose, 201, 'Rose agent display');
        const roseItem = items(rose)[0] as { canonical_id: string; parent_message_id?: string };
        assert(roseItem.parent_message_id === undefined, 'no mirrored row for a Rose agent');
        const roseRows = await rowsWith(rootA, roseItem.canonical_id);
        assert(
          roseRows.length === 1 &&
            (roseRows[0].metadata as { display: { conversation: string } }).display.conversation ===
              'own',
          'one own row'
        );
      },
    },
  ];
}
