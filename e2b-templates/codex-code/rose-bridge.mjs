#!/usr/bin/env node
/**
 * Rose API bridge for Codex harness sandboxes.
 * Reads ROSE_API_BASE_URL, ROSE_API_KEY, ROSE_USER_ID from the environment.
 */
import { parseArgs } from "util";

const BASE = (process.env.ROSE_API_BASE_URL || "").replace(/\/$/, "");
const API_KEY = process.env.ROSE_API_KEY || "";
const USER_ID = process.env.ROSE_USER_ID || "";
const MEMORY_ENABLED =
  (process.env.ROSE_MEMORY_ENABLED || "false").trim().toLowerCase() === "true";

function usage() {
  console.error(
    "Usage: node rose-bridge.mjs agents create|get|poll | data grep [options]",
  );
  process.exit(2);
}

function requireEnv() {
  if (!BASE || !API_KEY || !USER_ID) {
    throw new Error(
      "ROSE_API_BASE_URL, ROSE_API_KEY, and ROSE_USER_ID must be set",
    );
  }
}

async function roseRequest(path, options = {}) {
  requireEnv();
  const url = `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY,
    "X-User-Id": USER_ID,
    // This bridge is installed only in the benchmark harness sandbox. The
    // secret-valued marker keeps work agents classified as benchmark runs.
    "X-Benchmark-Run": API_KEY,
    ...(options.headers || {}),
  };
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail =
      typeof data === "object" && data !== null
        ? JSON.stringify(data)
        : String(data);
    throw new Error(`Rose API ${response.status} ${path}: ${detail}`);
  }
  return data;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function agentsCreate(args) {
  const goal = args.goal;
  if (!goal) throw new Error("agents create requires --goal");
  const body = {
    goal,
    source: "WEB",
    price_limit_cents: Number(args["price-limit-cents"] || 500),
    memory_enabled: MEMORY_ENABLED,
  };
  if (args["start-phase"]) body.start_phase = args["start-phase"];
  const data = await roseRequest("/api/agents", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (args.json) printJson(data);
  else console.log(data.agent_id || data.agentId || JSON.stringify(data));
}

async function agentsGet(agentId, json) {
  const data = await roseRequest(`/api/agents/${agentId}`);
  if (json) printJson(data);
  else console.log(JSON.stringify(data));
}

// Polls until the agent is terminal. No default deadline: Rose agents have no
// runtime limit (code-agent C11). --timeout-seconds N bounds it explicitly.
async function agentsPoll(agentId, args) {
  const timeoutSeconds = args["timeout-seconds"]
    ? Number(args["timeout-seconds"])
    : null;
  const deadline =
    timeoutSeconds !== null ? Date.now() + timeoutSeconds * 1000 : Infinity;
  let last = null;
  while (Date.now() < deadline) {
    last = await roseRequest(`/api/agents/${agentId}`);
    const status = (last.agent || last).status || last.status;
    if (["COMPLETED", "PAUSED", "ERROR", "CANCELLED"].includes(status)) {
      if (args.json) printJson(last);
      else console.log(status);
      return last;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`Timed out polling agent ${agentId} after ${timeoutSeconds}s`);
}

async function dataGrep(args) {
  const pattern = args.pattern;
  if (!pattern) throw new Error("data grep requires --pattern");
  const sources = (args.sources || "messages").split(",").map((s) => s.trim());
  const body = {
    pattern,
    sources,
    head_limit: Number(args["head-limit"] || 20),
    multiline: args.multiline === "true",
  };
  const data = await roseRequest("/api/data/grep", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (args.json) printJson(data);
  else console.log(JSON.stringify(data));
}

const { positionals, values } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    goal: { type: "string" },
    "start-phase": { type: "string" },
    "price-limit-cents": { type: "string" },
    "timeout-seconds": { type: "string" },
    pattern: { type: "string" },
    sources: { type: "string" },
    "head-limit": { type: "string" },
    multiline: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

if (positionals.length < 2) usage();

const [domain, command] = positionals;

try {
  if (domain === "agents") {
    if (command === "create") await agentsCreate(values);
    else if (command === "get") await agentsGet(positionals[2], values.json);
    else if (command === "poll") await agentsPoll(positionals[2], values);
    else usage();
  } else if (domain === "data" && command === "grep") {
    await dataGrep(values);
  } else {
    usage();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
