#!/usr/bin/env node
// Build a NEW, versioned E2B template from a provider's one Dockerfile, leaving the
// shared alias (e2b.toml template_name, e.g. `codex-code`) untouched. Production
// keeps resolving the shared alias until a deploy switches the code default to the
// new name, so the template and the code that needs it change together.
//
//   node e2b-templates/build-template-version.mjs --source codex-code --name codex-code-v0159
//        [--cpu 2] [--memory-mb 1024] [--execute]
//
// Without --execute it prints the plan. Builds with E2B_API_KEY (no CLI login), refuses
// the shared alias and any existing name, and writes a JSON receipt to --receipt (default
// .context/e2b-template-builds/<name>.json). Creates a billed template: a deploy item.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    name: { type: "string" },
    cpu: { type: "string", default: "2" },
    "memory-mb": { type: "string", default: "1024" },
    receipt: { type: "string" },
    execute: { type: "boolean", default: false },
  },
});

function fail(message) {
  console.error(`build-template-version: ${message}`);
  process.exit(2);
}

const source = values.source;
const name = values.name;
if (!source || !/^[a-z0-9-]+$/.test(source))
  fail("--source <template dir> is required");
if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name))
  fail("--name <new versioned alias> is required");
const sourceDir = join(HERE, source);
const toml = readFileSync(join(sourceDir, "e2b.toml"), "utf8");
const sharedAlias = toml.match(/^template_name\s*=\s*"([^"]+)"/m)?.[1];
if (name === sharedAlias)
  fail(
    `refusing to rebuild the shared alias ${sharedAlias}; pick a versioned name`,
  );
const dockerfile = readFileSync(join(sourceDir, "e2b.Dockerfile"), "utf8");
const plan = {
  source,
  name,
  sharedAlias,
  cpuCount: Number(values.cpu),
  memoryMB: Number(values["memory-mb"]),
  pins: Object.fromEntries(
    [...dockerfile.matchAll(/^ARG ([A-Z_]+_VERSION)=(\S+)$/gm)].map((m) => [
      m[1],
      m[2],
    ]),
  ),
};
console.log(JSON.stringify(plan, null, 2));
if (!values.execute) process.exit(0);
if (!process.env.E2B_API_KEY) fail("E2B_API_KEY is required");

const { Template } = await import("e2b");
if (await Template.exists(name))
  fail(`template ${name} already exists; pick a new versioned name`);
const startedAt = new Date().toISOString();
const template = Template({ fileContextPath: sourceDir }).fromDockerfile(
  join(sourceDir, "e2b.Dockerfile"),
);
const build = await Template.build(template, name, {
  cpuCount: plan.cpuCount,
  memoryMB: plan.memoryMB,
  onBuildLogs: (entry) => console.log(`[build] ${entry.toString()}`),
});
const receipt = {
  ...plan,
  startedAt,
  finishedAt: new Date().toISOString(),
  build,
};
const receiptPath = resolve(
  values.receipt ??
    join(HERE, "..", ".context", "e2b-template-builds", `${name}.json`),
);
mkdirSync(dirname(receiptPath), { recursive: true });
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`receipt: ${receiptPath}`);
console.log(JSON.stringify(build));
