/**
 * `rose agent-init`: set up a local checkout on Rose with your coding agent
 * (boxes.dev `dvb agent-init --login-code` parity, for Rose Projects).
 *
 *   rose agent-init --login-code <code>   exchange the one-time code from Rose
 *                                         (Integrations › GitHub Repositories ›
 *                                         Import from your computer), save the
 *                                         credential,
 *                                         print the agent's instructions
 *   rose agent-init                       print the instructions again
 *   rose agent-init status [--json]       current stage and next action
 *
 * The credential lives outside the repository in
 * $ROSE_CONFIG_DIR | $XDG_CONFIG_HOME/rose | ~/.config/rose, file mode 0600.
 * It is accepted only by /api/projects (only the bound project when the code
 * was minted from a project's settings). Output never contains a secret value.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export const LOGIN_CODE_PATTERN = /^rlc_[A-Za-z0-9_-]{32}$/;

export function configDir(env = process.env) {
  if (env.ROSE_CONFIG_DIR) return resolve(env.ROSE_CONFIG_DIR);
  const base = env.XDG_CONFIG_HOME
    ? resolve(env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  return join(base, "rose");
}

export function credentialsPath(env = process.env) {
  return join(configDir(env), "credentials.json");
}

function realish(path) {
  // The file may not exist yet: resolve the deepest existing ancestor.
  let current = resolve(path);
  const rest = [];
  while (!existsSync(current)) {
    rest.unshift(basename(current));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(realpathSync(current), ...rest);
}

function isInside(child, parent) {
  const rel = relative(realish(parent), realish(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Validate custody before consuming a one-time login code or writing it. */
export function assertLoginLocation({ env = process.env, checkout } = {}) {
  const path = credentialsPath(env);
  if (checkout && isInside(path, checkout)) {
    throw new Error(
      `Refusing to store the Rose credential inside the repository (${path}). ` +
        "Set ROSE_CONFIG_DIR to a directory outside it.",
    );
  }
  return path;
}

/** Write the credential 0600 (directory 0700), never inside the checkout. */
export function saveLogin(record, options = {}) {
  const path = assertLoginLocation(options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}

/** The saved login, or null when absent or expired. */
export function loadLogin(env = process.env, now = Date.now()) {
  const path = credentialsPath(env);
  if (!existsSync(path)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof record?.credential !== "string" || record.credential.trim() === "")
    return null;
  if (typeof record.apiUrl !== "string" || record.apiUrl.trim() === "")
    return null;
  const expiresAt =
    typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return record;
}

/** POST the one-time code; the response carries the projects-scoped credential. */
export async function exchangeLoginCode(apiBase, code) {
  if (!LOGIN_CODE_PATTERN.test(code)) {
    throw new Error(
      "That is not a Rose login code. Start the import again from Rose " +
        "(Integrations › GitHub Repositories › Import from your computer, in the Rose Mac app).",
    );
  }
  const res = await fetch(`${apiBase}/api/projects/cli-login-codes/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const reason =
      res.status === 429
        ? "too many login attempts; wait a few minutes"
        : (data?.error ?? `HTTP ${res.status}`);
    throw new Error(
      `Rose login failed: ${reason}. Ask the user to start the import again from Rose ` +
        "(Integrations › GitHub Repositories › Import from your computer, in the Rose Mac app).",
    );
  }
  if (
    typeof data?.credential !== "string" ||
    data.credential.trim() === "" ||
    typeof data?.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(data.expiresAt))
  ) {
    throw new Error(
      "Rose login failed: the backend returned an unexpected response. Ask the user to start the import again from Rose (Integrations › GitHub Repositories › Import from your computer, in the Rose Mac app).",
    );
  }
  return data;
}

function projectLine(login) {
  return login.project
    ? `This login can set up the Rose project "${login.project.name}" only.`
    : "This login can set up any of your Rose projects.";
}

function shellWord(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function suggestedName(capture) {
  return capture?.root
    ? shellWord(basename(capture.root))
    : JSON.stringify("<name>");
}

function projectFlag(login, capture) {
  return `--project ${login.project ? shellWord(login.project.id) : suggestedName(capture)}`;
}

/** Where the user sees an imported project in Rose. */
export const ROSE_PROJECTS_LOCATION = "Integrations › GitHub Repositories";

/**
 * The step-by-step instructions the coding agent follows (printed after
 * login), modelled on boxes.dev's agent-driven setup: detect, plan with the
 * user, GitHub access, approval, upload, verify, tell the user where it is.
 * Only what Rose supports; the rest is named as not supported.
 */
export function agentGuide({ login, capture, cli = "rose", path }) {
  cli = shellWord(cli);
  const flag = projectFlag(login, capture);
  const remote = capture?.manifest?.git?.remoteUrl ?? "no git remote";
  const name = login.project
    ? [
        `   - Project: this login is for the Rose project "${login.project.name}". Confirm`,
        `     with the user that this checkout (${remote}) is that project's code.`,
      ]
    : [
        `   - Project name: propose ${suggestedName(capture)} (the folder name) or an existing`,
        "     project the user names; the upload creates it when it does not exist yet.",
      ];
  return [
    `Signed in to Rose${path ? ` (credential saved to ${path}, mode 0600)` : ""}.`,
    projectLine(login),
    "",
    "You are the user's coding agent. Set up this checkout on Rose with these steps.",
    "Run every command yourself. Stop and ask the user wherever a step says APPROVAL.",
    "Never print, open or paste the contents of .env or other secret files.",
    "",
    "1. Detect the repository.",
    `   Run: ${cli} status --json`,
    "   It reports the checkout root, its remote and the remote's default branch, local",
    "   commits, uncommitted work, every env/config file with its variable NAMES (never",
    "   values) and setup suggestions from lockfiles. One Rose project is one",
    "   repository: if this folder holds several unrelated repositories, ask the user",
    "   which one to set up and add --dir <path> to every command.",
    "",
    "2. Plan the setup with the user.",
    "   Present one plan and let the user change it:",
    ...name,
    "   - Starting branch: the remote's default branch from step 1, as",
    "     --branch <remote default branch>; ask the user when step 1 could not tell.",
    "   - Env & secret files: each path with its variable names only. Ask whether a",
    "     secret file inside the repository is missing (add it with --include <path>)",
    "     and whether a listed file should stay off Rose.",
    "   - Extra files: small untracked config files inside the repository that the app",
    "     needs (--include <path>). Local commits and uncommitted work upload too.",
    '   - Setup commands: from step 1\'s "setup.suggested" and the README, the commands',
    '     a fresh workspace needs (installs, code generation): --setup "<command>".',
    "   Say plainly that Rose does not import local database dumps, files outside the",
    "   repository (home directory dotfiles, shell config) or coding-agent",
    "   conversation history.",
    "",
    "3. Check GitHub access.",
    `   Run: ${cli} github status`,
    "   If Rose can reach the repository, say so. If it cannot, explain that Rose's code",
    "   agents need the user's GitHub access to clone and push it, as the user.",
    "   APPROVAL: ask whether to upload this computer's GitHub credential, then run:",
    `   ${cli} github import`,
    "   It reads `gh auth token` (or git's credential helper), encrypts it here and",
    "   never prints it; Rose uses it only for the user's own sessions. If the user",
    "   declines, say Rose's agents cannot clone a private repository until they do.",
    "",
    "4. APPROVAL: ask before uploading.",
    "   Show the user the final plan: the project name, the starting branch, exactly",
    "   which files will be uploaded (encrypted on this computer with Rose's public",
    "   key before upload) and the setup commands every new workspace will run.",
    "   Wait for an explicit yes. Do not upload without it.",
    "",
    "5. Upload.",
    `   Run: ${cli} push ${flag} [--branch <branch>] [--include <path>]... [--setup "<command>"]...`,
    "   It encrypts and uploads the env files, local commits and uncommitted work.",
    "",
    "6. Verify.",
    `   Run: ${cli} agent-init status ${flag}`,
    "   Every env file must show as uploaded and the project must show a synced",
    "   revision. Fix anything it lists, with the user's approval.",
    "",
    "7. Tell the user where to find it.",
    `   The project is in Rose under ${ROSE_PROJECTS_LOCATION}; Rose's agents can start`,
    "   code sessions in it. Summarize what was uploaded by path and variable names only.",
    "",
    `Run "${cli} agent-init status" at any time for the current stage and next action.`,
  ].join("\n");
}

/** Remote state for `agent-init status`: which stage the setup is in and what to do next. */
export async function setupStatus({ call, login, capture, projectName, cli }) {
  cli = shellWord(cli);
  const checkout = capture
    ? {
        root: capture.root,
        remote: capture.manifest.git.remoteUrl,
        branch: capture.manifest.git.branch,
        envFiles: capture.files.map((f) => f.path),
      }
    : null;
  if (!login) {
    return {
      stage: "signed_out",
      checkout,
      next: "Ask the user to start the import again from Rose (Integrations › GitHub Repositories › Import from your computer, in the Rose Mac app).",
    };
  }
  const { projects } = await call("GET", "/api/projects");
  const wanted = login.project?.id ?? null;
  const project = wanted
    ? projects.find((p) => p.id === wanted)
    : projects.find((p) => p.id === projectName || p.name === projectName);
  if (!project) {
    return {
      stage: "project_missing",
      login: { project: login.project, expiresAt: login.expiresAt },
      checkout,
      next: wanted
        ? "The bound project no longer exists; ask the user to start the import again from Rose (Integrations › GitHub Repositories › Import from your computer, in the Rose Mac app)."
        : `Confirm the project name with the user, then (after approval) run: ${cli} push --project ${shellWord(projectName)}`,
    };
  }
  const { envFiles } = await call(
    "GET",
    `/api/projects/${project.id}/env-files`,
  );
  const missing = envFiles.filter((f) => !f.hasContent).map((f) => f.path);
  const synced = project.sync?.revision > 0;
  const stage = !synced
    ? "awaiting_upload"
    : missing.length > 0
      ? "env_incomplete"
      : "synced";
  const github = await githubAccess(call, checkout?.remote ?? null);
  const next =
    stage === "synced"
      ? github?.access === "none"
        ? `Uploaded, but Rose cannot reach the GitHub repository: after the user approves, run ${cli} github import.`
        : `Setup is complete. Tell the user the project is in Rose under ${ROSE_PROJECTS_LOCATION}.`
      : stage === "env_incomplete"
        ? `Upload the missing files after the user approves: ${missing.join(", ")}`
        : `List the env files for the user, get approval, then run: ${cli} push --project ${shellWord(project.id)}`;
  return {
    stage,
    login: { project: login.project, expiresAt: login.expiresAt },
    checkout,
    project: {
      id: project.id,
      name: project.name,
      revision: project.sync?.revision ?? 0,
      lastSyncedAt: project.sync?.lastSyncedAt ?? null,
      envFiles: envFiles.map((f) => ({
        path: f.path,
        uploaded: f.hasContent,
        variables: (f.variables ?? []).map((v) => v.name),
      })),
    },
    ...(github ? { github } : {}),
    next,
  };
}

/** Whether Rose can reach the checkout's GitHub origin (null: none, or unknown). */
async function githubAccess(call, remote) {
  if (!remote) return null;
  try {
    const status = await call(
      "GET",
      `/api/projects/github-credential?repo=${encodeURIComponent(remote)}`,
    );
    return status.repo?.access === "not_github"
      ? null
      : { access: status.repo?.access ?? "none", login: status.login ?? null };
  } catch {
    return null;
  }
}

export function humanStatus(status) {
  const lines = [`stage: ${status.stage}`];
  if (status.checkout)
    lines.push(
      `checkout: ${status.checkout.root} (${status.checkout.remote ?? "no remote"})`,
    );
  if (status.project) {
    lines.push(
      `project: ${status.project.name} (${status.project.id}) revision ${status.project.revision}`,
    );
    for (const f of status.project.envFiles)
      lines.push(
        `  ${f.uploaded ? "uploaded" : "missing "} ${f.path}  ${f.variables.join(", ")}`,
      );
  }
  if (status.github)
    lines.push(
      `github: ${status.github.access}${status.github.login ? ` (${status.github.login})` : ""}`,
    );
  lines.push(`next: ${status.next}`);
  return lines.join("\n");
}
