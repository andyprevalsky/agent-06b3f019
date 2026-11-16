/**
 * `rose github status|import`: give Rose's code agents the user's own GitHub
 * access for this checkout (back-end providers/githubUserCredentials.ts).
 *
 *   rose github status   can Rose reach this checkout's GitHub origin, and how
 *                        (GET /api/projects/github-credential?repo=<origin>)
 *   rose github import   after the user approves: read this computer's GitHub
 *                        credential (`gh auth token`, else `git credential fill`
 *                        for github.com), encrypt it with the project sync key and
 *                        upload it (PUT /api/projects/github-credential)
 *
 * The token stays in memory, is sent only as an envelope, and is never printed.
 * Rose uses it only for its owner's own code sessions, never a teammate's.
 */
import { execFileSync } from "node:child_process";
import { checkoutRoot, sanitizeRemote } from "./capture.mjs";

const READ_TIMEOUT_MS = 15_000;

function tryRead(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: READ_TIMEOUT_MS,
      stdio: [
        options.input === undefined ? "ignore" : "pipe",
        "pipe",
        "ignore",
      ],
      ...options,
    });
  } catch {
    return null;
  }
}

/** This computer's GitHub credential for github.com, or null. Never logged. */
export function readLocalGithubCredential(env = process.env) {
  const fromGh = tryRead("gh", ["auth", "token", "--hostname", "github.com"], {
    env,
  })?.trim();
  if (fromGh) return { token: fromGh, source: "gh" };
  const filled = tryRead("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
    },
  });
  const password = (filled ?? "")
    .split("\n")
    .find((line) => line.startsWith("password="))
    ?.slice("password=".length)
    .trim();
  return password ? { token: password, source: "git-credential" } : null;
}

/** The checkout's origin (credentials stripped), or null. */
function checkoutOrigin(dir) {
  const root = checkoutRoot(dir);
  const origin = tryRead("git", [
    "-C",
    root,
    "remote",
    "get-url",
    "origin",
  ])?.trim();
  return origin ? sanitizeRemote(origin) : null;
}

function repoName(repo) {
  return (
    repo?.canonicalRef?.replace(/^gh:/, "") ??
    repo?.repoUrl ??
    "this repository"
  );
}

export async function githubStatus(call, dir) {
  const origin = checkoutOrigin(dir);
  const query = origin ? `?repo=${encodeURIComponent(origin)}` : "";
  const status = await call("GET", `/api/projects/github-credential${query}`);
  return {
    origin,
    access: origin ? (status.repo?.access ?? "none") : "not_github",
    repo: status.repo ?? null,
    githubAccount: {
      connected: status.connected,
      login: status.login,
      scopes: status.scopes,
    },
  };
}

export function humanGithubStatus(status, cli) {
  const name = repoName(status.repo);
  const account = status.githubAccount;
  switch (status.access) {
    case "user_credential":
      return (
        `Rose can reach ${name} with your GitHub account ${account.login}: code agents ` +
        "clone, push and use gh as you."
      );
    case "rose":
      return (
        `Rose can reach ${name} with its own access.` +
        (account.connected
          ? ` Your GitHub account ${account.login} is connected but cannot push it.`
          : " Your GitHub account is not connected, so code agents push as Rose.")
      );
    case "rate_limited":
      return `GitHub is rate limiting Rose right now; run \`${cli} github status\` again shortly.`;
    case "not_github":
      return status.origin
        ? "This checkout's origin is not on GitHub, so Rose's GitHub access does not apply: " +
            "code agents clone it as configured."
        : `This checkout has no git remote: Rose restores it from what \`${cli} push\` uploads.`;
    default:
      return (
        `Rose cannot reach ${name}: ${status.repo?.reason ?? "no access"}\n` +
        `With the user's approval, run \`${cli} github import\` to upload this computer's ` +
        "GitHub credential (encrypted; it is never printed) so Rose's code agents can clone " +
        "and push it as them."
      );
  }
}

export async function githubImport(
  call,
  encryptEnvelope,
  cli,
  credential = readLocalGithubCredential(),
) {
  if (credential === null) {
    throw new Error(
      "No GitHub credential found on this computer: `gh auth token` and `git credential " +
        "fill` returned none for github.com. Sign in with `gh auth login` (or set up a git " +
        `credential helper for github.com), then run \`${cli} github import\` again.`,
    );
  }
  const key = await call("GET", "/api/projects/sync-key");
  const saved = await call("PUT", "/api/projects/github-credential", {
    keyId: key.keyId,
    encryptedToken: encryptEnvelope(credential.token, key.publicKeyPem),
  });
  return { ...saved, source: credential.source };
}

export function humanGithubImport(result) {
  const from = result.source === "gh" ? "gh auth token" : "git credential fill";
  const scopes = result.scopes?.length
    ? result.scopes.join(", ")
    : "none listed";
  return (
    `Uploaded the GitHub credential for ${result.login} (from ${from}; scopes: ${scopes}). ` +
    "Rose uses it only for your own code sessions, never a teammate's."
  );
}
