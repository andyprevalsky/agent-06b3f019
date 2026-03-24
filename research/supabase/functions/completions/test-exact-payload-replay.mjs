/**
 * Replay a real worker capture against the Rose completions endpoint.
 *
 * Default payload file:
 *   ./test-prod-request-body.json
 *
 * Optional overrides:
 *   PAYLOAD_PATH=./some-other-capture.json node test-exact-payload-replay.mjs
 *   ROSE_API_URL=... ROSE_API_KEY=... SUPABASE_ANON_KEY=... node test-exact-payload-replay.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROSE_API_URL =
  process.env.ROSE_API_URL ??
  "https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions";
const API_KEY = process.env.ROSE_API_KEY ?? "af1ea4b12ea8dbe07c555a45a8ad4dc8";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const payloadPath = process.env.PAYLOAD_PATH
  ? resolve(process.cwd(), process.env.PAYLOAD_PATH)
  : resolve(__dirname, "test-prod-request-body.json");

function loadPayload(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Payload must be a JSON object");
  }
  if (!Array.isArray(parsed.messages)) {
    throw new Error("Payload must include messages[]");
  }
  return parsed;
}

function extractJsonCandidate(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    JSON.parse(candidate);
    return candidate;
  }

  const jsonStart = trimmed.indexOf("{");
  if (jsonStart === -1) return "";

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = jsonStart; i < trimmed.length; i += 1) {
    const c = trimmed[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (c === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(jsonStart, i + 1);
        JSON.parse(candidate);
        return candidate;
      }
    }
  }

  return "";
}

async function replayPayload() {
  const payload = loadPayload(payloadPath);
  console.log("Replaying payload");
  console.log(`- File: ${payloadPath}`);
  console.log(`- Model: ${payload.model}`);
  console.log(`- Messages: ${payload.messages.length}`);
  payload.messages.forEach((m, i) => {
    const contentLen =
      typeof m.content === "string"
        ? m.content.length
        : JSON.stringify(m.content ?? "").length;
    console.log(`  ${String(i).padStart(2, "0")} ${String(m.role).padEnd(10)} ${contentLen} chars`);
  });
  console.log("");

  const response = await fetch(ROSE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "x-api-key": API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 800)}`);
  }
  if (!response.body) {
    throw new Error("Missing streaming response body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunkCount = 0;
  let contentChunks = 0;
  let accumulatedReasoning = "";
  let accumulatedJson = "";
  let selectedModel = "unknown";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line || !line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      chunkCount += 1;

      if (parsed.actual_model && selectedModel === "unknown") {
        selectedModel = parsed.actual_model;
      }
      if (parsed.usage) {
        usage = parsed.usage;
      }

      const delta = parsed.choices?.[0]?.delta ?? {};
      const reasoning = delta.reasoning ?? "";
      const content = delta.content ?? "";

      if (reasoning) accumulatedReasoning += reasoning;
      if (content) {
        contentChunks += 1;
        accumulatedJson += content;
      }
    }
  }

  console.log("Replay summary");
  console.log(`- SSE chunks parsed: ${chunkCount}`);
  console.log(`- Content chunks: ${contentChunks}`);
  console.log(`- Reasoning chars: ${accumulatedReasoning.length}`);
  console.log(`- JSON chars: ${accumulatedJson.length}`);
  console.log(`- actual_model: ${selectedModel}`);
  if (usage) {
    console.log(
      `- usage: prompt=${usage.prompt_tokens ?? 0} completion=${usage.completion_tokens ?? 0} total=${usage.total_tokens ?? 0}`
    );
  }

  if (!accumulatedJson) {
    throw new Error("No JSON content received in streaming delta.content");
  }

  const jsonCandidate = extractJsonCandidate(accumulatedJson);
  if (!jsonCandidate) {
    throw new Error("Unable to isolate valid JSON object from streamed content");
  }

  const parsedResponse = JSON.parse(jsonCandidate);
  console.log("Parsed response");
  console.log(`- keys: ${Object.keys(parsedResponse).join(", ")}`);
  if (typeof parsedResponse.response !== "undefined") {
    console.log(`- response: ${JSON.stringify(parsedResponse.response)}`);
  }
}

replayPayload()
  .then(() => {
    console.log("PASS: replay completed and parsed JSON output");
  })
  .catch((err) => {
    console.error(`FAIL: ${err?.message ?? String(err)}`);
    process.exitCode = 1;
  });
