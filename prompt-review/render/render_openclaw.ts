// Render OpenClaw prompts to plaintext .txt files.
//
// Strategy:
// - System prompt + GPT-5 overlays + bootstrap lines: import live via bun
//   (these files have clean transitive imports).
// - Tool schemas (WebSearchSchema, WebFetchSchema) and the message-tool
//   description: STATIC rendering — the underlying source files pull in
//   too many internal deps to load without the full openclaw build. We
//   reproduce the schema dicts/text inline so the output matches exactly
//   what the LLM sees at runtime.
//
// Run: bun render_openclaw.ts

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const REPO_ROOT = "/Users/andyprevalsky/conductor/workspaces/navi-whisper-lux-v2/istanbul";
const OUTPUT_DIR = `${REPO_ROOT}/prompt-review/rendered/openclaw`;
const OPENCLAW_SRC = `${REPO_ROOT}/openclaw/src`;

async function writeOutput(stem: string, content: string): Promise<number> {
  const path = resolve(OUTPUT_DIR, `${stem}.txt`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
  return content.length;
}

// ---------------------------------------------------------------------------
// 1. System prompt — live import
// ---------------------------------------------------------------------------
async function renderSystemPrompt(): Promise<string> {
  // @ts-ignore - bun handles TS imports
  const mod = await import(`${OPENCLAW_SRC}/agents/system-prompt.ts`);
  // @ts-ignore - bun handles TS imports
  const gpt5 = await import(`${OPENCLAW_SRC}/agents/gpt5-prompt-overlay.ts`);
  // Realistic params: messaging agent with full toolset on Telegram
  return mod.buildAgentSystemPrompt({
    workspaceDir: "/Users/example/workspace",
    toolNames: [
      "read",
      "write",
      "edit",
      "apply_patch",
      "grep",
      "find",
      "ls",
      "exec",
      "process",
      "web_search",
      "web_fetch",
      "browser",
      "cron",
      "message",
      "gateway",
      "agents_list",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_spawn",
      "subagents",
      "session_status",
      "image",
      "image_generate",
    ],
    userTimezone: "America/Los_Angeles",
    userTime: "2026-05-04 12:00:00",
    sourcePath: "/Users/example/openclaw",
    modelAliasLines: [
      "- gpt5: openai/gpt-5.5",
      "- fast: openai/gpt-5.5-mini",
    ],
    skillsPrompt:
      "<available_skills>\n<skill name=\"imagegen\" location=\"/Users/example/.openclaw/skills/imagegen/SKILL.md\"><description>Generate or edit raster images.</description></skill>\n</available_skills>",
    contextFiles: [
      {
        path: "/Users/example/workspace/SOUL.md",
        content: "<SOUL.md contents will be here>",
      },
      {
        path: "/Users/example/workspace/TOOLS.md",
        content: "<TOOLS.md contents will be here>",
      },
      {
        path: "/Users/example/workspace/HEARTBEAT.md",
        content: "<HEARTBEAT.md contents will be here>",
      },
    ],
    heartbeatPrompt:
      "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
    messageToolHints: [
      "For Telegram, prefer concise replies and use message(action=send) for user-visible output when configured.",
    ],
    runtimeInfo: {
      agentId: "agent_demo",
      host: "macbook.local",
      os: "darwin",
      arch: "arm64",
      node: "v22",
      model: "gpt-5.5",
      defaultModel: "gpt-5.5",
      shell: "bash",
      channel: "telegram",
      capabilities: ["inlineButtons"],
    },
    docsPath: "https://docs.openclaw.ai",
    promptMode: "full",
    silentReplyPromptMode: "generic",
    acpEnabled: true,
    promptContribution: gpt5.resolveGpt5SystemPromptContribution({
      providerId: "openai",
      modelId: "gpt-5.5",
      trigger: "user",
    }),
  });
}

// ---------------------------------------------------------------------------
// 2. GPT-5 overlays — live import
// ---------------------------------------------------------------------------
async function renderGpt5Overlays(): Promise<{ chat: string; heartbeat: string; contract: string }> {
  // @ts-ignore
  const mod = await import(`${OPENCLAW_SRC}/agents/gpt5-prompt-overlay.ts`);
  return {
    chat: mod.GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY,
    heartbeat: mod.GPT5_HEARTBEAT_PROMPT_OVERLAY,
    contract: mod.GPT5_BEHAVIOR_CONTRACT,
  };
}

// ---------------------------------------------------------------------------
// 3. Bootstrap prompt — live import (function returns string[])
// ---------------------------------------------------------------------------
async function renderBootstrapPrompt(): Promise<string> {
  // @ts-ignore
  const mod = await import(`${OPENCLAW_SRC}/agents/bootstrap-prompt.ts`);
  const lines: string[] = mod.buildFullBootstrapPromptLines({
    readLine:
      "Please read BOOTSTRAP.md from the workspace and follow it before replying normally.",
    firstReplyLine:
      "Your first user-visible reply for a bootstrap-pending workspace must follow BOOTSTRAP.md, not a generic greeting.",
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 4. Web search schema — STATIC rendering (transcribed from web-search.ts)
//    MAX_SEARCH_COUNT = 10 (from web-search-provider-common.ts:54)
// ---------------------------------------------------------------------------
function renderWebSearchSchema(): string {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query string." },
      count: {
        type: "number",
        description: "Number of results to return.",
        minimum: 1,
        maximum: 10,
      },
      country: {
        type: "string",
        description: "2-letter country code for region-specific results.",
      },
      language: {
        type: "string",
        description: "ISO 639-1 language code for results.",
      },
      freshness: {
        type: "string",
        description: "Filter by time: day, week, month, or year.",
      },
      date_after: {
        type: "string",
        description: "Only results published after this date (YYYY-MM-DD).",
      },
      date_before: {
        type: "string",
        description: "Only results published before this date (YYYY-MM-DD).",
      },
      search_lang: {
        type: "string",
        description: "Brave search result language code.",
      },
      ui_lang: {
        type: "string",
        description: "Brave UI locale code in language-region format.",
      },
      domain_filter: {
        type: "array",
        items: { type: "string" },
        description: "Perplexity native Search API domain filter.",
      },
      max_tokens: {
        type: "number",
        description: "Perplexity native Search API total content budget.",
        minimum: 1,
        maximum: 1000000,
      },
      max_tokens_per_page: {
        type: "number",
        description: "Perplexity native Search API max tokens extracted per page.",
        minimum: 1,
      },
    },
  };
  // The tool description is registered alongside in createWebSearchTool
  // (web-search.ts line 84-86):
  //   "Search the web. Returns provider-normalized results for current information lookup."
  // We render the full tool envelope an LLM would see.
  const tool = {
    name: "web_search",
    description:
      "Search the web. Returns provider-normalized results for current information lookup.",
    parameters: schema,
  };
  return JSON.stringify(tool, null, 2);
}

// ---------------------------------------------------------------------------
// 5. Web fetch schema — STATIC rendering (transcribed from web-fetch.ts)
//    EXTRACT_MODES = ["markdown", "text"] (default "markdown")
// ---------------------------------------------------------------------------
function renderWebFetchSchema(): string {
  const schema = {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "HTTP or HTTPS URL to fetch.",
      },
      extractMode: {
        type: "string",
        enum: ["markdown", "text"],
        default: "markdown",
        description: 'Extraction mode ("markdown" or "text").',
      },
      maxChars: {
        type: "number",
        minimum: 100,
        description: "Maximum characters to return (truncates when exceeded).",
      },
    },
    required: ["url"],
  };
  // Tool envelope — description copied verbatim from createWebFetchTool
  // (openclaw/src/agents/tools/web-fetch.ts ~line 631).
  const tool = {
    name: "web_fetch",
    description:
      "Fetch and extract readable content from a URL (HTML → markdown/text). Use for lightweight page access without browser automation.",
    parameters: schema,
  };
  return JSON.stringify(tool, null, 2);
}

// ---------------------------------------------------------------------------
// 6. Message tool description — STATIC rendering of buildMessageToolDescription
//    Source: openclaw/src/agents/tools/message-tool.ts:639-687
//
//    The function has two return paths. We render both to show the LLM-visible
//    output in each case.
// ---------------------------------------------------------------------------
function renderMessageToolDescription(): string {
  const baseDescription = "Send, delete, and manage messages via channel plugins.";
  const threadReadHint =
    ' Use action="read" with threadId to fetch prior messages in a thread when you need conversation context you do not have yet.';

  // Fallback (no config / no discovery) — what the LLM sees by default.
  const fallback = `${baseDescription} Supports actions: send, delete, react, poll, pin, threads, and more.`;

  // With config: actions are discovered per channel and listed alphabetically.
  // Realistic Telegram action set + a "read" present (which appends the hint).
  const sortedActions = [
    "broadcast",
    "delete",
    "pin",
    "poll",
    "react",
    "read",
    "reply",
    "send",
    "sendAttachment",
    "sendWithEffect",
    "thread-reply",
    "unpin",
    "upload-file",
  ];
  const discovered =
    `${baseDescription} Supports actions: ${sortedActions.join(", ")}.` +
    threadReadHint;

  // Return only the realistic-Telegram channel-aware branch (the path a
  // typical user hits in production). The "fallback" variant is reachable
  // only when no config/discovery is provided, which isn't representative.
  return discovered;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const results: Array<[string, number]> = [];

  // Live-rendered (bun runs the source directly)
  const sysPrompt = await renderSystemPrompt();
  results.push(["openclaw_buildAgentSystemPrompt", await writeOutput("openclaw_buildAgentSystemPrompt", sysPrompt)]);

  const overlays = await renderGpt5Overlays();
  results.push(["openclaw_gpt5_friendly_chat", await writeOutput("openclaw_gpt5_friendly_chat", overlays.chat)]);
  results.push(["openclaw_gpt5_heartbeat", await writeOutput("openclaw_gpt5_heartbeat", overlays.heartbeat)]);
  results.push(["openclaw_gpt5_behavior_contract", await writeOutput("openclaw_gpt5_behavior_contract", overlays.contract)]);

  const bootstrap = await renderBootstrapPrompt();
  results.push(["openclaw_bootstrap_prompt", await writeOutput("openclaw_bootstrap_prompt", bootstrap)]);

  // Static-rendered (transitive deps too heavy)
  results.push(["openclaw_web_search", await writeOutput("openclaw_web_search", renderWebSearchSchema())]);
  results.push(["openclaw_web_fetch", await writeOutput("openclaw_web_fetch", renderWebFetchSchema())]);
  results.push(["openclaw_message_tool", await writeOutput("openclaw_message_tool", renderMessageToolDescription())]);

  console.log("Rendered OpenClaw prompts:");
  for (const [stem, size] of results) {
    console.log(`  ${stem.padEnd(40)} ${String(size).padStart(7)} chars`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
