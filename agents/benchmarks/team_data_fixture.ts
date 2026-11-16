/** Test fixture entrypoint; refuses shared/default or remote databases. */
import { prisma } from "../../back-end/src/providers/database";
import { seedTeamDataFixture } from "../../back-end/src/tests/blackbox/data-teams.fixture";
import {
  TEAM_INTEGRATIONS_MARKER,
  TEAM_MCP_MARKER,
  TEAM_REPO_MARKER,
  seedTeamIntegrationsFixture,
  seedTeamMcpFixture,
  seedTeamRepoFixture,
  teamIntegrationsExpectation,
  teamMcpExpectation,
  teamRepoExpectation,
} from "../../back-end/src/tests/blackbox/team-integrations.fixture";

async function main() {
  const target = new URL(process.env.DATABASE_URL ?? "");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !(
      target.pathname.startsWith("/victoria_") ||
      (target.pathname === "/victoria" &&
        process.env.TEAM_BENCH_OWNED_CLOUD === "1" &&
        process.env.BENCHMARK_ISOLATED_RUN === "true" &&
        Boolean(process.env.FLY_MACHINE_ID))
    ) ||
    process.env.TEAM_BENCH_FIXTURE !== "1"
  ) {
    throw new Error(
      "Team fixture requires an explicitly owned isolated local victoria_* database",
    );
  }
  const [userId, marker] = process.argv.slice(2);
  if (!userId || !marker?.startsWith("ROSE-TEAM-"))
    throw new Error("Missing fixture user or marker");
  if (marker === TEAM_INTEGRATIONS_MARKER) {
    const shared = await seedTeamIntegrationsFixture(userId, marker);
    process.stdout.write(
      JSON.stringify({
        marker,
        ...teamIntegrationsExpectation(shared),
        fixture_user_id: userId,
      }) + "\n",
    );
    return;
  }
  if (marker === TEAM_MCP_MARKER) {
    const mcp = await seedTeamMcpFixture(userId, marker);
    process.stdout.write(
      JSON.stringify({
        marker,
        ...teamMcpExpectation(mcp),
        fixture_user_id: userId,
      }) + "\n",
    );
    return;
  }
  if (marker === TEAM_REPO_MARKER) {
    const repo = await seedTeamRepoFixture(userId, marker);
    process.stdout.write(
      JSON.stringify({
        marker,
        ...teamRepoExpectation(repo),
        fixture_user_id: userId,
      }) + "\n",
    );
    return;
  }
  const fixture = await seedTeamDataFixture(userId, marker);
  process.stdout.write(
    JSON.stringify({
      marker,
      teams: fixture.teams,
      counts: { all: 6, own: 2, atlas: 5, orbit: 4 },
      fixture_user_id: userId,
    }) + "\n",
  );
}
main()
  .catch((error) => {
    process.stderr.write(String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
