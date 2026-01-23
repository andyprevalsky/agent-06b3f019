import 'dotenv/config';
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // List users with phones
  const usersWithPhone = await prisma.user.findMany({
    where: { phone: { not: null } },
    select: { id: true, phone: true, createdAt: true },
    take: 10
  });
  console.log("Users with phones:", usersWithPhone);

  // Try different phone formats
  const phoneFormats = ["+19729777432", "9729777432", "+1 972 977 7432"];
  let user = null;
  for (const phone of phoneFormats) {
    user = await prisma.user.findFirst({ where: { phone } });
    if (user) {
      console.log("Found with format:", phone);
      break;
    }
  }

  if (!user) {
    console.log("User not found with any format");
    // Try finding any user with fingerprint integration
    const anyFp = await prisma.integration.findFirst({
      where: { name: "browser_fingerprint" }
    });
    if (anyFp) {
      console.log("Found fingerprint integration for user:", anyFp.userId);
      // User record might not exist (orphan integration) - that's ok, we just need the userId
      user = { id: anyFp.userId } as any;
    }

    // If still no user, try any user with cookies
    if (!user) {
      const anyCookie = await prisma.cookie.findFirst({
        where: { domain: { contains: "amazon" } }
      });
      if (anyCookie) {
        console.log("Found amazon cookie for user:", anyCookie.userId);
        user = { id: anyCookie.userId } as any;
      }
    }

    if (!user) {
      console.log("No user found with fingerprint or amazon cookies");
      return;
    }
  }

  console.log("User ID:", user.id);

  const fp = await prisma.integration.findUnique({
    where: { userId_name: { userId: user.id, name: "browser_fingerprint" } }
  });
  console.log("Has fingerprint:", !!fp);
  if (fp) {
    const config = fp.config as any;
    console.log("Fingerprint platform:", config?.fingerprint?.navigator?.platform);
    console.log("Fingerprint UA:", config?.fingerprint?.navigator?.userAgent?.substring(0, 80));
    console.log("Fingerprint WebGL vendor:", config?.fingerprint?.webgl?.vendor);
    console.log("Fingerprint WebGL renderer:", config?.fingerprint?.webgl?.renderer?.substring(0, 60));
  }

  const cookieCount = await prisma.cookie.count({ where: { userId: user.id } });
  console.log("Cookie count:", cookieCount);

  const amazonCookies = await prisma.cookie.count({
    where: { userId: user.id, domain: { contains: "amazon" } }
  });
  console.log("Amazon cookies:", amazonCookies);

  const context = await prisma.browserContext.findUnique({
    where: { userId: user.id }
  });
  console.log("Has browser context:", !!context);
  if (context) {
    console.log("Steel profile ID:", context.contextId || "(none yet)");
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
