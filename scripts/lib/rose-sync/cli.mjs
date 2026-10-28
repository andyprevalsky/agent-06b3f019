/**
 * rose-sync: sync a local checkout into a Rose Project (C9 codebase sync).
 *
 *   rose-sync status   [--dir D] [--include P]... [--json]
 *   rose-sync push     [--dir D] [--project NAME|ID] [--include P]... [--setup CMD]...
 *                      [--no-prune] [--json]
 *   rose-sync onboard  [--dir D] [--project NAME|ID]  import keys and configure setup
 *   rose-sync seed-rose [--dir D] [--json]     create/refresh the "Rose" project
 *                                              (startup script + six env files), then push
 *
 * Auth (one of):
 *   ROSE_TOKEN=<user JWT>
 *   ROSE_API_KEY=<personal API key> (shared backend keys also need ROSE_USER_ID)
 * Backend: --api URL or ROSE_API_URL (default https://navi-j9a9.onrender.com).
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
  const opts = { command, include: [], setup: [], prune: true, json: false };
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
    else if (arg === "--no-prune") opts.prune = false;
    else if (arg === "--json") opts.json = true;
    else throw new Error(`Unknown option ${arg}`);
  }
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

function apiClient(opts) {
  const base = (opts.api ?? process.env.ROSE_API_URL ?? DEFAULT_API).replace(
    /\/+$/,
    "",
  );
  const headers = { "Content-Type": "application/json" };
  if (process.env.ROSE_TOKEN)
    headers.Authorization = `Bearer ${process.env.ROSE_TOKEN}`;
  else if (process.env.ROSE_API_KEY) {
    headers["X-API-Key"] = process.env.ROSE_API_KEY;
    if (process.env.ROSE_USER_ID)
      headers["X-User-Id"] = process.env.ROSE_USER_ID;
  } else {
    throw new Error(
      "Set ROSE_TOKEN or your personal ROSE_API_KEY (shared backend keys also require ROSE_USER_ID)",
    );
  }
  return async function call(method, path, body) {
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
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveProject(call, opts, root) {
  const name = opts.project ?? basename(root);
  if (UUID_RE.test(name)) return call("GET", `/api/projects/${name}`);
  return call("PUT", "/api/projects", { name });
}

function buildPush(capture, state, key, prune) {
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
    manifest: capture.manifest,
    files,
    prune,
    gitBundle: artifact(capture.gitBundle, state.gitBundleFingerprint),
    uncommittedPatch: artifact(
      capture.uncommittedPatch,
      state.patchFingerprint,
    ),
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

export async function main(argv) {
  const opts = parseArgs(argv);
  const dir = opts.dir ?? process.cwd();
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
        include: opts.include,
        setup: opts.setup,
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
    const result = await pushCapture(call, project.id, capture, opts.prune);
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
    "usage: rose-sync status|push|onboard|seed-rose [--dir D] [--project NAME|ID] [--include PATH]... " +
      "[--setup CMD]... [--no-prune] [--api URL] [--json]\n",
  );
  return opts.command === "help" ? 0 : 2;
}
