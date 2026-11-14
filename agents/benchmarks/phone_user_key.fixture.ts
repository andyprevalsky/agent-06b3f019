/** Isolated local write boundary; token only arrives on stdin, never output. */
import { createRequire } from "node:module";
const require = createRequire(`${process.cwd()}/package.json`);
const { PrismaClient } = require("@prisma/client");
async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const x = JSON.parse(raw);
  const u = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["localhost", "127.0.0.1"].includes(u.hostname) ||
    !u.pathname.startsWith("/victoria") ||
    !["1", "true"].includes(process.env.BENCHMARK_ISOLATED_RUN ?? "") ||
    x.userId !== "c49b4ce3-3489-499d-bfbd-846d04ba6275" ||
    (x.action !== "cleanup" && !x.key?.startsWith("rose-ph6d-")) ||
    !x.root
  )
    throw Error();
  const db = new PrismaClient();
  try {
    await db.$transaction(async (tx: any) => {
      if (
        !(await tx.agent.findFirst({ where: { id: x.root, userId: x.userId } }))
      )
        throw Error();
      const name = `ph6d:${x.root}`;
      if (x.action === "create") {
        if (
          !(await tx.subscription.findUnique({ where: { userId: x.userId } }))
        )
          await tx.subscription.create({
            data: {
              userId: x.userId,
              subscriptionTier: 1,
              stripeSubscriptionId: `ph6d:${x.root}`,
              stripeCustomerId: `ph6d:${x.root}`,
              currentPeriodEnd: new Date(Date.now() + 3600000),
            },
          });
        await tx.roseApiKey.create({
          data: { id: x.id, userId: x.userId, apiKey: x.key, name },
        });
      } else if (x.action === "delete") {
        await tx.roseApiKey.deleteMany({
          where: { id: x.id, userId: x.userId, apiKey: x.key, name },
        });
        await tx.subscription.deleteMany({
          where: {
            userId: x.userId,
            stripeSubscriptionId: `ph6d:${x.root}`,
            stripeCustomerId: `ph6d:${x.root}`,
          },
        });
      } else if (x.action === "cleanup") {
        await tx.roseApiKey.deleteMany({ where: { userId: x.userId, name } });
        await tx.subscription.deleteMany({
          where: {
            userId: x.userId,
            stripeSubscriptionId: `ph6d:${x.root}`,
            stripeCustomerId: `ph6d:${x.root}`,
          },
        });
      } else throw Error();
    });
    process.stdout.write('{"ok":true}');
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  process.stderr.write("Private benchmark owner-key fixture failed\n");
  process.exitCode = 1;
});
