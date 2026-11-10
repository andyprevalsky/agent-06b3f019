#!/usr/bin/env npx tsx
/**
 * Debug script for Claude Code E2B sandbox integration.
 * Spawns a sandbox and opens the stream URL in your browser.
 *
 * Usage:
 *   cd e2b-templates/claude-code
 *   npx tsx debug-sandbox.ts "Your goal here"
 *
 * Requires:
 *   - E2B_API_KEY env var
 *   - ANTHROPIC_API_KEY env var
 *   - E2B_CLAUDE_CODE_TEMPLATE_ID env var (defaults to the backend's patched template)
 */

import { Sandbox } from "@e2b/desktop";
import { exec } from "child_process";

const TEMPLATE_ID =
  process.env.E2B_CLAUDE_CODE_TEMPLATE_ID ||
  "claude-code-v21305-node22234-c2-m4";

async function openUrl(url: string) {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} "${url}"`);
}

async function main() {
  const goal = process.argv[2] || "Say hello and list the current directory";

  console.log("=".repeat(60));
  console.log("Claude Code E2B Debug Script");
  console.log("=".repeat(60));

  // Check env vars
  if (!process.env.E2B_API_KEY) {
    console.error("ERROR: E2B_API_KEY not set");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  console.log(`Template ID: ${TEMPLATE_ID}`);
  console.log(`Goal: ${goal}`);
  console.log("");

  // Create sandbox
  console.log("[1/4] Creating E2B Desktop sandbox...");
  const startTime = Date.now();

  const desktop = await Sandbox.create(TEMPLATE_ID, {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 600000, // 10 minutes
    envs: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_GOAL: goal,
    },
  });

  console.log(`   Sandbox ID: ${desktop.sandboxId}`);
  console.log(`   Created in ${Date.now() - startTime}ms`);

  // Start streaming
  console.log("[2/4] Starting stream...");
  let streamUrl: string;
  try {
    await desktop.stream.start({ requireAuth: true });
    const authKey = await desktop.stream.getAuthKey();
    streamUrl = desktop.stream.getUrl({ authKey });
  } catch (e) {
    console.log("   Auth stream failed, using public stream");
    await desktop.stream.start();
    streamUrl = desktop.stream.getUrl();
  }

  console.log(`   Stream URL: ${streamUrl}`);

  // Start Claude Code
  console.log("[3/4] Starting Claude Code in terminal...");
  desktop.commands
    .run(`DISPLAY=:0 /home/user/start-claude-code.sh`, { background: true })
    .catch((err) => console.error("   Failed to start Claude Code:", err));

  // Open browser
  console.log("[4/4] Opening browser...");
  await openUrl(streamUrl);

  console.log("");
  console.log("=".repeat(60));
  console.log("SANDBOX RUNNING");
  console.log("=".repeat(60));
  console.log("");
  console.log(`Stream URL: ${streamUrl}`);
  console.log(`Sandbox ID: ${desktop.sandboxId}`);
  console.log("");
  console.log("Press Ctrl+C to kill the sandbox and exit.");
  console.log("");

  // Debug: Check if env vars are set in sandbox
  console.log("[DEBUG] Checking sandbox environment...");
  try {
    const envCheck = await desktop.commands.run(
      'echo "ANTHROPIC_API_KEY set: $([ -n \\"$ANTHROPIC_API_KEY\\" ] && echo YES || echo NO)"',
    );
    console.log(`   ${envCheck.stdout.trim()}`);

    const goalCheck = await desktop.commands.run(
      'echo "CLAUDE_CODE_GOAL: $CLAUDE_CODE_GOAL"',
    );
    console.log(`   ${goalCheck.stdout.trim()}`);

    const scriptCheck = await desktop.commands.run(
      "cat /home/user/start-claude-code.sh",
    );
    console.log("   start-claude-code.sh contents:");
    console.log(
      scriptCheck.stdout
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n"),
    );
  } catch (e) {
    console.error("   Debug check failed:", e);
  }

  // Keep alive until Ctrl+C
  process.on("SIGINT", async () => {
    console.log("\n[CLEANUP] Killing sandbox...");
    try {
      await desktop.kill();
      console.log("   Sandbox killed.");
    } catch (e) {
      console.error("   Failed to kill sandbox:", e);
    }
    process.exit(0);
  });

  // Keep the process running
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
