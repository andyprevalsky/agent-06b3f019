/** Read-only guarded private probe; no decrypted material leaves this process. */
import { createRequire } from "node:module";
import { openPhoneValue } from "../../back-end/src/providers/phoneHarnessCredentials";
import { checkCritical } from "./phone_critical_attention_receipts";
const require = createRequire(`${process.cwd()}/package.json`);
const { PrismaClient } = require("@prisma/client");
async function main() {
  const userId = process.env.PHONE_BENCH_USER_ID,
    root = process.env.PHONE_BENCH_AGENT_ID;
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.pathname.startsWith("/victoria") ||
    userId !== "c49b4ce3-3489-499d-bfbd-846d04ba6275" ||
    !root ||
    !["1", "true"].includes(process.env.BENCHMARK_ISOLATED_RUN ?? "")
  )
    throw Error();
  const db = new PrismaClient();
  try {
    const proof = await db.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const ids = (
        await tx.$queryRaw`WITH RECURSIVE tree AS (SELECT id FROM "Agent" WHERE id=${root} AND "userId"=${userId} UNION SELECT a.id FROM "Agent" a JOIN tree t ON a."parentAgentId"=t.id WHERE a."userId"=${userId}) SELECT id FROM tree`
      ).map((a: any) => a.id);
      if (!ids.length && process.env.PHONE_BENCH_MODE !== "profile")
        throw Error();
      const device = await tx.iPhoneDevice.findFirstOrThrow({
        where: {
          userId,
          providerDeviceId: process.env.PHONE_HARNESS_DEVICE_ID,
        },
      });
      const setup: any = device.setupEncrypted
        ? openPhoneValue(device.setupEncrypted)
        : { profileRevision: 0 };
      if (process.env.PHONE_BENCH_MODE === "profile") {
        let raw = "";
        for await (const chunk of process.stdin) raw += chunk;
        const input = JSON.parse(raw);
        return {
          profileRevision: setup.profileRevision,
          matches: setup.expectedAppleIdentity === input.identity,
        };
      }
      const attentions = await tx.agentAttentionRequest.findMany({
        where: { userId, agentId: { in: ids } },
        include: { authAssistance: true },
      });
      const a = attentions[0];
      if (!a)
        return {
          source: "persisted-native-attention-v1",
          protocolOnly: true,
          valid: false,
          notExercised: device.setupState === "ready" && !!setup.verified,
        };
      const target = (a.metadata as any)?.target;
      const lease = await tx.iPhoneLease.findUnique({
        where: { id: target?.leaseId ?? "" },
      });
      if (!lease || lease.deviceId !== device.id) return { valid: false };
      const agent = await tx.agent.findUnique({ where: { id: lease.agentId } });
      const task = await tx.browserSession.findUnique({
        where: { id: lease.browserTaskId ?? "" },
        include: { context: true },
      });
      const messages = await tx.message.findMany({
        where: { agentId: { in: ids } },
        select: { agentId: true, workflowGeneration: true, metadata: true },
      });
      const rootRow = await tx.agent.findUniqueOrThrow({ where: { id: root } });
      const rows = await tx.iPhoneOperation.findMany({
        where: {
          deviceId: device.id,
          lease: { agentId: { in: ids } },
          createdAt: { gte: rootRow.createdAt },
        },
      });
      const operations = rows.map((r: any) => ({
        ...r,
        createdAt: r.createdAt.getTime(),
        completedAt: r.completedAt?.getTime() ?? null,
        request: openPhoneValue(r.requestEncrypted),
        result: r.resultEncrypted ? openPhoneValue(r.resultEncrypted) : null,
      }));
      return checkCritical(
        {
          userId,
          deviceId: process.env.PHONE_HARNESS_DEVICE_ID,
          agentIds: ids,
          agent,
          task,
          device,
          setup,
          lease,
          messages,
          attentions: attentions.map((x: any) => ({
            ...x,
            createdAt: x.createdAt.getTime(),
          })),
          operations,
          privacy: device.privateInputEncrypted
            ? openPhoneValue(device.privateInputEncrypted)
            : null,
        },
        process.env.PHONE_BENCH_MODE === "rejected",
        process.env.PHONE_BENCH_CUSTODY
          ? JSON.parse(process.env.PHONE_BENCH_CUSTODY)
          : undefined,
      );
    });
    process.stdout.write(JSON.stringify(proof));
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  process.stderr.write("Private native phone proof unavailable\n");
  process.exitCode = 1;
});
