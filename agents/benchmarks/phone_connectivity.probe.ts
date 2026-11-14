/** Read-only local DB probe. Decrypted arguments/OCR never leave this process. */
import { createRequire } from "node:module";
import { checkReceipts } from "./phone_connectivity_receipts";
import { openPhoneValue } from "../../back-end/src/providers/phoneHarnessCredentials";
const require = createRequire(`${process.cwd()}/package.json`);
const { PrismaClient } = require("@prisma/client");

async function main() {
  const userId = process.env.PHONE_BENCH_USER_ID;
  const rootAgentId = process.env.PHONE_BENCH_AGENT_ID;
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.pathname.startsWith("/victoria") ||
    userId !== "c49b4ce3-3489-499d-bfbd-846d04ba6275" ||
    !rootAgentId ||
    !["1", "true"].includes(process.env.BENCHMARK_ISOLATED_RUN ?? "")
  )
    throw new Error("Scope");
  const db = new PrismaClient();
  try {
    const proof = await db.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const agents: { id: string }[] = await tx.$queryRaw`
        WITH RECURSIVE tree AS (
          SELECT id FROM "Agent" WHERE id = ${rootAgentId} AND "userId" = ${userId}
          UNION
          SELECT a.id FROM "Agent" a JOIN tree t ON a."parentAgentId" = t.id WHERE a."userId" = ${userId}
        ) SELECT id FROM tree`;
      if (!agents.length) throw new Error("Ownership");
      const ids = agents.map((a) => a.id);
      if (process.env.PHONE_BENCH_MODE === "cleanup") {
        const device = await tx.iPhoneDevice.findFirst({
          where: {
            userId,
            providerDeviceId: process.env.PHONE_HARNESS_DEVICE_ID,
          },
        });
        if (!device) throw new Error("Missing device");
        const leases = await tx.iPhoneLease.findMany({
          where: { userId, deviceId: device.id, agentId: { in: ids } },
          select: { id: true, status: true },
        });
        const foreignLive = await tx.iPhoneLease.count({
          where: {
            deviceId: device.id,
            agentId: { notIn: ids },
            status: { in: ["ACTIVE", "WAITING"] },
          },
        });
        return {
          owned: true,
          leases,
          foreignLive: foreignLive > 0,
          idle:
            device.providerState === "IDLE" &&
            device.providerStartKey === null &&
            device.providerSessionEncrypted === null &&
            device.providerSessionId === null,
        };
      }
      const root = await tx.agent.findUniqueOrThrow({
        where: { id: rootAgentId },
      });
      const rows = await tx.iPhoneOperation.findMany({
        where: {
          lease: {
            userId,
            agentId: { in: ids },
            browserTaskId: { not: null },
            device: {
              userId,
              providerDeviceId: process.env.PHONE_HARNESS_DEVICE_ID,
            },
          },
          createdAt: { gte: root.createdAt },
        },
        include: { lease: { include: { device: true } } },
        orderBy: { createdAt: "asc" },
      });
      const attentionCount = await tx.agentAttentionRequest.count({
        where: { userId, agentId: { in: ids } },
      });
      const privateRows = rows.map((row: any) => ({
        id: row.id,
        cursor: row.cursor,
        leaseId: row.leaseId,
        actor: row.actor,
        state: row.state,
        errorCode: row.errorCode,
        activeDeviceId: row.activeDeviceId,
        requestKey: row.requestKey,
        operation: row.operation,
        userId: row.lease.userId,
        agentId: row.lease.agentId,
        deviceId: row.lease.device.providerDeviceId,
        createdAt: row.createdAt.getTime(),
        completedAt: row.completedAt?.getTime() ?? null,
        request:
          row.operation === "apps.launch" ||
          row.operation === "setup.defer" ||
          row.errorCode === "phone_setup_required"
            ? openPhoneValue(row.requestEncrypted)
            : null,
        result: row.resultEncrypted
          ? openPhoneValue(row.resultEncrypted)
          : null,
      }));
      return {
        ...checkReceipts(
          privateRows,
          {
            userId,
            rootAgentId,
            agentIds: ids,
            deviceId: process.env.PHONE_HARNESS_DEVICE_ID,
          },
          process.env.PHONE_BENCH_REPORTED_HEADING ?? "",
        ),
        attentionCount,
      };
    });
    process.stdout.write(JSON.stringify(proof));
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  process.stderr.write("Private phone proof unavailable\n");
  process.exitCode = 1;
});
