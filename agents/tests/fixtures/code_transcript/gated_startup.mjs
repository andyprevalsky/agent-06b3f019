// Stand-in project startup runner for the sandbox ws-server (ROSE_PROJECT_STARTUP).
// The ws-server runs it before it launches the CLI, so holding it open keeps the
// session in its startup window: the server answers, but no CLI exists yet.
// Releases when <STARTUP_GATE>/start-project exists, then reports a clean startup.
import { existsSync } from "node:fs";
import { join } from "node:path";

const gate = process.env.STARTUP_GATE;
while (!existsSync(join(gate, "start-project"))) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
console.log(
  "ROSE_PROJECT_STARTUP_REPORT " +
    JSON.stringify({
      status: "ok",
      exitCode: 0,
      durationMs: 1,
      timeoutS: 30,
      outputTail: "",
      logPath: null,
    }),
);
