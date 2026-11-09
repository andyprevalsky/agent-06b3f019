/**
 * rose-sync: sync a local checkout into a Rose Project (C9 codebase sync).
 *
 *   rose-sync status   [--dir D] [--include P]... [--json]
 *   rose-sync push     [--dir D] [--project NAME|ID] [--include P]... [--setup CMD]...
 *                      [--no-prune] [--files-only] [--json]
 *   rose-sync onboard  [--dir D] [--project NAME|ID]  import keys and configure setup
 *   rose-sync seed-rose [--dir D] [--json]     create/refresh the "Rose" project
 *                                              (startup script + six env files), then push
 *   rose-sync agent-init --login-code CODE     sign in with a one-time code from Rose and
 *                                              print the coding agent's setup steps
 *   rose-sync agent-init [status] [--json]     the steps again / current stage + next action
 *
 * Published as the `rose` bin (package.json, bin/rose.mjs); scripts/rose-sync
 * is the in-repo entry point.
 *
 * Auth (first match):
 *   ROSE_TOKEN=<user JWT>
 *   ROSE_API_KEY=<personal API key> (shared backend keys also need ROSE_USER_ID)
 *   the credential saved by `agent-init --login-code` (agent-init.mjs)
 * Backend: --api URL, ROSE_API_URL, the saved login's API, else
 * https://navi-j9a9.onrender.com.
 *
 * Everything secret is encrypted HERE with the backend's public key
 * (GET /api/projects/sync-key) before upload; unchanged files are skipped by
 * salted fingerprint. Output lists paths and variable NAMES only.
 */
import {
  constants,
  createCipheriv,
  createHmac,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  agentGuide,
  assertLoginLocation,
  exchangeLoginCode,
  humanStatus,
  loadLogin,
  saveLogin,
  setupStatus,
} from "./agent-init.mjs";
import { captureCheckout, checkoutRoot, dotenvNames } from "./capture.mjs";
import {
  configureOnboarding,
  isRoseRepository,
  requireCapturedFiles,
  sameRepository,
  verifyOnboarding,
} from "./onboarding.mjs";

const DEFAULT_API = "https://navi-j9a9.onrender.com";
export const ROSE_PROJECT_ENV_FILES = [
  "agents/.env",
  "back-end/.env",
  "agents/.env.benchmark-temporal",
  "front-end/.env",
  "mac-app/.env",
  "research/.env",
];
export const ROSE_SYNC_SCRIPT_PATH =
  "agents/benchmarks/fixtures/projects/rose-sync.sh";
export const ROSE_STARTUP_SCRIPT_PATH =
  "agents/benchmarks/fixtures/projects/rose-startup.sh";

export function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const opts = {
    command,
    include: [],
    setup: [],
    prune: true,
    filesOnly: false,
    json: false,
  };
  if (
    command === "agent-init" &&
    rest[0] !== undefined &&
    !rest[0].startsWith("-")
  )
    opts.subcommand = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--dir") opts.dir = next();
    else if (arg === "--project") opts.project = next();
    else if (arg === "--include") opts.include.push(next());
    else if (arg === "--setup") opts.setup.push(next());
    else if (arg === "--api") opts.api = next();
    else if (arg === "--login-code") opts.loginCode = next();
    else if (arg === "--no-prune") opts.prune = false;
    else if (arg === "--files-only") opts.filesOnly = true;
    else if (arg === "--json") opts.json = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  // Only `push` honors --files-only; seed-rose/onboard/status would otherwise
  // discover and upload dotenv files, a git bundle and a patch despite it.
  if (opts.filesOnly && command !== "push")
    throw new Error(`--files-only is only supported by push, not ${command}`);
  return opts;
}

/** Same envelope as back-end/src/providers/credentialEnvelope.ts. */
export function encryptEnvelope(plaintext, publicKeyPem) {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const ciphertext = Buffer.concat([encrypted, cipher.getAuthTag()]);
  const encryptedAesKey = publicEncrypt(
    {
      key: publicKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey,
  );
  const envelope = {
    version: 1,
    encrypted_aes_key: encryptedAesKey.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

export function fingerprint(salt, content) {
  return createHmac("sha256", salt).update(content).digest("hex");
}

function trimBase(url) {
  return url.replace(/\/+$/, "");
}

export function apiBase(opts, login = loadLogin()) {
  return trimBase(
    opts.api ?? process.env.ROSE_API_URL ?? login?.apiUrl ?? DEFAULT_API,
  );
}

function apiClient(opts, login = loadLogin()) {
  const base = apiBase(opts, login);
  const headers = { "Content-Type": "application/json" };
  if (process.env.ROSE_TOKEN)
    headers.Authorization = `Bearer ${process.env.ROSE_TOKEN}`;
  else if (process.env.ROSE_API_KEY) {
    headers["X-API-Key"] = process.env.ROSE_API_KEY;
    if (process.env.ROSE_USER_ID)
      headers["X-User-Id"] = process.env.ROSE_USER_ID;
  } else if (login && trimBase(login.apiUrl) === base) {
    // Never send the saved credential to a different backend than issued it.
    headers.Authorization = `Bearer ${login.credential}`;
  } else {
    throw new Error(
      "Not signed in to Rose. Copy the setup prompt from Rose (project settings → " +
        "Set up with your coding agent), or set ROSE_TOKEN / your personal ROSE_API_KEY " +
        "(shared backend keys also require ROSE_USER_ID)",
    );
  }
  const call = async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    if (!res.ok) {
      const err = new Error(
        `${method} ${path} -> ${res.status}: ${data?.error ?? text.slice(0, 300)}`,
      );
      err.status = res.status;
      err.code = data?.code;
      throw err;
    }
    return data;
  };
  call.login = headers.Authorization?.startsWith("Bearer rose_cli_")
    ? login
    : null;
  return call;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveProject(call, opts, root) {
  // A login minted from one project's settings targets that project by default.
  const name = opts.project ?? call.login?.project?.id ?? basename(root);
  if (UUID_RE.test(name)) return call("GET", `/api/projects/${name}`);
  return call("PUT", "/api/projects", { name });
}

/**
 * A files-only push omits the git artifacts, so the server keeps the stored
 * bundle and patch, but its manifest replaces the previous one. Carry the stored
 * git fields those artifacts depend on (the patch's base headSha and branch, the
 * bundle's kind and branches, unpushed/dirty counts) over from the stored
 * snapshot; otherwise a moved HEAD orphans the patch and a null bundleKind stops
 * restoration from cloning the retained full bundle of a repository with no remote.
 */
export function retainArtifactGit(manifest, state) {
  const previous = state.manifest?.git;
  const retained =
    state.gitBundleFingerprint != null || state.patchFingerprint != null;
  if (!previous || !retained) return manifest;
  return {
    ...manifest,
    git: { ...previous, remoteUrl: manifest.git.remoteUrl },
  };
}

export function buildPush(capture, state, key, prune) {
  const stored = new Map(
    (state.files ?? []).map((f) => [f.path, f.fingerprint]),
  );
  const files = capture.files.map((file) => {
    const fp = fingerprint(state.salt, file.content);
    const unchanged = stored.get(file.path) === fp;
    return {
      path: file.path,
      kind: file.kind,
      fingerprint: fp,
      sizeBytes: file.content.length,
      variables:
        file.kind === "env" ? dotenvNames(file.content.toString("utf8")) : [],
      linkTarget: file.linkTarget,
      ...(unchanged
        ? {}
        : {
            encryptedContent: encryptEnvelope(
              file.content.toString("utf8"),
              key.publicKeyPem,
            ),
          }),
    };
  });
  const artifact = (bytes, storedFp) => {
    if (!bytes) return null;
    const fp = fingerprint(state.salt, bytes);
    return fp === storedFp
      ? { fingerprint: fp }
      : {
          fingerprint: fp,
          encrypted: encryptEnvelope(
            bytes.toString("base64"),
            key.publicKeyPem,
          ),
        };
  };
  return {
    baseRevision: state.revision,
    keyId: key.keyId,
    manifest: capture.filesOnly
      ? retainArtifactGit(capture.manifest, state)
      : capture.manifest,
    files,
    prune,
    // Omitted (not null) artifacts keep what the project already stores.
    ...(capture.filesOnly
      ? {}
      : {
          gitBundle: artifact(capture.gitBundle, state.gitBundleFingerprint),
          uncommittedPatch: artifact(
            capture.uncommittedPatch,
            state.patchFingerprint,
          ),
        }),
  };
}

/** Push one capture; retries once on a concurrent-revision or stale-fingerprint conflict. */
export async function pushCapture(call, projectId, capture, prune = true) {
  for (let attempt = 0; ; attempt++) {
    const [key, state] = await Promise.all([
      call("GET", "/api/projects/sync-key"),
      call("GET", `/api/projects/${projectId}/sync`),
    ]);
    try {
      return await call(
        "POST",
        `/api/projects/${projectId}/sync`,
        buildPush(capture, state, key, prune),
      );
    } catch (err) {
      const retryable =
        err.status === 409 &&
        ["revision_conflict", "stale_fingerprint", "key_rotated"].includes(
          err.code,
        );
      if (!retryable || attempt >= 1) throw err;
    }
  }
}

function summarize(capture) {
  return {
    root: capture.root,
    git: {
      remote: capture.manifest.git.remoteUrl,
      branch: capture.manifest.git.branch,
      head: capture.manifest.git.headSha,
      unpushedCommits: capture.manifest.git.unpushedCommits,
      bundle: capture.gitBundle
        ? `${capture.manifest.git.bundleKind} (${capture.gitBundle.length} bytes)`
        : null,
      uncommittedPatchBytes: capture.uncommittedPatch?.length ?? 0,
      dirtyPaths: capture.manifest.git.dirtyPaths.length,
    },
    files: capture.files.map((f) => ({
      path: f.path,
      kind: f.kind,
      bytes: f.content.length,
      linked: f.linkTarget !== null,
      variables:
        f.kind === "env" ? dotenvNames(f.content.toString("utf8")) : [],
    })),
    symlinks: capture.manifest.symlinks.map((l) => ({
      path: l.path,
      kind: l.kind,
    })),
    toolchain: {
      node: capture.manifest.toolchain.node,
      python: capture.manifest.toolchain.python,
    },
    setup: capture.manifest.setup,
    warnings: capture.manifest.warnings,
  };
}

function print(opts, value, human) {
  if (opts.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${human}\n`);
}

function humanSummary(summary) {
  const lines = [
    `checkout ${summary.root} (${summary.git.branch ?? "detached"} @ ${String(summary.git.head).slice(0, 12)})`,
  ];
  for (const f of summary.files) {
    lines.push(
      `  ${f.kind.padEnd(6)} ${f.path}${f.linked ? " (symlink)" : ""}  ${f.variables.length} vars`,
    );
  }
  if (summary.git.bundle) lines.push(`  local commits: ${summary.git.bundle}`);
  if (summary.git.uncommittedPatchBytes)
    lines.push(`  uncommitted: ${summary.git.uncommittedPatchBytes} bytes`);
  for (const w of summary.warnings) lines.push(`  warning: ${w}`);
  return lines.join("\n");
}

async function seedRose(call, opts, root) {
  const startupScript = readFileSync(
    join(root, ROSE_STARTUP_SCRIPT_PATH),
    "utf8",
  );
  const syncScript = readFileSync(join(root, ROSE_SYNC_SCRIPT_PATH), "utf8");
  const capture = captureCheckout(root, {
    include: ROSE_PROJECT_ENV_FILES,
    client: "rose-sync seed-rose",
  });
  const project = await call("PUT", "/api/projects", {
    name: "Rose",
    ...(capture.manifest.git.remoteUrl
      ? { repoUrl: capture.manifest.git.remoteUrl }
      : {}),
    defaultBranch: "main",
    startupScript,
    // = ROSE_PROJECT_STARTUP_TIMEOUT_S (back-end/src/domains/projects/roseProject.ts)
    startupTimeoutS: 900,
    maintenance: { script: syncScript, timeoutS: 480 },
  });
  const existing = await call("GET", `/api/projects/${project.id}/env-files`);
  const have = new Set(existing.envFiles.map((f) => f.path));
  for (const path of ROSE_PROJECT_ENV_FILES) {
    if (!have.has(path))
      await call("POST", `/api/projects/${project.id}/env-files`, {
        path,
        declared: true,
      });
  }
  return { project, capture };
}

async function agentInit(opts, dir, cli) {
  const captureFor = () => {
    try {
      return captureCheckout(dir, { include: opts.include, setup: opts.setup });
    } catch {
      return null;
    }
  };
  if (opts.loginCode !== undefined) {
    const capture = captureFor();
    assertLoginLocation({ checkout: capture?.root ?? dir });
    const base = apiBase(opts, null);
    const exchanged = await exchangeLoginCode(base, opts.loginCode);
    const login = {
      apiUrl: base,
      credential: exchanged.credential,
      expiresAt: exchanged.expiresAt,
      userId: exchanged.userId,
      project: exchanged.project,
      scope: exchanged.scope,
      savedAt: new Date().toISOString(),
    };
    const path = saveLogin(login, { checkout: capture?.root ?? dir });
    const guide = agentGuide({ login, capture, cli, path });
    print(
      opts,
      {
        signedIn: true,
        credentialPath: path,
        expiresAt: login.expiresAt,
        project: login.project,
        instructions: guide,
      },
      guide,
    );
    return 0;
  }
  const login = loadLogin();
  const capture = captureFor();
  if (opts.subcommand === "status") {
    const status = await setupStatus({
      call: login ? apiClient(opts, login) : null,
      login,
      capture,
      projectName: opts.project ?? (capture ? basename(capture.root) : null),
      cli,
    });
    print(opts, status, humanStatus(status));
    return 0;
  }
  if (opts.subcommand !== undefined && opts.subcommand !== "guide")
    throw new Error(`Unknown agent-init command ${opts.subcommand}`);
  if (!login) {
    throw new Error(
      "Not signed in to Rose. Ask the user to copy the setup prompt from Rose " +
        "(project settings → Set up with your coding agent); it runs " +
        `${cli} agent-init --login-code <code>.`,
    );
  }
  const guide = agentGuide({ login, capture, cli });
  print(
    opts,
    { signedIn: true, project: login.project, instructions: guide },
    guide,
  );
  return 0;
}

export async function main(argv, { cli = "rose-sync" } = {}) {
  const opts = parseArgs(argv);
  const dir = opts.dir ?? process.cwd();
  if (opts.command === "agent-init") return agentInit(opts, dir, cli);
  if (opts.command === "status") {
    const capture = captureCheckout(dir, {
      include: opts.include,
      setup: opts.setup,
    });
    const summary = summarize(capture);
    print(opts, summary, humanSummary(summary));
    return 0;
  }
  if (["push", "seed-rose", "onboard"].includes(opts.command)) {
    const call = apiClient(opts);
    let project;
    let capture;
    if (opts.command === "seed-rose") {
      ({ project, capture } = await seedRose(call, opts, checkoutRoot(dir)));
    } else {
      capture = captureCheckout(dir, {
        include:
          opts.filesOnly && opts.include.length === 0
            ? ROSE_PROJECT_ENV_FILES
            : opts.include,
        setup: opts.setup,
        filesOnly: opts.filesOnly,
      });
      if (opts.command === "onboard") {
        if (isRoseRepository(capture.manifest.git.remoteUrl)) {
          capture = captureCheckout(dir, {
            include: [...opts.include, ...ROSE_PROJECT_ENV_FILES],
            setup: opts.setup,
          });
          requireCapturedFiles(capture, ROSE_PROJECT_ENV_FILES);
        }
        configureOnboarding(capture);
      }
      project = await resolveProject(call, opts, capture.root);
    }
    if (opts.command === "onboard") {
      if (!sameRepository(capture.manifest.git.remoteUrl, project.repoUrl))
        throw new Error(
          "The working checkout does not match this project's repository",
        );
      const declared = await call(
        "GET",
        `/api/projects/${project.id}/env-files`,
      );
      requireCapturedFiles(
        capture,
        declared.envFiles
          .filter((file) => !file.hasContent)
          .map((file) => file.path),
      );
      if (
        !project.startupScript &&
        isRoseRepository(capture.manifest.git.remoteUrl)
      ) {
        project = await call("PUT", `/api/projects/${project.id}`, {
          startupScript: readFileSync(
            join(capture.root, ROSE_STARTUP_SCRIPT_PATH),
            "utf8",
          ),
        });
      }
    }
    // --files-only never prunes: it must not delete files it did not capture.
    const result = await pushCapture(
      call,
      project.id,
      capture,
      opts.prune && !opts.filesOnly,
    );
    const onboarding =
      opts.command === "onboard"
        ? await verifyOnboarding(call, project.id, capture)
        : undefined;
    const summary = summarize(capture);
    print(
      opts,
      {
        projectId: project.id,
        ...result,
        capture: summary,
        ...(onboarding ? { onboarding } : {}),
      },
      `${humanSummary(summary)}\nsynced to project ${result.project.name} (${project.id}) revision ${result.revision}: ` +
        `${result.written.length} written, ${result.unchanged.length} unchanged, ${result.deleted.length} removed` +
        (onboarding
          ? `\nDevelopment environment configured. ${onboarding.verification}`
          : ""),
    );
    return 0;
  }
  process.stdout.write(
    `usage: ${cli} status|push|onboard|seed-rose [--dir D] [--project NAME|ID] [--include PATH]... ` +
      "[--setup CMD]... [--no-prune] [--files-only] [--api URL] [--json]\n" +
      `       ${cli} agent-init --login-code CODE | agent-init [status] [--json]\n`,
  );
  return opts.command === "help" ? 0 : 2;
}
