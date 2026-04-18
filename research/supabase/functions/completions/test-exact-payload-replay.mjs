/**
 * Replay a real worker capture against the Rose completions endpoint.
 *
 * Invariant: the winning model must be from the Claude family (actual_model
 * contains "claude"). If Gemini/GPT/etc. wins, that means every Claude token
 * in the pool failed and Rose fell back — this counts as FAIL, not pass.
 *
 * Default payload file:
 *   ./test-prod-request-body.json
 *
 * Modes:
 *   # Racing mode (no claude_token): Rose uses its pool and races Claude models.
 *   node test-exact-payload-replay.mjs
 *
 *   # Direct mode: pass claude_token(s); Rose routes each directly to Anthropic.
 *   # Reads keychain if no tokens supplied; extras via CLAUDE_TOKENS (comma-list).
 *   CLAUDE_TOKENS="sk-ant-oat01-AAA...,sk-ant-oat01-BBB..." node test-exact-payload-replay.mjs --direct
 *
 * Optional overrides:
 *   PAYLOAD_PATH=./some-other-capture.json node test-exact-payload-replay.mjs
 *   ROSE_API_URL=... ROSE_API_KEY=... SUPABASE_ANON_KEY=... node test-exact-payload-replay.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const ROSE_API_URL = process.env.ROSE_API_URL ??
  'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';
const API_KEY = process.env.ROSE_API_KEY ?? 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const payloadPath = process.env.PAYLOAD_PATH
  ? resolve(process.cwd(), process.env.PAYLOAD_PATH)
  : resolve(__dirname, 'test-prod-request-body.json');

function loadPayload(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Payload must be a JSON object');
  }
  if (!Array.isArray(parsed.messages)) {
    throw new Error('Payload must include messages[]');
  }
  return parsed;
}

function extractJsonCandidate(text) {
  const trimmed = text.trim();
  if (!trimmed) return '';

  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through to fenced extraction
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    JSON.parse(candidate);
    return candidate;
  }

  const jsonStart = trimmed.indexOf('{');
  if (jsonStart === -1) return '';

  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = jsonStart; i < trimmed.length; i += 1) {
    const c = trimmed[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (c === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth += 1;
    if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(jsonStart, i + 1);
        JSON.parse(candidate);
        return candidate;
      }
    }
  }

  return '';
}

function getKeychainToken() {
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    return JSON.parse(raw)?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function resolveTokensFromEnv() {
  const raw = process.env.CLAUDE_TOKENS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

async function replayPayload({ claudeToken, label } = {}) {
  const payload = loadPayload(payloadPath);
  if (claudeToken) payload.claude_token = claudeToken;
  const tag = label ?? (claudeToken ? `direct(${claudeToken.slice(0, 25)}…)` : 'racing(pool)');
  console.log(`Replaying payload [${tag}]`);
  console.log(`- File: ${payloadPath}`);
  console.log(`- Model: ${payload.model}`);
  console.log(`- Messages: ${payload.messages.length}`);
  payload.messages.forEach((m, i) => {
    const contentLen = typeof m.content === 'string'
      ? m.content.length
      : JSON.stringify(m.content ?? '').length;
    console.log(`  ${String(i).padStart(2, '0')} ${String(m.role).padEnd(10)} ${contentLen} chars`);
  });
  console.log('');

  const response = await fetch(ROSE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'x-api-key': API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 800)}`);
  }
  if (!response.body) {
    throw new Error('Missing streaming response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;
  let contentChunks = 0;
  let accumulatedReasoning = '';
  let accumulatedJson = '';
  let selectedModel = 'unknown';
  let claudeTokenError = null;
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line || !line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      chunkCount += 1;

      if (parsed.actual_model && selectedModel === 'unknown') {
        selectedModel = parsed.actual_model;
      }
      if (parsed.claude_token_error && !claudeTokenError) {
        claudeTokenError = parsed.claude_token_error;
      }
      if (parsed.usage) {
        usage = parsed.usage;
      }

      const delta = parsed.choices?.[0]?.delta ?? {};
      const reasoning = delta.reasoning ?? '';
      const content = delta.content ?? '';

      if (reasoning) accumulatedReasoning += reasoning;
      if (content) {
        contentChunks += 1;
        accumulatedJson += content;
      }
    }
  }

  console.log(`Replay summary [${tag}]`);
  console.log(`- SSE chunks parsed: ${chunkCount}`);
  console.log(`- Content chunks: ${contentChunks}`);
  console.log(`- Reasoning chars: ${accumulatedReasoning.length}`);
  console.log(`- JSON chars: ${accumulatedJson.length}`);
  console.log(`- actual_model: ${selectedModel}`);
  if (claudeTokenError) {
    console.log(`- claude_token_error: ${claudeTokenError}`);
  }
  if (usage) {
    console.log(
      `- usage: prompt=${usage.prompt_tokens ?? 0} completion=${
        usage.completion_tokens ?? 0
      } total=${usage.total_tokens ?? 0}`,
    );
  }

  if (!/claude/i.test(selectedModel)) {
    throw new Error(
      `INVARIANT: winning model is not Claude family. actual_model="${selectedModel}"` +
        (claudeTokenError ? `, claude_token_error="${claudeTokenError}"` : '') +
        '. This means every Claude pool token failed; Rose fell back to a non-Claude racer.',
    );
  }

  if (!accumulatedJson) {
    throw new Error('No JSON content received in streaming delta.content');
  }

  const jsonCandidate = extractJsonCandidate(accumulatedJson);
  if (!jsonCandidate) {
    throw new Error('Unable to isolate valid JSON object from streamed content');
  }

  const parsedResponse = JSON.parse(jsonCandidate);
  console.log('Parsed response');
  console.log(`- keys: ${Object.keys(parsedResponse).join(', ')}`);
  if (typeof parsedResponse.response !== 'undefined') {
    console.log(`- response: ${JSON.stringify(parsedResponse.response)}`);
  }
}

async function runAll() {
  const directMode = process.argv.includes('--direct');
  const runs = [];

  if (directMode) {
    const envTokens = resolveTokensFromEnv();
    const keychain = getKeychainToken();
    if (keychain) {
      runs.push({ label: `direct(keychain ${keychain.slice(0, 25)}…)`, token: keychain });
    }
    envTokens.forEach((t, i) => {
      runs.push({ label: `direct(env#${i} ${t.slice(0, 25)}…)`, token: t });
    });
    if (runs.length === 0) {
      throw new Error('--direct requires CLAUDE_TOKENS env or a keychain token');
    }
  } else {
    runs.push({ label: 'racing(pool)', token: undefined });
  }

  const results = [];
  for (const run of runs) {
    console.log('='.repeat(72));
    try {
      await replayPayload({ claudeToken: run.token, label: run.label });
      results.push({ label: run.label, passed: true });
      console.log(`PASS [${run.label}]`);
    } catch (err) {
      results.push({ label: run.label, passed: false, error: err?.message ?? String(err) });
      console.error(`FAIL [${run.label}]: ${err?.message ?? String(err)}`);
    }
    console.log('');
  }

  const failed = results.filter((r) => !r.passed);
  console.log('='.repeat(72));
  console.log(`Summary: ${results.length - failed.length}/${results.length} passed`);
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.label}${r.error ? ` — ${r.error}` : ''}`);
  }
  if (failed.length > 0) process.exitCode = 1;
}

runAll().catch((err) => {
  console.error(`FATAL: ${err?.message ?? String(err)}`);
  process.exitCode = 1;
});
