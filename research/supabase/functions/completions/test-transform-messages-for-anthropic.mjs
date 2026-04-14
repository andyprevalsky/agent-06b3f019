/**
 * Local unit-style checks for transformMessagesForAnthropic in index.ts.
 *
 * Runs against the real function source by extracting the helper functions
 * from index.ts and evaluating them in Node.
 *
 * Run:
 *   node test-transform-messages-for-anthropic.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.join(__dirname, "index.ts");

function extractNamedFunction(source, name) {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`Could not find function '${name}' in index.ts`);
  }

  const paramsOpen = source.indexOf("(", start);
  if (paramsOpen === -1) {
    throw new Error(`Could not find parameter list for '${name}'`);
  }

  let i = paramsOpen + 1;
  let parenDepth = 1;
  while (i < source.length && parenDepth > 0) {
    if (source[i] === "(") parenDepth += 1;
    if (source[i] === ")") parenDepth -= 1;
    i += 1;
  }
  if (parenDepth !== 0) {
    throw new Error(`Could not parse parameter list for '${name}'`);
  }

  while (i < source.length && /\s/.test(source[i])) i += 1;

  // Optional TypeScript return type after ":".
  if (source[i] === ":") {
    i += 1;
    while (i < source.length && /\s/.test(source[i])) i += 1;

    // Handle object return type: {...}
    if (source[i] === "{") {
      let typeBraceDepth = 1;
      i += 1;
      while (i < source.length && typeBraceDepth > 0) {
        if (source[i] === "{") typeBraceDepth += 1;
        if (source[i] === "}") typeBraceDepth -= 1;
        i += 1;
      }
    } else {
      // Handle simple return type (e.g. "any")
      while (i < source.length && source[i] !== "{") i += 1;
    }
    while (i < source.length && /\s/.test(source[i])) i += 1;
  }

  const openBrace = i;
  if (source[openBrace] !== "{") {
    throw new Error(`Could not find function body for '${name}'`);
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBrace; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    const prev = source[i - 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== "\\") inDouble = false;
      continue;
    }
    if (inTemplate) {
      if (ch === "`" && prev !== "\\") inTemplate = false;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      continue;
    }

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error(`Could not find closing brace for '${name}'`);
}

function tsFunctionToRunnableJs(functionSource) {
  return functionSource
    .replace(
      /function\s+transformContentBlockForAnthropic\(([^)]*)\)\s*:\s*any\s*\{/,
      "function transformContentBlockForAnthropic(block) {",
    )
    .replace(
      /function\s+transformMessagesForAnthropic\(([^)]*)\)\s*:\s*\{[^}]*\}\s*\{/,
      "function transformMessagesForAnthropic(messages) {",
    )
    .replace(/: string\[\]/g, "")
    .replace(/: any\[\]/g, "")
    .replace(/: any/g, "");
}

function loadTransformMessagesForAnthropic() {
  const source = fs.readFileSync(indexPath, "utf8");
  const contentFn = tsFunctionToRunnableJs(
    extractNamedFunction(source, "transformContentBlockForAnthropic"),
  );
  const messagesFn = tsFunctionToRunnableJs(
    extractNamedFunction(source, "transformMessagesForAnthropic"),
  );

  const factory = new Function(
    `${contentFn}\n${messagesFn}\nreturn { transformMessagesForAnthropic };`,
  );
  return factory().transformMessagesForAnthropic;
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    return true;
  } catch (error) {
    console.error(`  ❌ ${name}: ${error.message}`);
    return false;
  }
}

function testAssistantToolCallsBecomeToolUse(transformMessagesForAnthropic) {
  const input = [
    { role: "system", content: "You are a test system." },
    { role: "user", content: "Search for recent updates." },
    {
      role: "assistant",
      content: "Running search.",
      tool_calls: [
        {
          id: "tc-1",
          type: "function",
          function: {
            name: "web_search",
            arguments: "{\"query\":\"latest updates\"}",
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "tc-1",
      name: "web_search",
      content: "Found 3 updates.",
    },
  ];

  const transformed = transformMessagesForAnthropic(input);

  assert.equal(transformed.system, "You are a test system.");
  assert.equal(transformed.messages.length, 3);

  const assistant = transformed.messages[1];
  assert.equal(assistant.role, "assistant");
  assert.ok(Array.isArray(assistant.content));

  const textBlock = assistant.content.find((b) => b.type === "text");
  assert.equal(textBlock.text, "Running search.");

  const toolUseBlock = assistant.content.find((b) => b.type === "tool_use");
  assert.equal(toolUseBlock.id, "tc-1");
  assert.equal(toolUseBlock.name, "web_search");
  assert.deepEqual(toolUseBlock.input, { query: "latest updates" });

  const toolResultMessage = transformed.messages[2];
  assert.equal(toolResultMessage.role, "user");
  assert.equal(toolResultMessage.content[0].type, "tool_result");
  assert.equal(toolResultMessage.content[0].tool_use_id, "tc-1");
  assert.equal(toolResultMessage.content[0].content, "Found 3 updates.");
}

function testMalformedToolArgumentsThrow(transformMessagesForAnthropic) {
  const input = [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "tc-bad",
          type: "function",
          function: {
            name: "web_search",
            arguments: "{not-json",
          },
        },
      ],
    },
    {
      role: "tool",
      tool_call_id: "tc-bad",
      content: "bad",
    },
  ];

  assert.throws(
    () => transformMessagesForAnthropic(input),
    /invalid tool_call arguments JSON/,
  );
}

function testMissingToolCallIdThrows(transformMessagesForAnthropic) {
  const input = [
    { role: "user", content: "hello" },
    {
      role: "tool",
      content: "result without ID",
    },
  ];

  assert.throws(
    () => transformMessagesForAnthropic(input),
    /tool message missing tool_call_id/,
  );
}

function testConsecutiveToolResultsBundled(transformMessagesForAnthropic) {
  const input = [
    { role: "user", content: "Do three things." },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "tc-1", type: "function", function: { name: "web_search", arguments: '{"query":"a"}' } },
        { id: "tc-2", type: "function", function: { name: "web_search", arguments: '{"query":"b"}' } },
        { id: "tc-3", type: "function", function: { name: "web_fetch", arguments: '{"url":"c"}' } },
      ],
    },
    { role: "tool", tool_call_id: "tc-1", content: "result 1" },
    { role: "tool", tool_call_id: "tc-2", content: "result 2" },
    { role: "tool", tool_call_id: "tc-3", content: "result 3" },
  ];

  const transformed = transformMessagesForAnthropic(input);

  // Should be: user, assistant, user (bundled 3 tool_results)
  assert.equal(transformed.messages.length, 3, `expected 3 messages, got ${transformed.messages.length}`);

  const bundledUser = transformed.messages[2];
  assert.equal(bundledUser.role, "user");
  assert.equal(bundledUser.content.length, 3, `expected 3 tool_result blocks, got ${bundledUser.content.length}`);
  assert.equal(bundledUser.content[0].type, "tool_result");
  assert.equal(bundledUser.content[0].tool_use_id, "tc-1");
  assert.equal(bundledUser.content[1].tool_use_id, "tc-2");
  assert.equal(bundledUser.content[2].tool_use_id, "tc-3");
}

function testNonConsecutiveToolResultsNotBundled(transformMessagesForAnthropic) {
  const input = [
    { role: "user", content: "step 1" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc-1", type: "function", function: { name: "web_search", arguments: '{"q":"a"}' } }],
    },
    { role: "tool", tool_call_id: "tc-1", content: "result 1" },
    { role: "user", content: "step 2" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc-2", type: "function", function: { name: "web_search", arguments: '{"q":"b"}' } }],
    },
    { role: "tool", tool_call_id: "tc-2", content: "result 2" },
  ];

  const transformed = transformMessagesForAnthropic(input);

  // user, assistant, user(tool_result), user, assistant, user(tool_result) = 6 messages
  // tool_results are NOT consecutive so they should NOT be bundled
  assert.equal(transformed.messages.length, 6, `expected 6 messages, got ${transformed.messages.length}`);
}

function main() {
  console.log("transformMessagesForAnthropic local tests:");
  const transformMessagesForAnthropic = loadTransformMessagesForAnthropic();

  const results = [
    runTest(
      "assistant.tool_calls -> assistant.tool_use and tool -> user.tool_result",
      () => testAssistantToolCallsBecomeToolUse(transformMessagesForAnthropic),
    ),
    runTest(
      "malformed assistant tool_call arguments fail with descriptive error",
      () => testMalformedToolArgumentsThrow(transformMessagesForAnthropic),
    ),
    runTest(
      "tool message missing tool_call_id fails with descriptive error",
      () => testMissingToolCallIdThrows(transformMessagesForAnthropic),
    ),
    runTest(
      "consecutive tool_result messages bundled into one user message",
      () => testConsecutiveToolResultsBundled(transformMessagesForAnthropic),
    ),
    runTest(
      "non-consecutive tool_result messages not bundled",
      () => testNonConsecutiveToolResultsNotBundled(transformMessagesForAnthropic),
    ),
  ];

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} passed`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
