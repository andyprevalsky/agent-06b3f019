/** Explicit operator fixture only. Never a browser-agent tool or ordinary boot operation. */
import { PhoneHarnessClient } from "../../back-end/src/providers/phoneHarness";
import { permitted } from "../../back-end/src/providers/phoneAccountPolicy";
import { prisma } from "../../back-end/src/providers/database";

async function main() {
  let input = "";
  for await (const part of process.stdin) input += part;
  const request = JSON.parse(input);
  const db = new URL(process.env.DATABASE_URL ?? "");
  const owner = process.env.BENCHMARK_RUN_USER_ID;
  if (
    !["127.0.0.1", "localhost"].includes(db.hostname) ||
    !db.pathname.startsWith("/victoria_bench_") ||
    !owner ||
    request.deviceId !== process.env.PHONE_HARNESS_DEVICE_ID ||
    !["observe", "reset"].includes(request.action)
  )
    throw Error("scope");
  if (!permitted(await prisma.user.findUnique({ where: { userId: owner } })))
    throw Error("owner");
  const device = await prisma.iPhoneDevice.findUnique({
    where: { userId: owner },
  });
  if (
    device &&
    (device.providerDeviceId !== request.deviceId ||
      device.providerState !== "IDLE" ||
      device.providerSessionId !== null ||
      device.providerSessionEncrypted !== null ||
      device.providerStartKey !== null ||
      (await prisma.iPhoneLease.count({
        where: { deviceId: device.id, status: { in: ["ACTIVE", "WAITING"] } },
      })) ||
      (await prisma.iPhoneOperation.count({
        where: {
          deviceId: device.id,
          OR: [
            { activeDeviceId: { not: null } },
            { state: { in: ["CONNECTING", "RUNNING", "UNKNOWN"] } },
          ],
        },
      })))
  ) {
    throw Error("End the owned phone session first");
  }
  const client = new PhoneHarnessClient();
  const phones = await client.catalog();
  const selected = phones.filter((phone) => phone.id === request.deviceId);
  if (selected.length !== 1) throw Error("Assigned device unavailable");
  if (request.action === "reset") {
    if (selected[0].state !== "available") throw Error("Phone is in use");
    await client.resetDevice(request.deviceId);
    process.stdout.write(
      "PHONE_RESET_RESULT:" + JSON.stringify({ accepted: true }),
    );
  } else
    process.stdout.write(
      "PHONE_RESET_RESULT:" + JSON.stringify({ state: selected[0].state }),
    );
}
main()
  .catch(() => {
    process.stderr.write("Private provider reset/observation failed\n");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
