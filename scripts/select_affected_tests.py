#!/usr/bin/env python3
"""Select the /deploy tests a change can reach (over-including by design).

Selection = union of
  (a) a repo-wide static dependency graph: Python imports, TS/JS imports
      (incl. vi.mock / dynamic import / require / '@' aliases across packages),
      dotted-module string literals, and file/directory path references in
      code and shell text (subprocess, readFileSync, `bash scripts/x.sh`);
      a changed file selects every test that TRANSITIVELY reaches it
      (upstream / reverse deps), so the test exercises the change and
      everything the changed code calls (downstream);
  (b) the per-domain agents coverage map (scripts/test-map/agents-coverage.json)
      when present: a domain whose recorded execution touched the file;
  (c) explicit cross-package edges and HTTP route resources: a backend router
      mounted in server.ts at prefix P is reached by every test file that
      mentions P; scripts/test-map/edges.json declares the remainder;
  (d) safety fallback: a run_all trigger (lockfiles, env examples, schema,
      runners, shared config) or a changed file that reaches no test and is
      not declared inert selects EVERY lane in full.

Tests need no manual mapping: lanes discover test files by the same globs
their runners use and the graph is rebuilt from source on every call.

Usage:
  scripts/select_affected_tests.py                       # vs origin/main + worktree
  scripts/select_affected_tests.py --base A --head B     # a commit range
  scripts/select_affected_tests.py --changed-file path   # explicit list
  scripts/select_affected_tests.py --check               # mapping self-check
  ... --format json|report|lane:<name>
"""

from __future__ import annotations

import argparse
import ast
import fnmatch
import json
import os
import re
import subprocess
import sys
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
EDGES_FILE = ROOT / "scripts" / "test-map" / "edges.json"
AGENTS_COVERAGE_MAP = ROOT / "scripts" / "test-map" / "agents-coverage.json"

EXCLUDED_TOP = ("docs/handoffs/", "claude-code-src/", "openclaw/", "hermes-agent/", "codex/", "prime-agent/", "kimi-code/")
CODE_EXT = {".py", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".sh", ".bash"}
TS_EXT = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx")
TEXT_SCAN_EXT = CODE_EXT | {".rb", ""}
BASENAME_STOP = {
    "index.ts", "index.tsx", "index.js", "__init__.py", "package.json", "README.md", "types.ts",
    "utils.ts", "config.py", "config.ts", "constants.ts", "service.ts", "routes.ts", "repository.ts",
    "schemas.ts", "controller.ts", "test.ts", "main.py", "models.py", "base.py", "client.py",
    "client.ts", "helpers.ts", "setup.ts", "tsconfig.json", ".env", "run.sh", "conftest.py",
}
MAX_BASENAME_FANOUT = 4
DOTTED_RE = re.compile(r"""['"]([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)+)['"]""")
TS_SPEC_RES = (
    re.compile(r"""\bfrom\s*['"]([^'"\n]+)['"]"""),
    re.compile(r"""\bimport\s*['"]([^'"\n]+)['"]"""),
    re.compile(r"""\bimport\(\s*['"]([^'"\n]+)['"]\s*\)"""),
    re.compile(r"""\brequire\(\s*['"]([^'"\n]+)['"]\s*\)"""),
    re.compile(r"""\bvi\.(?:mock|doMock|importActual|importMock)\(\s*['"]([^'"\n]+)['"]"""),
)
PY_FROM_RE = re.compile(r"^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)", re.M)
PY_IMPORT_RE = re.compile(r"^[ \t]*import[ \t]+([\w., \t]+)", re.M)
DIR_WALK_RE = re.compile(
    r"readdirSync|readdir\(|opendir|globSync|fast-glob|fg\.sync|os\.walk|os\.listdir|os\.scandir|\.rglob\(|"
    r"\.glob\(|glob\.glob|iterdir\(|\bfind\s+[\"$./]|git\s+ls-files|git\s+grep|\brg\s|\bgrep\s+-[a-zA-Z]*r"
)
PATH_HINT_RE = re.compile(r"[/.\-_][A-Za-z]")
EXEC_LINE_RE = re.compile(
    r"\b(?:python3?|bash|sh|node|tsx|npx|source|exec)\s|\b(?:execFile|execa|spawn|spawnSync|execSync|subprocess|"
    r"Popen|check_call|check_output|run_path|runpy|import_module|spec_from_file_location|require|import)\b"
)
URL_RE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://\S+")
PATH_TOKEN_RE = re.compile(r"[A-Za-z0-9_@.\-/]{3,}")
HTTP_TOKEN_RE = re.compile(r"/(?:api|webhooks|usercontent|anthropic-proxy|codex-proxy)[A-Za-z0-9_\-/]*")
LIVE_SERVER_RE = re.compile(r"BASE_URL|BACKEND_URL|fetch\(|http://|localhost|startBackend|supertest")


# ---------------------------------------------------------------- lanes ---

@dataclass
class Unit:
    lane: str
    name: str
    roots: list[str]


@dataclass
class Lane:
    name: str
    units: list[Unit] = field(default_factory=list)


class Source:
    """The file tree being mapped: the worktree, or a git revision (replay)."""

    def __init__(self, revision: str | None = None) -> None:
        self.revision = revision
        self._text: dict[str, str] = {}
        if revision is None:
            out = _git_bytes("ls-files", "-z", "--cached", "--others", "--exclude-standard").decode()
            names = {f for f in out.split("\0") if f and (ROOT / f).is_file()}
        else:
            out = _git_bytes("ls-tree", "-r", "-z", "--name-only", revision).decode()
            names = {f for f in out.split("\0") if f}
        self.files = sorted(f for f in names if not f.startswith(EXCLUDED_TOP))
        self.fileset = set(self.files)
        self.dirs = {"/".join(f.split("/")[:i]) for f in self.files for i in range(1, f.count("/") + 1)}
        if revision is not None:
            self._prefetch()

    def _prefetch(self) -> None:
        wanted = [
            f for f in self.files
            if PurePosixPath(f).suffix in TEXT_SCAN_EXT | {".json"} and (PurePosixPath(f).suffix or f.startswith("scripts/"))
        ]
        payload = "".join(f"{self.revision}:{f}\n" for f in wanted).encode()
        out = _git_bytes("cat-file", "--batch", stdin=payload)
        pos = 0
        for name in wanted:
            header_end = out.index(b"\n", pos)
            header = out[pos:header_end].split()
            if len(header) < 3 or header[-1] == b"missing":
                pos = header_end + 1
                continue
            size = int(header[2])
            body = out[header_end + 1 : header_end + 1 + size]
            pos = header_end + 1 + size + 1
            self._text[name] = body.decode(errors="replace") if size < 2_000_000 else ""

    def read(self, rel: str) -> str:
        if rel not in self._text:
            if self.revision is None:
                try:
                    path = ROOT / rel
                    self._text[rel] = path.read_text(errors="replace") if path.stat().st_size < 2_000_000 else ""
                except OSError:
                    self._text[rel] = ""
            else:
                try:
                    self._text[rel] = _git_bytes("show", f"{self.revision}:{rel}").decode(errors="replace")
                except subprocess.CalledProcessError:
                    self._text[rel] = ""
        return self._text[rel]

    def exists(self, rel: str) -> bool:
        rel = os.path.normpath(rel)
        return rel in self.fileset or rel in self.dirs

    def glob(self, pattern: str) -> list[str]:
        body = re.escape(pattern).replace(r"\*\*/", "(?:.*/)?").replace(r"\*", "[^/]*")
        regex = re.compile("^" + body + "$")
        return sorted(f for f in self.files if regex.match(f))


def _git_bytes(*args: str, stdin: bytes | None = None) -> bytes:
    return subprocess.run(["git", *args], cwd=ROOT, input=stdin, check=True, capture_output=True).stdout


SRC: Source | None = None


def src() -> Source:
    global SRC
    if SRC is None:
        SRC = Source()
    return SRC


def _rel(path: str) -> str:
    return path


def _glob(pattern: str) -> list[str]:
    return src().glob(pattern)


def _structural_gates() -> list[tuple[str, list[str]]]:
    """Parse GATES from the structural-gate registry without importing it."""
    tree = ast.parse(src().read("scripts/run-deploy-structural-gates.py"))
    gates: list[tuple[str, list[str]]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Gate" and len(node.args) >= 2:
            name = node.args[0]
            command = node.args[1]
            if not isinstance(name, ast.Constant) or not isinstance(command, ast.Tuple):
                continue
            args = [a.value for a in command.elts if isinstance(a, ast.Constant) and isinstance(a.value, str)]
            gates.append((name.value, args))
    return gates


def _backend_structural() -> list[tuple[str, list[str]]]:
    script = json.loads(src().read("back-end/package.json"))["scripts"]["test:structural"]
    units = []
    for part in script.split("&&"):
        tokens = part.split()
        files = [t for t in tokens if f"back-end/{t}" in src().fileset]
        if files:
            units.append((Path(files[0]).name, [f"back-end/{f}" for f in files]))
    return units


def discover_lanes() -> dict[str, Lane]:
    lanes = {name: Lane(name) for name in (
        "agents-blackbox", "agents-pytest", "backend-blackbox", "backend-unit", "backend-structural",
        "frontend-vitest", "mac-app-vitest", "deploy-structural-gates", "cloudbench-controller",
    )}
    for path in _glob("agents/tests/blackbox/*.blackbox.py"):
        domain = PurePosixPath(path).name.replace(".blackbox.py", "").replace("_", "-")
        lanes["agents-blackbox"].units.append(Unit("agents-blackbox", domain, [_rel(path)]))
    for pattern in ("agents/tests/unit/test_*.py", "agents/tests/demo_cache/test_*.py"):
        for path in _glob(pattern):
            lanes["agents-pytest"].units.append(Unit("agents-pytest", _rel(path), [_rel(path)]))
    for path in _glob("back-end/src/tests/blackbox/*.blackbox.ts"):
        domain = PurePosixPath(path).name.replace(".blackbox.ts", "")
        lanes["backend-blackbox"].units.append(
            Unit("backend-blackbox", domain, [_rel(path), "back-end/src/bootstrap.ts"])
        )
    for path in _glob("back-end/src/tests/unit/**/*.test.ts"):
        lanes["backend-unit"].units.append(Unit("backend-unit", _rel(path), [_rel(path)]))
    for name, roots in _backend_structural():
        lanes["backend-structural"].units.append(Unit("backend-structural", name, roots))
    for pattern in ("front-end/src/tests/blackbox/**/*.blackbox.ts", "front-end/src/tests/blackbox/**/*.blackbox.tsx",
                    "front-end/src/tests/structural/**/*.test.ts", "front-end/src/tests/structural/**/*.test.tsx"):
        for path in _glob(pattern):
            lanes["frontend-vitest"].units.append(Unit("frontend-vitest", _rel(path), [_rel(path)]))
    for pattern in ("mac-app/tests/blackbox/**/*.blackbox.ts", "mac-app/tests/blackbox/**/*.blackbox.tsx"):
        for path in _glob(pattern):
            lanes["mac-app-vitest"].units.append(Unit("mac-app-vitest", _rel(path), [_rel(path)]))
    for name, args in _structural_gates():
        roots = [a for a in args if src().exists(a)]
        lanes["deploy-structural-gates"].units.append(Unit("deploy-structural-gates", name, roots))
    gate = "scripts/run-cloudbench-controller-gate"
    if gate in src().fileset:
        for command in re.findall(r'^\s*"((?:bash|python3|agents/venv/bin/python)[^"]*)"\s*$', src().read(gate), re.M):
            roots = [t for t in command.split() if src().exists(t) and "/" in t]
            if roots:
                lanes["cloudbench-controller"].units.append(Unit("cloudbench-controller", command, roots + [gate]))
    return lanes


# ---------------------------------------------------------------- files ---

def package_root(rel: str) -> str:
    top = rel.split("/", 1)[0]
    return top if "/" in rel else ""


_TS_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
_PROCESS_MATCH = re.compile(r"\b(?:pkill|pgrep|killall|ps\s+-|grep\s+-[a-zA-Z]*[fq])")


def strip_comments(rel: str, source: str) -> str:
    """Drop comments (and process-pattern lines) before path scanning.

    A path named in a comment documents a relationship but executes nothing;
    following it transitively leaked whole packages into unrelated lanes.
    """
    ts = PurePosixPath(rel).suffix in TS_EXT
    if ts:
        source = _TS_BLOCK_COMMENT.sub(" ", source)
    marker = "//" if ts else "#"
    kept = []
    for line in source.splitlines():
        if _PROCESS_MATCH.search(line):
            continue
        stripped = line.lstrip()
        if stripped.startswith(marker) and not stripped.startswith("#!"):
            continue
        cut = line.find(" " + marker)
        kept.append(line[:cut] if cut >= 0 else line)
    return "\n".join(kept)


def is_test_file(rel: str) -> bool:
    return "/tests/" in f"/{rel}" or bool(re.search(r"(\.test\.|\.blackbox\.|_test\.py$|/test_[^/]*\.py$)", rel))


def is_test_support(rel: str) -> bool:
    return "/tests/" in f"/{rel}" or rel.startswith("scripts/") or rel.endswith((".test.ts", "_test.py"))


# ---------------------------------------------------------------- graph ---

class Graph:
    def __init__(self, files: list[str]):
        self.files = files
        self.fileset = set(files)
        self.dirs: set[str] = set()
        for f in files:
            parts = f.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                self.dirs.add("/".join(parts[:i]))
        self.by_basename: dict[str, list[str]] = defaultdict(list)
        self.by_suffix: dict[str, list[str]] = defaultdict(list)
        self.dir_by_suffix: dict[str, list[str]] = defaultdict(list)
        for f in files:
            self.by_basename[PurePosixPath(f).name].append(f)
            parts = f.split("/")
            for i in range(1, len(parts) - 1):
                self.by_suffix["/".join(parts[i:])].append(f)
        for d in self.dirs:
            parts = d.split("/")
            for i in range(1, len(parts)):
                self.dir_by_suffix["/".join(parts[i:])].append(d)
        self.deps: dict[str, set[str]] = defaultdict(set)  # node -> nodes it depends on (transitive)
        self.data_deps: dict[str, set[str]] = defaultdict(set)  # node -> files whose bytes it reads
        self.text: dict[str, str] = {}

    def add(self, src: str, dst: str) -> None:
        # Product code never depends on test files; a product comment naming
        # a test would otherwise leak every test's imports into the product.
        if src != dst and not (is_test_file(dst) and not is_test_file(src)):
            self.deps[src].add(dst)

    def read(self, rel: str) -> str:
        if rel not in self.text:
            try:
                self.text[rel] = src().read(rel)
            except OSError:
                self.text[rel] = ""
        return self.text[rel]

    # -- python
    def _py_roots(self, rel: str) -> list[str]:
        here = str(PurePosixPath(rel).parent)
        roots = [here]
        if rel.startswith("agents/"):
            roots += ["agents", "agents/tests/blackbox", "agents/tests"]
        elif rel.startswith("scripts/"):
            roots += ["scripts", "scripts/tests", "agents", ""]
        elif rel.startswith("research/"):
            roots += ["research"]
        else:
            roots += ["", "agents"]
        return roots

    def _py_module(self, roots: list[str], dotted: str) -> list[str]:
        parts = dotted.split(".")
        found = []
        for root in roots:
            base = "/".join(p for p in [root, *parts] if p)
            for cand in (f"{base}.py", f"{base}/__init__.py"):
                if cand in self.fileset:
                    found.append(cand)
                    # importing a.b.c executes a/__init__ and a/b/__init__
                    for i in range(1, len(parts)):
                        init = "/".join(p for p in [root, *parts[:i]] if p) + "/__init__.py"
                        if init in self.fileset:
                            found.append(init)
            if found:
                return found
        return found

    def python_edges(self, rel: str) -> None:
        # Regex, not ast: ~20x faster and also sees imports inside strings
        # passed to exec/subprocess `python -c`, which only over-includes.
        source = self.read(rel)
        roots = self._py_roots(rel)
        pkg_dir = PurePosixPath(rel).parent
        for match in PY_FROM_RE.finditer(source):
            dots, mod, body = match.group(1), match.group(2) or "", match.group(3)
            if dots:
                base = pkg_dir
                for _ in range(len(dots) - 1):
                    base = base.parent
                target_roots = [str(base)]
            else:
                target_roots = roots
            body = body.split("#", 1)[0] if "(" not in body else body
            names = [mod] if mod else []
            for item in re.split(r"[,()\s]+", body):
                item = item.strip()
                if item and item not in {"as", "import", "*"} and item.isidentifier():
                    names.append(f"{mod}.{item}" if mod else item)
            for name in names:
                for target in self._py_module(target_roots, name):
                    self.add(rel, target)
        for match in PY_IMPORT_RE.finditer(source):
            for item in match.group(1).split(","):
                name = item.strip().split(" as ")[0].strip()
                if name:
                    for target in self._py_module(roots, name):
                        self.add(rel, target)
        for match in DOTTED_RE.finditer(source):
            for target in self._py_module(roots, match.group(1)):
                self.add(rel, target)

    # -- typescript / javascript
    def _ts_resolve(self, rel: str, spec: str) -> str | None:
        here = PurePosixPath(rel).parent
        if spec.startswith("."):
            base = os.path.normpath(str(here / spec))
        elif spec.startswith("@/") and rel.startswith(("front-end/", "mac-app/")):
            base = "front-end/src/" + spec[2:]
        elif spec.startswith("@shared/") and rel.startswith("mac-app/"):
            base = "front-end/src/" + spec[len("@shared/"):]
        else:
            return None
        cands = [base]
        stem = base
        for ext in TS_EXT:
            if base.endswith(ext):
                stem = base[: -len(ext)]
        cands += [stem + e for e in (".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".jsx", ".json")]
        cands += [f"{base}/index{e}" for e in (".ts", ".tsx", ".js", ".mjs")]
        for cand in cands:
            if cand in self.fileset:
                return cand
        return None

    def ts_edges(self, rel: str) -> None:
        source = self.read(rel)
        for pattern in TS_SPEC_RES:
            for match in pattern.finditer(source):
                target = self._ts_resolve(rel, match.group(1))
                if target:
                    self.add(rel, target)

    # -- path references in text (subprocess, fs reads, bash invocations)
    def scanner_edges(self, rel: str) -> None:
        """A test that lists directories reads its whole package (data edge)."""
        if is_test_file(rel) and DIR_WALK_RE.search(strip_comments(rel, self.read(rel))):
            top = rel.split("/", 1)[0]
            self.add_data(rel, f"dir:{top}")

    def path_edges(self, rel: str) -> None:
        """Path references: exec-context refs are transitive, others are data.

        `bash scripts/x.sh` / `python3 agents/y.py` runs the target with all
        of its imports (transitive edge). A path merely read, hashed or
        compared (readFileSync, a deployment file list) depends only on that
        file's own bytes (data edge: affected iff the target itself changed).
        """
        source = URL_RE.sub(" ", strip_comments(rel, self.read(rel)))
        here = str(PurePosixPath(rel).parent)
        pkg = package_root(rel)
        allow_dirs = is_test_support(rel)
        shell = PurePosixPath(rel).suffix in {".sh", ".bash", ""}
        for line in source.splitlines():
            if not PATH_HINT_RE.search(line):
                continue
            # Product code names repo scripts in help text and error messages;
            # only tests, scripts and shell are treated as executing them.
            exec_line = shell or (allow_dirs and bool(EXEC_LINE_RE.search(line)))
            for token in PATH_TOKEN_RE.findall(line):
                stripped = token.lstrip("/")
                while stripped.startswith(("./", "../")):
                    stripped = stripped.split("/", 1)[1]
                stripped = stripped.rstrip("/.")
                if not stripped:
                    continue
                targets: list[str] = []
                if "/" in stripped:
                    for base in ("", pkg, here):
                        cand = os.path.normpath(f"{base}/{stripped}") if base else stripped
                        if cand in self.fileset:
                            targets.append(cand)
                        elif allow_dirs and cand in self.dirs and cand.count("/") >= 1:
                            self.add_data(rel, f"dir:{cand}")
                    parts = stripped.split("/")
                    # Relative to a computed base (`$ROOT_DIR/...`,
                    # `path.resolve(__dirname, '../..')`): longest suffix that
                    # names real files/dirs, dropping unknown leading parts.
                    for i in range(len(parts) - 1 if not targets else 0):
                        tail = "/".join(parts[i:])
                        matches = self.by_suffix.get(tail, ()) or ([tail] if tail in self.fileset else [])
                        if 0 < len(matches) <= MAX_BASENAME_FANOUT:
                            targets.extend(matches)
                            break
                        if allow_dirs:
                            dmatches = self.dir_by_suffix.get(tail, ()) or ([tail] if tail in self.dirs else [])
                            if 0 < len(dmatches) <= MAX_BASENAME_FANOUT:
                                for d in dmatches:
                                    self.add_data(rel, f"dir:{d}")
                                break
                elif "." in stripped and not stripped.startswith("."):
                    matches = [m for m in self.by_basename.get(stripped, ()) if not m.startswith("docs/")]
                    if 0 < len(matches) <= MAX_BASENAME_FANOUT and stripped not in BASENAME_STOP:
                        targets.extend(matches)
                elif len(stripped) >= 6 and ("-" in stripped or "_" in stripped):
                    # Extensionless executables (`run-bench-fleet`) named alone.
                    matches = [m for m in self.by_basename.get(stripped, ()) if not m.startswith("docs/")]
                    if 0 < len(matches) <= 2:
                        targets.extend(matches)
                for cand in targets:
                    runs_it = exec_line or (is_test_file(rel) and is_test_file(cand))
                    if runs_it and PurePosixPath(cand).suffix in CODE_EXT | {""}:
                        self.add(rel, cand)
                    else:
                        self.add_data(rel, cand)

    def add_data(self, src: str, dst: str) -> None:
        if src != dst and not (is_test_file(dst) and not is_test_file(src)):
            self.data_deps[src].add(dst)

    def build(self) -> None:
        for rel in self.files:
            ext = PurePosixPath(rel).suffix
            if ext == ".py":
                self.python_edges(rel)
            elif ext in TS_EXT:
                self.ts_edges(rel)
            if ext in TEXT_SCAN_EXT and (ext or rel.startswith("scripts/")):
                self.path_edges(rel)
                self.scanner_edges(rel)
        self._backend_http()

    def _backend_http(self) -> None:
        """Replace server.ts -> router edges with HTTP prefix resources."""
        server = "back-end/src/server.ts"
        if server not in self.fileset:
            return
        source = self.read(server)
        imports: dict[str, str] = {}
        for match in re.finditer(r"import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+['\"]([^'\"]+)['\"]", source):
            target = self._ts_resolve(server, match.group(3))
            if not target:
                continue
            names = [match.group(1)] if match.group(1) else [
                n.split(" as ")[-1].strip() for n in match.group(2).split(",") if n.strip()
            ]
            for name in names:
                imports[name] = target
        self.routers: dict[str, set[str]] = defaultdict(set)
        for match in re.finditer(r"app\.use\(\s*['\"](/[^'\"]*)['\"]\s*,([^;]*?)\)\s*;", source, re.S):
            prefix = match.group(1)
            for ident in re.findall(r"\b([A-Za-z_]\w*)\b", match.group(2)):
                if ident in imports and re.search(r"[Rr]outer$", ident):
                    self.routers[prefix].add(imports[ident])
        mounted = {m for mods in self.routers.values() for m in mods}
        self.deps[server] -= mounted
        for prefix, modules in self.routers.items():
            for module in modules:
                self.add(f"http:{prefix}", module)
        keys = {}
        for prefix in self.routers:
            keys[prefix] = prefix
            if prefix.startswith("/api/"):
                keys[prefix[4:]] = prefix
        # HTTP consumers: every TEST file in every package that names a route
        # (backend blackboxes, agents/front-end/mac-app contract assertions).
        # Product API clients are not consumers here: their tests mock the
        # backend, so routing every client module made each route change
        # select whole packages without any test able to observe it.
        test_files = [f for f in self.files if PurePosixPath(f).suffix in CODE_EXT and is_test_file(f)]
        for rel in test_files:
            source = self.read(rel)
            hits = set()
            for token in HTTP_TOKEN_RE.findall(source) + re.findall(r"['\"`](/[A-Za-z0-9_\-]+)", source):
                for key, prefix in keys.items():
                    if token == key or token.startswith(key + "/"):
                        hits.add(prefix)
            for prefix in hits:
                self.add(rel, f"http:{prefix}")
            if not hits and rel.startswith("back-end/src/tests/blackbox/") and LIVE_SERVER_RE.search(source):
                for prefix in self.routers:
                    self.add(rel, f"http:{prefix}")

    def reverse(self) -> dict[str, set[str]]:
        rev: dict[str, set[str]] = defaultdict(set)
        for src, dsts in self.deps.items():
            for dst in dsts:
                rev[dst].add(src)
        return rev

    def reverse_data(self) -> dict[str, set[str]]:
        rev: dict[str, set[str]] = defaultdict(set)
        for src, dsts in self.data_deps.items():
            for dst in dsts:
                rev[dst].add(src)
        return rev


# ------------------------------------------------------------- selection ---

def _match(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, p) for p in patterns)


def load_edges() -> dict:
    return json.loads(EDGES_FILE.read_text())


def load_coverage_map() -> dict[str, set[str]]:
    if AGENTS_COVERAGE_MAP.exists():
        domains = json.loads(AGENTS_COVERAGE_MAP.read_text()).get("domains", {})
        return {domain: set(files) for domain, files in domains.items()}
    return {}


@dataclass
class Selection:
    all_lanes: bool
    reasons: list[str]
    selected: dict[str, set[str]]
    unmapped: list[str]
    totals: dict[str, int]
    full_lanes: set[str] = field(default_factory=set)


class Selector:
    def __init__(self) -> None:
        self.graph = Graph(src().files)
        self.graph.build()
        self.rev = self.graph.reverse()
        self.rev_data = self.graph.reverse_data()
        self.lanes = discover_lanes()
        self.config = load_edges()
        self.coverage = load_coverage_map()
        self.root_units: dict[str, list[Unit]] = defaultdict(list)
        for lane in self.lanes.values():
            for unit in lane.units:
                for root in unit.roots:
                    self.root_units[root].append(unit)

    def upstream(self, changed: set[str], package_scans: bool = True) -> set[str]:
        """Everything that transitively depends on `changed`.

        Data readers of a changed file (or of a directory containing it) join
        the start set; from there only transitive (import/exec) edges are
        followed, because a file read as bytes does not pull in its imports.
        """
        start = set(changed)
        for path in changed:
            start |= self.rev_data.get(path, set())
            parts = path.split("/")[:-1]
            for i in range(1 if package_scans else 2, len(parts) + 1):
                start |= self.rev_data.get("dir:" + "/".join(parts[:i]), set())
        seen = set(start)
        queue = deque(start)
        while queue:
            node = queue.popleft()
            for parent in self.rev.get(node, ()):
                if parent not in seen:
                    seen.add(parent)
                    queue.append(parent)
        return seen

    def select(self, changed: list[str]) -> Selection:
        cfg = self.config
        reasons: list[str] = []
        selected: dict[str, set[str]] = {name: set() for name in self.lanes}
        unmapped: list[str] = []
        full_lanes: set[str] = set()
        for path in changed:
            if _match(path, cfg["run_all"]):
                reasons.append(f"run_all trigger: {path}")
                continue
            lane_trigger = False
            for rule in cfg.get("run_lanes", []):
                if _match(path, rule["from"]):
                    for lane in rule["lanes"]:
                        selected[lane] |= {u.name for u in self.lanes[lane].units}
                        full_lanes.add(lane)
                    lane_trigger = True
            reached = self.upstream({path})
            for node in reached:
                for unit in self.root_units.get(node, ()):
                    selected[unit.lane].add(unit.name)
            # Mapped = reached through a specific edge; whole-package scanner
            # tests (structural walkers) still run but do not count, so a new
            # file only a walker sees falls back to ALL.
            hit = any(self.root_units.get(n) for n in self.upstream({path}, package_scans=False))
            for domain, files in self.coverage.items():
                if path in files or any(n in files for n in reached if not n.startswith(("dir:", "http:"))):
                    if domain in {u.name for u in self.lanes["agents-blackbox"].units}:
                        selected["agents-blackbox"].add(domain)
                        hit = True
            for edge in cfg.get("edges", []):
                if not _match(path, edge["from"]):
                    continue
                for target in edge.get("to_files", []):
                    for node in self.upstream({target}):
                        for unit in self.root_units.get(node, ()):
                            selected[unit.lane].add(unit.name)
                            hit = True
                for lane, names in edge.get("to_lanes", {}).items():
                    for unit in self.lanes[lane].units:
                        if _match(unit.name, names):
                            selected[lane].add(unit.name)
                            hit = True
            if not hit and not lane_trigger and not _match(path, cfg["no_tests"]):
                unmapped.append(path)
        if unmapped:
            reasons.append(f"unmapped files reach no test: {', '.join(unmapped[:10])}")
        all_lanes = bool(reasons)
        if all_lanes:
            selected = {name: {u.name for u in lane.units} for name, lane in self.lanes.items()}
        totals = {name: len(lane.units) for name, lane in self.lanes.items()}
        full = set(self.lanes) if all_lanes else full_lanes | {n for n, l in self.lanes.items() if len(selected[n]) == len(l.units)}
        return Selection(all_lanes, reasons, selected, unmapped, totals, full)

    def unmappable_tests(self) -> list[str]:
        """Test files on disk that no lane unit covers (auto-mapping guard)."""
        known = {root for unit_list in self.root_units.values() for unit in unit_list for root in unit.roots}
        patterns = [
            "agents/tests/blackbox/*.blackbox.py", "agents/tests/unit/test_*.py", "agents/tests/demo_cache/test_*.py",
            "back-end/src/tests/blackbox/*.blackbox.ts", "back-end/src/tests/unit/**/*.test.ts",
            "back-end/src/tests/structural/*.test.ts",
            "front-end/src/tests/**/*.blackbox.ts", "front-end/src/tests/**/*.blackbox.tsx",
            "front-end/src/tests/structural/**/*.test.ts", "front-end/src/tests/structural/**/*.test.tsx",
            "mac-app/tests/blackbox/**/*.blackbox.ts", "mac-app/tests/blackbox/**/*.blackbox.tsx",
        ]
        missing = []
        for pattern in patterns:
            for path in _glob(pattern):
                if _rel(path) not in known:
                    missing.append(_rel(path))
        return missing


# ------------------------------------------------------------------- cli ---

def changed_files(base: str | None, head: str | None) -> list[str]:
    def git(*args: str) -> list[str]:
        out = subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout
        return [line for line in out.splitlines() if line]

    if head:
        return sorted(set(git("diff", "--name-only", f"{base}...{head}" if base else f"{head}^", head)))
    base = base or "origin/main"
    files = set(git("diff", "--name-only", f"{base}...HEAD"))
    files |= set(git("diff", "--name-only", "HEAD"))
    files |= set(git("ls-files", "--others", "--exclude-standard"))
    return sorted(f for f in files if not f.startswith(EXCLUDED_TOP))


def self_check(selector: Selector) -> list[str]:
    problems = []
    for path in selector.unmappable_tests():
        problems.append(f"test file not mapped to any lane: {path}")
    for name, lane in selector.lanes.items():
        if not lane.units:
            problems.append(f"lane {name} discovered no tests (fallback to ALL impossible)")
    probe = selector.select(["back-end/prisma/schema.prisma"])
    for name, lane in selector.lanes.items():
        if probe.selected[name] != {u.name for u in lane.units}:
            problems.append(f"lane {name} does not fall back to ALL on a run_all trigger")
    probe = selector.select(["__unmapped_probe__/x.py"])
    if not probe.all_lanes:
        problems.append("an unknown file does not select ALL")
    for unit in (u for lane in selector.lanes.values() for u in lane.units):
        own = unit.roots[0] if unit.roots else None
        if not own:
            problems.append(f"{unit.lane}:{unit.name} has no root file")
            continue
        if unit.name not in selector.select([own]).selected[unit.lane]:
            problems.append(f"{unit.lane}:{unit.name} is not selected by a change to its own file {own}")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--changed-file", action="append", default=[])
    parser.add_argument("--changed-files-from")
    parser.add_argument("--format", default="report")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--rev", help="map the tree of this revision instead of the worktree (history replay)")
    args = parser.parse_args(argv)
    if args.rev:
        global SRC
        SRC = Source(args.rev)
    selector = Selector()
    if args.check:
        problems = self_check(selector)
        for p in problems:
            print(f"FAIL {p}")
        print(f"select_affected_tests self-check: {len(problems)} problem(s)")
        return 1 if problems else 0
    changed = list(args.changed_file)
    if args.changed_files_from:
        changed += [line.strip() for line in Path(args.changed_files_from).read_text().splitlines() if line.strip()]
    if not changed:
        changed = changed_files(args.base, args.head)
    sel = selector.select(changed)
    if args.format == "json":
        print(json.dumps({
            "all": sel.all_lanes, "reasons": sel.reasons, "changed": changed,
            "lanes": {k: sorted(v) for k, v in sel.selected.items()}, "totals": sel.totals, "full_lanes": sorted(sel.full_lanes),
        }, indent=2))
    elif args.format.startswith("lane:"):
        lane = args.format.split(":", 1)[1]
        print("\n".join(sorted(sel.selected[lane])))
    else:
        print(f"changed files: {len(changed)}")
        print("mode: ALL" if sel.all_lanes else "mode: SELECTED")
        for reason in sel.reasons[:20]:
            print(f"  reason: {reason}")
        for lane, units in sel.selected.items():
            print(f"  {lane:26s} {len(units):4d}/{sel.totals[lane]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
