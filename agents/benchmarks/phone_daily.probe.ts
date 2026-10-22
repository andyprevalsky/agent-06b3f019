import { userIntervened } from "./phone_daily.window";
/** Private read-only persisted collector. No grants, OCR, codes or identities leave. */
import { createRequire } from "node:module";
import { setupDto } from "../../back-end/src/domains/iphone/repo.setup";
import {
  phoneCommandHash,
  openPhoneValue,
} from "../../back-end/src/providers/phoneHarnessCredentials";
import { setupState } from "../../back-end/src/providers/phoneSetupState";
const require = createRequire(`${process.cwd()}/package.json`);
const { PrismaClient } = require("@prisma/client");
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const userId = process.env.PHONE_BENCH_USER_ID;
  const root = process.env.PHONE_BENCH_AGENT_ID;
  const providerDeviceId = process.env.PHONE_HARNESS_DEVICE_ID;
  if (
    !["localhost", "127.0.0.1"].includes(url.hostname) ||
    !url.pathname.startsWith("/victoria_bench_") ||
    !userId ||
    !root ||
    !providerDeviceId ||
    !["true", "1"].includes(process.env.BENCHMARK_ISOLATED_RUN ?? "")
  )
    throw Error("scope");
  const db = new PrismaClient();
  try {
    const result = await db.$transaction(async (tx: any) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const device = await tx.iPhoneDevice.findUnique({ where: { userId } });
      if (!device || device.providerDeviceId !== providerDeviceId)
        throw Error("device");
      if (process.env.PHONE_BENCH_MODE === "profile") {
        let raw = "";
        for await (const chunk of process.stdin) raw += chunk;
        const profile = JSON.parse(raw);
        const state = setupState(device.setupEncrypted);
        return {
          profileRevision: state.profileRevision,
          matches:
            state.expectedAppleIdentity === profile.expectedAppleIdentity &&
            state.expectedGoogleIdentity === profile.expectedGoogleIdentity &&
            (state.allowGooglePasscodeException === true) ===
              (profile.allowGooglePasscodeException === true),
        };
      }
      const agents =
        await tx.$queryRaw`WITH RECURSIVE tree AS (SELECT id FROM "Agent" WHERE id=${root} AND "userId"=${userId} UNION SELECT a.id FROM "Agent" a JOIN tree t ON a."parentAgentId"=t.id WHERE a."userId"=${userId}) SELECT id FROM tree`;
      const ids = agents.map((a: any) => a.id);
      if (!ids.length) throw Error("owner");
      const leases = await tx.iPhoneLease.findMany({
        where: { deviceId: device.id, userId, agentId: { in: ids } },
        orderBy: { ticket: "desc" },
      });
      if (process.env.PHONE_BENCH_MODE === "cleanup") {
        const foreign = await tx.iPhoneLease.count({
          where: {
            deviceId: device.id,
            agentId: { notIn: ids },
            status: { in: ["ACTIVE", "WAITING"] },
          },
        });
        return {
          leases: leases.map((l: any) => ({ id: l.id, status: l.status })),
          foreignLive: foreign > 0,
          idle:
            device.providerState === "IDLE" &&
            device.providerStartKey === null &&
            device.providerSessionEncrypted === null &&
            device.providerSessionId === null,
        };
      }
      const lease = leases[0];
      if (!lease)
        return {
          passed: false,
          unexercised: true,
          reason: "owned_phone_lease_missing",
        };
      if (["google", "messages"].includes(process.env.PHONE_BENCH_MODE ?? "")) {
        const rows = await tx.iPhoneOperation.findMany({
          where: {
            deviceId: device.id,
            leaseId: { in: leases.map((l: any) => l.id) },
            actor: "agent",
            state: "SUCCEEDED",
            providerEpoch: device.providerEpoch,
          },
        });
        const reads = rows.filter(
          (row: any) => row.operation === "screen.text" && row.resultEncrypted,
        );
        const mutations = rows.filter(
          (row: any) =>
            row.operation.startsWith("input.") ||
            row.operation === "messages.send_approved",
        );
        const attentionCount = await tx.agentAttentionRequest.count({
          where: { userId, agentId: { in: ids } },
        });
        const queue =
          process.env.PHONE_BENCH_MODE === "messages"
            ? await tx.imessageQueue.findFirst({
                where: {
                  userId,
                  transport: "phone_harness",
                  failedAt: null,
                  phoneSendOperationId: { not: null },
                  phoneBrowserTaskId: {
                    in: leases.map((l: any) => l.browserTaskId).filter(Boolean),
                  },
                  sentAt: { not: null },
                },
              })
            : null;
        return {
          passed:
            reads.length > 0 &&
            mutations.length > 0 &&
            attentionCount === 0 &&
            (process.env.PHONE_BENCH_MODE !== "messages" || !!queue),
          source: "owned-persisted-phone-v1",
          evidenceMode: "static_custody_requires_declared_semantic_judge",
          semanticProof: false,
          ownedReadCount: reads.length,
          ownedMutationCount: mutations.length,
          durableSendReceipt: !!queue,
        };
      }
      if (process.env.PHONE_BENCH_MODE === "sms") {
        let raw = "";
        for await (const chunk of process.stdin) raw += chunk;
        const report = JSON.parse(raw);
        if (
          report.scenario !== "phone_sms_otp" ||
          typeof report.siteId !== "string"
        )
          throw Error("issuer");
        const tasks = await tx.browserSession.findMany({
          where: {
            id: { in: leases.map((l: any) => l.browserTaskId).filter(Boolean) },
            agentId: { in: ids },
          },
          include: { context: true },
        });
        const validTasks = new Set(
          tasks
            .filter(
              (t: any) =>
                t.context?.userId === userId &&
                [t.startUrl, t.currentUrl].some(
                  (url: any) =>
                    typeof url === "string" && url.includes(report.siteId),
                ),
            )
            .map((t: any) => t.id),
        );
        const ownedLeases = leases.filter((l: any) =>
          validTasks.has(l.browserTaskId),
        );
        const rows = await tx.iPhoneOperation.findMany({
          where: {
            deviceId: device.id,
            leaseId: { in: ownedLeases.map((l: any) => l.id) },
          },
          orderBy: { createdAt: "asc" },
        });
        const challenges = (report.phoneSmsChallenges ?? []).filter(
          (c: any) =>
            c.liveTransport === true &&
            c.deliveryAck === true &&
            c.consumedAt &&
            Date.parse(c.issuedAt) < Date.parse(c.consumedAt) &&
            Date.parse(c.consumedAt) <= Date.parse(c.expiresAt),
        );
        for (const challenge of challenges) {
          const attentionCount = await tx.agentAttentionRequest.count({
            where: {
              userId,
              agentId: { in: ids },
              createdAt: {
                gte: new Date(challenge.issuedAt),
                lte: new Date(challenge.consumedAt),
              },
            },
          });
          const session = (report.sessions ?? []).find(
            (session: any) =>
              session.method === "sms_code" &&
              session.email === report.signInEmail &&
              !session.endedAt &&
              Date.parse(session.createdAt) >= Date.parse(challenge.consumedAt),
          );
          const reads = rows.filter((o: any) => {
            if (
              o.actor !== "agent" ||
              o.operation !== "screen.text" ||
              o.state !== "SUCCEEDED" ||
              !o.resultEncrypted ||
              o.providerEpoch !== device.providerEpoch ||
              !o.completedAt ||
              o.createdAt < new Date(challenge.issuedAt) ||
              o.completedAt > new Date(challenge.consumedAt)
            )
              return false;
            const boxes: any = openPhoneValue(o.resultEncrypted);
            if (!Array.isArray(boxes)) return false;
            const text = boxes
              .filter(
                (b: any) => b.source === "pixels" && typeof b.text === "string",
              )
              .map((b: any) => b.text)
              .join(" ");
            if (!text.includes(challenge.challengeId)) return false;
            return [...text.matchAll(/\b(\d{6})\b/g)].some(
              (match) =>
                phoneCommandHash(
                  "phone-sms-code",
                  {
                    siteId: report.siteId,
                    challengeId: challenge.challengeId,
                    code: match[1],
                  },
                  "agent",
                ) === challenge.codeDigest,
            );
          });
          const forbidden = rows.some((o: any) =>
            userIntervened(o, challenge.issuedAt, challenge.consumedAt),
          );
          if (session && reads.length && !attentionCount && !forbidden)
            return {
              passed: true,
              source: "controlled-site-live-phone-v1",
              kind: "sms",
              evidenceMode: "controlled_site_real_phone",
              ownedPhoneRead: true,
              issuerConsumed: true,
              targetSession: true,
              reason: null,
            };
        }
        return {
          passed: false,
          unexercised: false,
          kind: "sms",
          reason: "current_owned_phone_challenge_consumption_proof_missing",
        };
      }
      const state = setupState(device.setupEncrypted);
      const agent = await tx.agent.findUnique({ where: { id: lease.agentId } });
      const bound =
        state.attempt?.leaseId === lease.id &&
        state.attempt?.taskId === lease.browserTaskId &&
        state.attempt?.agentId === lease.agentId &&
        state.attempt?.workflowId === (agent?.temporalWorkflowId ?? agent?.id);
      const dto = setupDto(device, state, lease);
      const operations = await tx.iPhoneOperation.findMany({
        where: { deviceId: device.id, leaseId: lease.id, actor: "agent" },
        select: { id: true, operation: true, state: true, completedAt: true },
      });
      const attentionCount = await tx.agentAttentionRequest.count({
        where: { userId, agentId: { in: ids } },
      });
      const resetAt = Number(process.env.PHONE_BENCH_RESET_AVAILABLE_AT);
      const rootAgent = await tx.agent.findUnique({ where: { id: root } });
      const resetCurrent =
        Number.isFinite(resetAt) &&
        resetAt > 0 &&
        rootAgent?.createdAt.getTime() >= resetAt * 1000 &&
        operations.some(
          (o: any) =>
            o.operation === "setup.verify" &&
            o.state === "SUCCEEDED" &&
            o.completedAt?.getTime() >= resetAt * 1000,
        );
      const ready =
        bound &&
        dto.verification.configurationReady &&
        resetCurrent &&
        attentionCount === 0;
      // Canonical projector checks version/profile/generation/epoch/floor. This
      // is a current-state audit, NEVER a fresh-reset/agent-boot attestation.
      return {
        passed: ready,
        providerPreparationAssisted: true,
        source: "owned-persisted-phone-v1",
        kind: "boot",
        userId,
        rootAgentId: root,
        deviceId: device.id,
        actor: "agent",
        current: bound,
        operationIds: operations
          .filter(
            (o: any) =>
              o.state === "SUCCEEDED" && o.operation === "setup.verify",
          )
          .map((o: any) => o.id),
        attentionCount,
        boot: {
          requirementsVersion: dto.verification.requirementsVersion,
          current: bound,
          configurationReady: dto.verification.configurationReady,
          checks: dto.verification.checks,
          securityDisposition: dto.verification.securityDisposition,
          freshProviderResetVerified: resetCurrent,
          agentPerformedBoot: ready,
          // Credential correctness is separately checked by the required semantic judge.
          credentialHandling: "requires_semantic_judge",
        },
        stateAudit: {
          current: bound,
          configurationReady: dto.verification.configurationReady,
        },
        unexercised: !resetCurrent,
        reason: ready ? null : "fresh_reset_and_agent_boot_attestation_missing",
      };
    });
    process.stdout.write(JSON.stringify(result));
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  process.stderr.write("Daily phone private collector failed\n");
  process.exitCode = 1;
});
