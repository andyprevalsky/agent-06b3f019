/**
 * rose-sync capture: read a local checkout into an in-memory snapshot.
 *
 *   git        remote / branch / HEAD; unpushed commits → bundle
 *              (full bundle when there is no remote); uncommitted
 *              tracked + untracked changes → binary patch built in a
 *              TEMPORARY index (the user's index and files are never touched)
 *   env files  untracked or ignored dotenv files (.env, .env.*, *.env,
 *              .dev.vars, .flaskenv) + --include paths; symlinks are
 *              followed for content and their link structure is recorded
 *   links      other untracked symlinks: internal → recorded; external →
 *              captured as a config file when it points at a small file
 *   toolchain  .nvmrc / .node-version / .python-version / .tool-versions
 *   setup      suggestions from lockfiles (never run automatically)
 *
 * Secret-bearing content (env/config files, bundle, patch) stays in memory
 * here; the caller encrypts it client-side before upload. Dependency-free so
 * it runs with any Node >= 18 (CLI and Mac app).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
export const MAX_PATCH_BYTES = 10 * 1024 * 1024;
const TEMPLATE_SUFFIXES = [
  ".example",
  ".sample",
  ".template",
  ".dist",
  ".defaults",
];

/** Dotenv-style names boxes.dev also manages. */
export function isDotenvPath(path) {
  const base = path.split("/").pop() ?? path;
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".env") ||
    base === ".dev.vars" ||
    base === ".flaskenv"
  );
}

function isTemplate(path) {
  const base = path.split("/").pop() ?? path;
  return TEMPLATE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/** Variable names in a dotenv file (names only; values are never returned). */
export function dotenvNames(content) {
  const names = [];
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line);
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: opts.encoding ?? "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function tryGit(cwd, args, opts) {
  try {
    return git(cwd, args, opts);
  } catch {
    return null;
  }
}

function listZ(out) {
  return (out ?? "").split("\0").filter(Boolean);
}

function isInside(root, target) {
  return target === root || target.startsWith(root + sep);
}

/** Strip userinfo (tokens) from http(s) remotes. */
export function sanitizeRemote(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      parsed.username = "";
      parsed.password = "";
      return parsed.toString().replace(/\/$/, "");
    }
  } catch {
    // scp-style or local path
  }
  return url;
}

function dirtyPaths(root) {
  const entries = listZ(
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  );
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // rename source follows
  }
  return paths;
}

function readSmallFile(abs, warnings, label) {
  const stat = statSync(abs);
  if (!stat.isFile()) {
    warnings.push(`${label} is not a regular file; skipped`);
    return null;
  }
  if (stat.size > MAX_FILE_BYTES) {
    warnings.push(`${label} is larger than ${MAX_FILE_BYTES} bytes; skipped`);
    return null;
  }
  return readFileSync(abs);
}

function captureLinkedOrPlain(root, rel, kind, out) {
  const abs = join(root, rel);
  let lst;
  try {
    lst = lstatSync(abs);
  } catch {
    out.warnings.push(`${rel} not found; skipped`);
    return;
  }
  if (!lst.isSymbolicLink()) {
    const content = readSmallFile(abs, out.warnings, rel);
    if (content)
      out.files.set(rel, { path: rel, kind, content, linkTarget: null });
    return;
  }
  const target = readlinkSync(abs);
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    out.warnings.push(`${rel} is a dangling symlink; skipped`);
    return;
  }
  if (isInside(root, real)) {
    out.symlinks.set(rel, { path: rel, target, kind: "internal" });
    const realRel = relative(root, real).split(sep).join("/");
    if (kind === "env" && !out.files.has(realRel)) {
      const content = readSmallFile(real, out.warnings, realRel);
      if (content)
        out.files.set(realRel, {
          path: realRel,
          kind,
          content,
          linkTarget: null,
        });
    }
    return;
  }
  if (statSync(real).isDirectory()) {
    out.warnings.push(`${rel} links to an external directory; not captured`);
    return;
  }
  const content = readSmallFile(real, out.warnings, rel);
  if (!content) return;
  out.files.set(rel, { path: rel, kind, content, linkTarget: target });
  out.symlinks.set(rel, {
    path: rel,
    target,
    kind: "external",
    capturedAs: rel,
  });
}

function captureFiles(root, include, out, filesOnly = false) {
  // --files-only pushes exactly the named files: no dotenv auto-discovery and no
  // untracked-symlink sweep (a stray .env.npm or lockfile must never be uploaded).
  if (filesOnly) {
    for (const rel of new Set(include)) {
      captureLinkedOrPlain(root, rel, isDotenvPath(rel) ? "env" : "config", out);
    }
    return;
  }
  const untracked = listZ(
    tryGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  const ignored = listZ(
    tryGit(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]),
  );
  const envCandidates = [...untracked, ...ignored].filter(
    (p) => !p.endsWith("/") && isDotenvPath(p) && !isTemplate(p),
  );
  for (const rel of new Set([...envCandidates, ...include])) {
    captureLinkedOrPlain(root, rel, isDotenvPath(rel) ? "env" : "config", out);
  }
  for (const rel of untracked) {
    if (out.files.has(rel) || out.symlinks.has(rel)) continue;
    let lst;
    try {
      lst = lstatSync(join(root, rel));
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) captureLinkedOrPlain(root, rel, "config", out);
  }
}

function captureBundle(root, remoteUrl, headSha, warnings) {
  if (!headSha) return { bundle: null, kind: null, branches: [], unpushed: 0 };
  const unpushed = Number(
    (remoteUrl
      ? tryGit(root, [
          "rev-list",
          "--count",
          "--branches",
          "--not",
          "--remotes",
        ])
      : tryGit(root, ["rev-list", "--count", "--all"])
    )?.trim() ?? 0,
  );
  if (remoteUrl && unpushed === 0)
    return { bundle: null, kind: null, branches: [], unpushed };
  const dir = mkdtempSync(join(tmpdir(), "rose-sync-bundle-"));
  try {
    const file = join(dir, "repo.bundle");
    const revs = remoteUrl ? ["--branches", "--not", "--remotes"] : ["--all"];
    const made = tryGit(root, ["bundle", "create", "--quiet", file, ...revs]);
    if (made === null || !existsSync(file)) {
      warnings.push("Could not bundle local commits");
      return { bundle: null, kind: null, branches: [], unpushed };
    }
    const bundle = readFileSync(file);
    if (bundle.length > MAX_BUNDLE_BYTES) {
      warnings.push(
        `Local commit bundle exceeds ${MAX_BUNDLE_BYTES} bytes; not synced`,
      );
      return { bundle: null, kind: null, branches: [], unpushed };
    }
    const heads = (tryGit(root, ["bundle", "list-heads", file]) ?? "")
      .split("\n")
      .map((line) => line.split(" ")[1])
      .filter((ref) => ref && ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length));
    return {
      bundle,
      kind: remoteUrl ? "unpushed" : "full",
      branches: heads,
      unpushed,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Binary patch of tracked + untracked changes vs HEAD, via a temporary index. */
function capturePatch(root, headSha, excluded, warnings) {
  if (!headSha) return null;
  const dir = mkdtempSync(join(tmpdir(), "rose-sync-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    git(root, ["read-tree", "HEAD"], { env });
    // Ignored paths are already skipped by `add -A`; naming them in an exclude
    // pathspec makes git refuse the whole add, so only exclude the others.
    const candidates = [...excluded];
    const ignored = new Set(
      candidates.length > 0
        ? (tryGit(root, ["check-ignore", "--", ...candidates]) ?? "")
            .split("\n")
            .filter(Boolean)
        : [],
    );
    const excludes = candidates
      .filter((p) => !ignored.has(p))
      .map((p) => `:(exclude,literal)${p}`);
    git(root, ["add", "-A", "--", ".", ...excludes], { env });
    const patch = git(root, ["diff", "--cached", "--binary", "HEAD"], {
      env,
      encoding: "buffer",
    });
    if (patch.length === 0) return null;
    if (patch.length > MAX_PATCH_BYTES) {
      warnings.push(
        `Uncommitted changes exceed ${MAX_PATCH_BYTES} bytes; not synced`,
      );
      return null;
    }
    return patch;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readIf(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function projectDirs(root) {
  const dirs = ["."];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      entry.name === "node_modules"
    )
      continue;
    const sub = join(root, entry.name);
    if (
      ["package.json", "requirements.txt", "pyproject.toml"].some((f) =>
        existsSync(join(sub, f)),
      )
    ) {
      dirs.push(entry.name);
    }
  }
  return dirs;
}

function captureToolchain(root, dirs) {
  const files = [];
  const toolVersions = {};
  for (const dir of dirs) {
    for (const name of [
      ".nvmrc",
      ".node-version",
      ".python-version",
      ".tool-versions",
    ]) {
      const rel = dir === "." ? name : `${dir}/${name}`;
      const content = readIf(join(root, rel));
      if (content === null || content.length > 4096) continue;
      files.push({ path: rel, content });
      if (name === ".tool-versions") {
        for (const line of content.split("\n")) {
          const [tool, version] = line.trim().split(/\s+/);
          if (tool && version && !tool.startsWith("#"))
            toolVersions[tool] = version;
        }
      }
    }
  }
  const first = (names) => {
    for (const name of names) {
      const hit = files.find((f) => f.path === name);
      if (hit) return hit.content.trim().split("\n")[0];
    }
    return null;
  };
  const localVersions = { node: process.version };
  const py = (() => {
    try {
      return execFileSync("python3", ["--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      return null;
    }
  })();
  if (py) localVersions.python = py.replace(/^Python\s+/, "");
  return {
    node:
      first([".nvmrc", ".node-version"]) ??
      toolVersions.nodejs ??
      toolVersions.node ??
      null,
    python: first([".python-version"]) ?? toolVersions.python ?? null,
    toolVersions,
    localVersions,
    files,
  };
}

function suggestSetup(root, dirs) {
  const out = [];
  const add = (dir, command, reason) => out.push({ dir, command, reason });
  for (const dir of dirs) {
    const has = (f) => existsSync(join(root, dir, f));
    if (has("package-lock.json")) add(dir, "npm ci", "package-lock.json");
    else if (has("pnpm-lock.yaml"))
      add(dir, "pnpm install --frozen-lockfile", "pnpm-lock.yaml");
    else if (has("yarn.lock"))
      add(dir, "yarn install --frozen-lockfile", "yarn.lock");
    if (has("uv.lock")) add(dir, "uv sync", "uv.lock");
    else if (has("requirements.txt")) {
      add(
        dir,
        "python3 -m venv venv && ./venv/bin/pip install -r requirements.txt",
        "requirements.txt",
      );
    }
  }
  return out;
}

/** Top-level directory of the checkout containing `dir`. */
export function checkoutRoot(dir) {
  return realpathSync(
    git(resolve(dir), ["rev-parse", "--show-toplevel"]).trim(),
  );
}

/**
 * Capture `dir`'s checkout. Options: include (extra repo-relative paths),
 * setup (explicit setup commands), client (source label), filesOnly (skip the
 * git bundle and uncommitted patch).
 */
export function captureCheckout(dir, options = {}) {
  const include = (options.include ?? []).map((p) => p.replace(/^\.\/+/, ""));
  const root = checkoutRoot(dir);
  const remoteUrl = sanitizeRemote(
    tryGit(root, ["remote", "get-url", "origin"])?.trim() || null,
  );
  const branch =
    tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"])?.trim() || null;
  const headSha =
    tryGit(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null;
  const out = { files: new Map(), symlinks: new Map(), warnings: [] };
  captureFiles(root, include, out, options.filesOnly === true);
  // filesOnly: no branch bundle and no uncommitted patch (neither is read).
  const bundle = options.filesOnly
    ? { bundle: null, kind: null, branches: [], unpushed: 0 }
    : captureBundle(root, remoteUrl, headSha, out.warnings);
  const excluded = new Set([...out.files.keys(), ...out.symlinks.keys()]);
  const patch = options.filesOnly
    ? null
    : capturePatch(root, headSha, excluded, out.warnings);
  const dirty = dirtyPaths(root).filter((p) => !excluded.has(p));
  const dirs = projectDirs(root);
  const manifest = {
    version: 1,
    source: {
      client: options.client ?? "rose-sync",
      host: hostname(),
      dir: root,
      capturedAt: new Date().toISOString(),
    },
    git: {
      remoteUrl,
      branch,
      headSha,
      unpushedCommits: bundle.unpushed,
      dirtyPaths: dirty.slice(0, 500),
      bundleKind: bundle.kind,
      bundleBranches: bundle.branches,
    },
    symlinks: [...out.symlinks.values()],
    toolchain: captureToolchain(root, dirs),
    setup: {
      commands: options.setup ?? [],
      suggested: suggestSetup(root, dirs),
    },
    warnings: out.warnings,
  };
  return {
    root,
    manifest,
    files: [...out.files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    gitBundle: bundle.bundle,
    uncommittedPatch: patch,
    filesOnly: options.filesOnly === true,
  };
}
