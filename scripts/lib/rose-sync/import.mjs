/**
 * `rose import detect|scan|apply`: the Rose Mac app's import without copy and
 * paste. The app picks a folder and runs these; all the logic lives here so it
 * is testable anywhere (the app is a thin shell).
 *
 *   detect  which local coding agents are installed and signed in
 *           (Codex: $CODEX_HOME/auth.json with tokens or an API key; Claude Code:
 *           the "Claude Code-credentials" Keychain item, $CLAUDE_CONFIG_DIR/
 *           .credentials.json or ANTHROPIC_API_KEY); Codex is preferred
 *   scan    capture the checkout, then run that agent READ-ONLY in the folder
 *           for an import plan; the plan is validated against the checkout
 *           (paths inside it, existing files, no secret values) before it is shown
 *   apply   push the plan (cli.mjs), optionally import the GitHub credential,
 *           verify the upload
 *
 * Secret values never leave this process except encrypted by `push`: the
 * agent's prompt carries variable NAMES only, its .env reads are denied where
 * the agent supports it, and every plan string containing a captured value is
 * dropped.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, posix, resolve, sep } from "node:path";
import { dotenvNames, isDotenvPath } from "./capture.mjs";
import { readLocalGithubCredential } from "./github.mjs";

export const IMPORT_AGENTS = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
];
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;
const MAX_AGENT_OUTPUT = 32 * 1024 * 1024;

// ── detect ───────────────────────────────────────────────────────────────────

function onPath(name, env) {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function runnable(name, env) {
  const binary = onPath(name, env);
  if (binary === null) return null;
  const version = spawnSync(binary, ["--version"], {
    env,
    stdio: "ignore",
    timeout: 15_000,
  });
  return version.status === 0 ? binary : null;
}

const homeOf = (env) => env.HOME || homedir();

function codexSignedIn(env) {
  const file = join(env.CODEX_HOME || join(homeOf(env), ".codex"), "auth.json");
  try {
    const auth = JSON.parse(readFileSync(file, "utf8"));
    const tokens = auth?.tokens;
    const hasTokens =
      tokens !== null &&
      typeof tokens === "object" &&
      ["access_token", "refresh_token", "id_token"].some(
        (key) => typeof tokens[key] === "string" && tokens[key] !== "",
      );
    return (
      hasTokens ||
      (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY !== "")
    );
  } catch {
    return false;
  }
}

function claudeSignedIn(env) {
  if ((env.ANTHROPIC_API_KEY ?? "").trim() !== "") return true;
  const dir = env.CLAUDE_CONFIG_DIR || join(homeOf(env), ".claude");
  if (existsSync(join(dir, ".credentials.json"))) return true;
  const security = onPath("security", env);
  if (security === null) return false;
  // Exit code only: without -w the Keychain never returns the secret.
  const found = spawnSync(
    security,
    ["find-generic-password", "-s", "Claude Code-credentials"],
    { env, stdio: "ignore", timeout: 15_000 },
  );
  return found.status === 0;
}

/** Local coding agents and the preferred one (Codex subscriptions before Claude). */
export function detectAgents(env = process.env) {
  const signedIn = { codex: codexSignedIn(env), claude: claudeSignedIn(env) };
  const agents = IMPORT_AGENTS.map(({ id, label }) => ({
    id,
    label,
    signedIn: signedIn[id],
    binary: runnable(id, env),
  }));
  const usable = agents.find(
    (agent) => agent.signedIn && agent.binary !== null,
  );
  return { agents, preferred: usable?.id ?? null };
}

// ── the agent's prompt and output ───────────────────────────────────────────

export const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "projectName",
    "branch",
    "envFiles",
    "extraFiles",
    "setupCommands",
    "notes",
  ],
  properties: {
    projectName: { type: "string" },
    branch: { type: "string" },
    envFiles: { type: "array", items: { type: "string" } },
    extraFiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "reason"],
        properties: { path: { type: "string" }, reason: { type: "string" } },
      },
    },
    setupCommands: { type: "array", items: { type: "string" } },
    notes: { type: "array", items: { type: "string" } },
  },
};

/** What the agent is told about the checkout: paths and variable NAMES, never values. */
export function scanFacts(summary) {
  return {
    git: {
      remote: summary.git.remote,
      remoteDefaultBranch: summary.git.remoteDefaultBranch,
      currentBranch: summary.git.branch,
      unpushedCommits: summary.git.unpushedCommits,
    },
    envFiles: summary.files
      .filter((file) => file.kind === "env")
      .map((file) => ({ path: file.path, variables: file.variables })),
    configFiles: summary.files
      .filter((file) => file.kind !== "env")
      .map((file) => file.path),
    toolchain: summary.toolchain,
    setupSuggested: summary.setup?.suggested ?? [],
  };
}

/** The read-only instruction every agent gets. */
export function buildScanPrompt({
  facts,
  defaultName,
  fixedName,
  defaultBranch,
}) {
  const name = fixedName
    ? `exactly ${JSON.stringify(fixedName)} (the Rose project this import is for)`
    : `a short project name; default ${JSON.stringify(defaultName)} (the repository folder)`;
  return [
    "You are helping import this local code repository into Rose, a cloud workspace where coding agents run it.",
    "Work read-only: do not create, change or delete any file, and do not run commands that change anything.",
    "Never open, read, print or quote the contents of .env files or any other secret file. Use only their paths and the variable NAMES given below.",
    "",
    "Repository facts (env files list variable names only):",
    JSON.stringify(facts, null, 2),
    "",
    "Inspect the repository (README, lockfiles, package scripts, build files) and answer with ONE JSON object and nothing else:",
    '{"projectName": string, "branch": string, "envFiles": [string], "extraFiles": [{"path": string, "reason": string}], "setupCommands": [string], "notes": [string]}',
    `- projectName: ${name}.`,
    `- branch: the branch new workspaces start from: the remote's default branch (${JSON.stringify(defaultBranch)} unless the facts show otherwise).`,
    "- envFiles: paths, relative to the repository root, of the env and secret files a fresh workspace needs. Paths only.",
    "- extraFiles: files git ignores that the app needs to run (not dependencies, caches or build output), each with a one-sentence reason. Paths relative to the repository root.",
    "- setupCommands: in order, the shell commands a fresh checkout needs before it runs (dependency installs, code generation), from the lockfiles, README and package scripts. No commands that prompt for secrets, start long-running servers or touch production.",
    "- notes: up to 5 short notes for the user, for example a local database the app expects (Rose does not import database dumps).",
  ].join("\n");
}

/** The JSON object in an agent's final message (bare, fenced, or embedded), or null. */
export function parsePlanText(text) {
  if (typeof text !== "string") return null;
  const candidates = [
    text.trim(),
    /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]?.trim(),
    text.includes("{")
      ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
      : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        return value;
    } catch {
      // next candidate
    }
  }
  return null;
}

// ── running the agent ───────────────────────────────────────────────────────

export class AgentTimeoutError extends Error {}

/** Run `binary`, killing its whole process group at the deadline; never hangs. */
function runProcess(binary, args, { cwd, env, timeoutMs }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_AGENT_OUTPUT) stdout += chunk;
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) rejectRun(new AgentTimeoutError("timed out"));
      else resolveRun({ code, stdout });
    });
  });
}

/** One read-only agent run in `dir`; the plan object it answered, or null. */
async function askAgent(agent, binary, dir, prompt, env, timeoutMs) {
  if (agent === "codex") {
    const work = mkdtempSync(join(tmpdir(), "rose-import-"));
    try {
      const schema = join(work, "plan.schema.json");
      const out = join(work, "plan.json");
      writeFileSync(schema, JSON.stringify(PLAN_SCHEMA));
      const args = [
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "-C",
        dir,
        "--output-schema",
        schema,
        "-o",
        out,
        prompt,
      ];
      const { code } = await runProcess(binary, args, {
        cwd: dir,
        env,
        timeoutMs,
      });
      if (code !== 0 || !existsSync(out)) return null;
      return parsePlanText(readFileSync(out, "utf8"));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--permission-mode",
    "plan",
    "--disallowedTools",
    "Bash,Edit,Write,Read(**/.env*),Read(**/*.env)",
  ];
  const { code, stdout } = await runProcess(binary, args, {
    cwd: dir,
    env,
    timeoutMs,
  });
  if (code !== 0) return null;
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    return null;
  }
  return result?.is_error === true ? null : parsePlanText(result?.result);
}

// ── validating the plan against the checkout ────────────────────────────────

/** Values the checkout's captured files hold: no plan string may contain one. */
export function capturedValues(capture) {
  const values = new Set();
  for (const file of capture.files) {
    const text = file.content.toString("utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const assignment =
        /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(.*)$/.exec(line);
      const value = (assignment ? assignment[1] : line)
        .replace(/^["']|["']$/g, "")
        .trim();
      if (value.length >= (assignment ? 4 : 8)) values.add(value);
    }
  }
  return [...values];
}

const oneLine = (value, max) =>
  typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";

function insideRoot(root, path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 300)
    return null;
  if (/[\0\r\n]/.test(path) || isAbsolute(path) || path.includes("\\"))
    return null;
  const normalized = posix.normalize(path).replace(/^\.\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized === ".")
    return null;
  const absolute = resolve(root, normalized);
  if (!absolute.startsWith(root + sep)) return null;
  try {
    if (!statSync(absolute).isFile()) return null;
    if (!realpathSync(absolute).startsWith(realpathSync(root) + sep))
      return null;
  } catch {
    return null;
  }
  return normalized;
}

/**
 * The agent's (or a user-edited) plan, clamped to the checkout: names and
 * branches sanitized with safe defaults, file paths inside the repository and
 * existing, variable names from the files themselves, and anything that
 * contains a captured value dropped. Null when it is not a plan at all.
 */
export function clampPlan(
  raw,
  { root, capture, defaultName, fixedName, defaultBranch },
) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const values = capturedValues(capture);
  const leaks = (text) => values.some((value) => text.includes(value));
  const captured = new Map(capture.files.map((file) => [file.path, file]));
  const pathOf = (entry) => (typeof entry === "string" ? entry : entry?.path);
  const name = oneLine(raw.projectName, 101);
  const branch = typeof raw.branch === "string" ? raw.branch.trim() : "";
  const branchOk =
    /^[A-Za-z0-9._/-]{1,200}$/.test(branch) &&
    !branch.startsWith("-") &&
    !branch.includes("..") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock");
  const seen = new Set();
  const envFiles = [];
  for (const entry of Array.isArray(raw.envFiles) ? raw.envFiles : []) {
    const rawPath = pathOf(entry);
    const path =
      typeof rawPath === "string" && !leaks(rawPath)
        ? insideRoot(root, rawPath)
        : null;
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    const file = captured.get(path);
    const variables =
      file !== undefined
        ? file.kind === "env"
          ? dotenvNames(file.content.toString("utf8"))
          : []
        : isDotenvPath(path)
          ? dotenvNames(readFileSync(resolve(root, path), "utf8"))
          : [];
    envFiles.push({ path, variables });
  }
  const extraFiles = [];
  for (const entry of Array.isArray(raw.extraFiles) ? raw.extraFiles : []) {
    const rawPath = pathOf(entry);
    const reason = oneLine(entry?.reason, 200);
    if (typeof rawPath !== "string" || leaks(rawPath) || leaks(reason))
      continue;
    const path = insideRoot(root, rawPath);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    extraFiles.push({ path, reason });
  }
  const lines = (list, max, count) =>
    (Array.isArray(list) ? list : [])
      .filter((item) => typeof item === "string")
      .filter((item) => !/[\0\r\n]/.test(item.trim()))
      .map((item) => oneLine(item, max))
      .filter((item) => item !== "" && !leaks(item))
      .slice(0, count);
  return {
    projectName:
      fixedName ??
      (name !== "" &&
      name.length <= 100 &&
      !/[\0-\x1f]/.test(String(raw.projectName)) &&
      !leaks(name)
        ? name
        : defaultName),
    branch: branchOk && !leaks(branch) ? branch : defaultBranch,
    envFiles,
    extraFiles,
    setupCommands: lines(raw.setupCommands, 300, 20),
    notes: lines(raw.notes, 300, 5),
  };
}

/** owner/repo of a GitHub remote (https or SSH), else null. */
export function githubRepoOf(remote) {
  const match =
    /^(?:(?:https?:\/\/)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      (remote ?? "").trim(),
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The plan's GitHub line from `rose github status` and whether a local credential exists. */
export function githubPlanStatus(status, canImport) {
  const login = status?.githubAccount?.login ?? null;
  if (!status?.origin) return { status: "no_remote", login, canImport };
  const byAccess = {
    user_credential: "reachable_user",
    rose: "reachable_rose",
    not_github: "not_github",
  };
  return { status: byAccess[status.access] ?? "unreachable", login, canImport };
}

/** A local GitHub credential exists (read and discarded; never printed). */
export function canImportGithubCredential(env = process.env) {
  return readLocalGithubCredential(env) !== null;
}

/**
 * Ask `agent` for the plan: one retry on an unparsable answer, then an error;
 * a timeout is an error at once. Emits progress events through `emit`.
 */
export async function scanWithAgent({
  agent,
  dir,
  capture,
  summary,
  names,
  env,
  emit,
}) {
  const meta = IMPORT_AGENTS.find((entry) => entry.id === agent);
  if (meta === undefined)
    throw new Error(`Unknown agent ${agent}: use codex or claude`);
  const detected = detectAgents(env).agents.find((entry) => entry.id === agent);
  if (!detected?.signedIn || detected.binary === null) {
    throw new Error(
      `${meta.label} is not installed or not signed in on this computer.`,
    );
  }
  const timeoutMs =
    Number(env.ROSE_IMPORT_AGENT_TIMEOUT_MS) || DEFAULT_AGENT_TIMEOUT_MS;
  const prompt = buildScanPrompt({ facts: scanFacts(summary), ...names });
  for (let attempt = 0; attempt < 2; attempt++) {
    emit({
      event: "progress",
      stage: "scan",
      message:
        attempt === 0
          ? `Asking ${meta.label} to plan the import (read-only)...`
          : `${meta.label}'s answer was not a valid plan; asking once more.`,
    });
    let raw;
    try {
      raw = await askAgent(
        agent,
        detected.binary,
        capture.root,
        prompt,
        env,
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof AgentTimeoutError) {
        throw new Error(
          `${meta.label} timed out after ${Math.round(timeoutMs / 1000)} seconds without a plan.`,
        );
      }
      throw new Error(`${meta.label} could not be started.`);
    }
    const plan = clampPlan(raw, { root: capture.root, capture, ...names });
    if (plan !== null) return plan;
  }
  throw new Error(
    `${meta.label} could not produce a valid import plan (asked twice). Try again, or choose the other agent.`,
  );
}

/** An import plan from `--plan <file|->`: the plan, or a plan event carrying it. */
export function readPlanInput(
  source,
  readStdin = () => readFileSync(0, "utf8"),
) {
  const text = source === "-" ? readStdin() : readFileSync(source, "utf8");
  const parsed = parsePlanText(
    text.trim().split("\n").filter(Boolean).at(-1) ?? text,
  );
  const plan = parsed?.event === "plan" ? parsed.plan : parsed;
  if (plan === null || typeof plan !== "object") {
    throw new Error(
      `Could not read an import plan from ${source === "-" ? "stdin" : source}.`,
    );
  }
  return plan;
}

/** The upload landed: a synced revision and every env file with content. */
export async function verifyUpload(call, projectId) {
  const [project, files] = await Promise.all([
    call("GET", `/api/projects/${projectId}`),
    call("GET", `/api/projects/${projectId}/env-files`),
  ]);
  const missing = files.envFiles
    .filter((file) => !file.hasContent)
    .map((file) => file.path);
  if (!(project.sync?.revision > 0))
    throw new Error("The upload did not reach Rose: no synced revision.");
  if (missing.length > 0) {
    throw new Error(
      `The upload did not finish: these files have no content in Rose: ${missing.join(", ")}.`,
    );
  }
  return { id: project.id, name: project.name };
}
