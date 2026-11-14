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
  scripts/select_affected_tests.py --stability           # new/changed test cases: 5 consecutive runs under CPU load
  ... --format json|report|lane:<name>
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import fnmatch
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Callable

ROOT = Path(__file__).resolve().parents[1]
EDGES_FILE = ROOT / "scripts" / "test-map" / "edges.json"
AGENTS_COVERAGE_MAP = ROOT / "scripts" / "test-map" / "agents-coverage.json"

EXCLUDED_TOP = ("docs/handoffs/", "claude-code-src/", "openclaw/", "hermes-agent/", "codex/", "prime-agent/", "kimi-code/", "openworker/")
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
        roots = []
        for argument in args:
            normalized = os.path.normpath(argument)
            if normalized in src().fileset:
                roots.append(normalized)
            elif normalized in src().dirs:
                roots.extend(path for path in src().files if path.startswith(normalized + "/"))
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


_PROCESS_MATCH = re.compile(r"\b(?:pkill|pgrep|killall)\b|\bps\b[^\n]*\|\s*grep\b")

# TypeScript/JavaScript comment stripping is a small tokenizer rather than a
# regex over the raw text: comments, strings, template literals (with nested
# `${...}` expressions), regex literals and code are distinguished so that a
# path named only in a comment never becomes an edge while a path in a string
# literal, template or regex is always kept. Every uncertain state (an
# unterminated string, template, expression or block comment at EOF) returns
# the raw source: over-selecting is acceptable, erasing a dependency is not.
#
# Regex-vs-division after `/` is decided from the previous token. A regex
# misread as division is the dangerous direction (its escaped slashes can form
# `//` and drop the rest of the line), a division misread as a regex only
# swallows code up to the next `/` on the line without removing anything, so
# the ambiguous `)` and `}` prefer regex while `]`, identifiers, numbers and
# `++`/`--` (where a regex cannot legally start) mean division. Known
# residual: a division after `)`/`}` followed on the SAME physical line by two
# `/`-bearing string literals can hide a path in the second one; a regex after
# `)`/`}` is refused when its candidate span contains a backtick (that is a
# division reaching into a template literal, `(a) / 2 + \`x/${b}\``; read as a
# regex it would swallow the template opener and flip template state for every
# later line, erasing a `//` inside a later template as a comment); a regex after
# `]`/identifier/number (invalid syntax anyway) can drop the rest of its line.
# Strings end at the newline and templates fall back to raw, so damage never
# crosses a line. A repo-wide scan (2026-10-31, 3,583 TS/JS files) found 3
# lines where the `)` policy changes the stripped output, all of the form
# `Math.round(x) / 100, // note`: the trailing comment text is retained
# (over-inclusion), nothing executable is dropped.
_TS_TOKEN_RE = re.compile(
    r"""
    (?P<line>//[^\n]*)
  | (?P<block>/\*[\s\S]*?\*/)
  | (?P<block_open>/\*)
  | (?P<string>'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*")
  | (?P<unterminated>['"])
  | (?P<tick>`)
  | (?P<slash>/)
  | (?P<rbrace>\})
  | (?P<plain>[^'"`/}]+)
    """,
    re.X,
)
_TS_TEMPLATE_BODY_RE = re.compile(r"(?:[^`\\$]|\\[\s\S]|\$(?!\{))*")
_TS_REGEX_RE = re.compile(r"/(?:[^/\\\n\[]|\\[^\n]|\[(?:[^\]\\\n]|\\[^\n])*\])+/[A-Za-z]*")
_TS_TAIL_RE = re.compile(r"([A-Za-z_$][\w$]*|\d[\w.]*|\+\+|--|\S)\s*$")
# After one of these a `/` starts a regex literal; after a value it divides.
_TS_REGEX_KEYWORDS = frozenset(
    "return typeof case do else in instanceof new delete void throw yield await of".split()
)


def _ts_regex_allowed(last_kind: str, last_text: str) -> bool:
    if last_kind == "value":
        return False
    if last_kind != "plain":
        return True
    tail = _TS_TAIL_RE.search(last_text[-96:].rstrip()[-48:])
    if tail is None:
        return True
    token = tail.group(1)
    if token in _TS_REGEX_KEYWORDS:
        return True
    if token[0].isalnum() or token[0] in "_$" or token in {"]", "++", "--"}:
        return False
    return True  # includes `)`: `if (ok) /re/.test(s)` must survive


def _ts_regex_ambiguous(last_kind: str, last_text: str) -> bool:
    """The previous token ends with `)` or `}`: a `/` after it may be either a
    regex literal (``if (ok) /re/.test(s)``) or a division (``(a) / 2``)."""
    if last_kind == "op":
        return last_text == "}"
    if last_kind != "plain":
        return False
    tail = _TS_TAIL_RE.search(last_text[-96:].rstrip()[-48:])
    return tail is not None and tail.group(1) == ")"


def _strip_ts_comments(source: str) -> str:
    """Remove comments from TS/JS source, preserving every line boundary.

    Returns the raw source whenever the tokenizer ends in an uncertain state.
    """
    out: list[str] = []
    pos = 0
    length = len(source)
    last_kind = "start"  # start | plain | value | op
    last_text = ""
    in_template = False
    expression_depths: list[int] = []  # brace depth of each open `${`
    while pos < length:
        if in_template:
            body = _TS_TEMPLATE_BODY_RE.match(source, pos)
            end = body.end()
            out.append(source[pos:end])
            pos = end
            if pos >= length:
                return source  # unterminated template literal
            if source[pos] == "`":
                out.append("`")
                pos += 1
                in_template = False
                last_kind, last_text = "value", "`"
            else:
                out.append("${")
                pos += 2
                in_template = False
                expression_depths.append(0)
                last_kind, last_text = "op", "${"
            continue
        match = _TS_TOKEN_RE.match(source, pos)
        if match is None:
            return source
        kind = match.lastgroup
        text = match.group()
        pos = match.end()
        if kind == "line":
            continue
        if kind == "block":
            out.append(" " + "\n" * text.count("\n"))
            continue
        if kind in ("block_open", "unterminated"):
            return source
        if kind == "tick":
            out.append("`")
            in_template = True
            continue
        if kind == "rbrace":
            if expression_depths:
                if expression_depths[-1] == 0:
                    expression_depths.pop()
                    out.append("}")
                    in_template = True
                    continue
                expression_depths[-1] -= 1
            out.append("}")
            last_kind, last_text = "op", "}"
            continue
        if kind == "slash":
            if _ts_regex_allowed(last_kind, last_text):
                regex = _TS_REGEX_RE.match(source, match.start())
                # After the ambiguous `)`/`}` a candidate holding a backtick is
                # a division whose span reached a template literal: fall
                # through to division rather than swallow the template opener.
                if regex is not None and ("`" not in regex.group() or not _ts_regex_ambiguous(last_kind, last_text)):
                    out.append(regex.group())
                    pos = regex.end()
                    last_kind, last_text = "value", regex.group()
                    continue
            out.append("/")
            last_kind, last_text = "op", "/"
            continue
        if kind == "string":
            out.append(text)
            last_kind, last_text = "value", text
            continue
        # plain: identifiers, numbers, operators, brackets and whitespace
        if expression_depths:
            expression_depths[-1] += text.count("{")
        out.append(text)
        if text.strip():
            last_kind, last_text = "plain", text
    if in_template or expression_depths:
        return source
    return "".join(out)


# Python: comments and bare string statements (docstrings) document, they do
# not execute. Strings that are part of an expression stay (a `python -c`
# source or a mock target names a real dependency). Brackets are counted so a
# string that starts a physical line inside a call is still an argument.
_PY_TOKEN_RE = re.compile(
    r"""
    (?P<string>'''(?:[^\\]|\\[\s\S])*?'''|\"\"\"(?:[^\\]|\\[\s\S])*?\"\"\"
             |'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*")
  | (?P<unterminated>['"])
  | (?P<comment>\#[^\n]*)
  | (?P<backslash>\\[\s\S]?)
  | (?P<plain>[^'"#\\]+)
    """,
    re.X,
)
_PY_STRING_PREFIX_RE = re.compile(r"^[rRbBuUfF]{0,2}$")
_PY_STATEMENT_END_RE = re.compile(r"[ \t]*(?:#|\r?\n|;|$)")


def _blank(text: str) -> str:
    return re.sub(r"[^\n]", " ", text)


def _mask_python(source: str) -> str:
    """Blank comments and bare string statements; keep line boundaries.

    Returns the raw source when the scan ends in an uncertain state.
    """
    out: list[str] = []
    pos = 0
    length = len(source)
    depth = 0
    if source.startswith("#!"):
        end = source.find("\n")
        end = length if end < 0 else end
        out.append(source[:end])
        pos = end
    while pos < length:
        match = _PY_TOKEN_RE.match(source, pos)
        if match is None:
            return source
        kind = match.lastgroup
        text = match.group()
        start = match.start()
        pos = match.end()
        if kind == "unterminated":
            return source
        if kind == "comment":
            out.append(_blank(text))
            continue
        if kind == "plain":
            depth += text.count("(") + text.count("[") + text.count("{")
            depth -= text.count(")") + text.count("]") + text.count("}")
            out.append(text)
            continue
        if kind == "backslash":
            out.append(text)
            continue
        # string
        bare = False
        if depth <= 0:
            line_start = source.rfind("\n", 0, start) + 1
            before = source[line_start:start]
            # A trailing backslash on the previous physical line continues
            # the statement onto this one (`x = \` newline `"..."`).
            continued = source[max(line_start - 3, 0):max(line_start - 1, 0)].rstrip("\r").endswith("\\")
            if _PY_STRING_PREFIX_RE.match(before.strip()) and not continued:
                bare = bool(_PY_STATEMENT_END_RE.match(source, pos))
        out.append(_blank(text) if bare else text)
    return "".join(out)


def strip_comments(rel: str, source: str, masked: str | None = None) -> str:
    """Drop comments (and process-pattern lines) before path scanning.

    A path named in a comment documents a relationship but executes nothing;
    following it transitively leaked whole packages into unrelated lanes.
    ``masked`` lets a caller pass an already comment-free Python text.
    """
    suffix = PurePosixPath(rel).suffix
    ts = suffix in TS_EXT
    tokenized = ts or suffix == ".py"
    if ts:
        # JSX text cannot be told from code without a full parser; keep those
        # files raw (over-selection) rather than risk erasing a dependency.
        if suffix not in {".tsx", ".jsx"}:
            source = _strip_ts_comments(source)
    elif suffix == ".py":
        source = masked if masked is not None else _mask_python(source)
    if tokenized and _PROCESS_MATCH.search(source) is None:
        return source
    marker = "//" if ts else "#"
    kept = []
    for line in source.splitlines():
        if _PROCESS_MATCH.search(line):
            continue
        if tokenized:
            kept.append(line)
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
        self._stripped: dict[str, str] = {}
        self._masked_python: dict[str, str] = {}

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

    def stripped(self, rel: str) -> str:
        """Comment-free text for path scanning (one tokenizer pass per file)."""
        if rel not in self._stripped:
            masked = self.masked_python(rel) if PurePosixPath(rel).suffix == ".py" else None
            self._stripped[rel] = strip_comments(rel, self.read(rel), masked)
        return self._stripped[rel]

    def masked_python(self, rel: str) -> str:
        """Python text with comments and docstrings blanked for import scanning."""
        if rel not in self._masked_python:
            self._masked_python[rel] = _mask_python(self.read(rel))
        return self._masked_python[rel]

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
        # Comments and docstrings are blanked first: an example `from x import y`
        # in documentation executes nothing and must not create an edge.
        source = self.masked_python(rel)
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
        if is_test_file(rel) and DIR_WALK_RE.search(self.stripped(rel)):
            top = rel.split("/", 1)[0]
            self.add_data(rel, f"dir:{top}")

    def path_edges(self, rel: str) -> None:
        """Path references: exec-context refs are transitive, others are data.

        `bash scripts/x.sh` / `python3 agents/y.py` runs the target with all
        of its imports (transitive edge). A path merely read, hashed or
        compared (readFileSync, a deployment file list) depends only on that
        file's own bytes (data edge: affected iff the target itself changed).
        """
        source = URL_RE.sub(" ", self.stripped(rel))
        here = str(PurePosixPath(rel).parent)
        pkg = package_root(rel)
        allow_dirs = is_test_support(rel)
        shell = PurePosixPath(rel).suffix in {".sh", ".bash", ""}
        copy_continuation = False
        for line in source.splitlines():
            # A plain snapshot copy reads bytes; it does not run each copied
            # module and its imports. Keep compound/substituted commands
            # conservative, including executable paths on the same line.
            copy_start = re.search(r"(?:^|&&|\|\||\bthen)\s*!?\s*(?:command\s+)?cp(?:\s|$)", line) if shell else None
            copy_tail = line[copy_start.end():] if copy_start else line
            copy_data = shell and (copy_continuation or copy_start is not None) and not re.search(r"\$\(|[<>]\(|`|[;&|]", copy_tail)
            copy_continuation = bool(copy_data and line.rstrip().endswith("\\"))
            if not PATH_HINT_RE.search(line):
                continue
            # Product code names repo scripts in help text and error messages;
            # only tests, scripts and shell are treated as executing them.
            exec_line = (shell and not copy_data) or (allow_dirs and bool(EXEC_LINE_RE.search(line)))
            # Commands chained before the copy (`./scripts/run-helper && cp ...`)
            # still execute: only the copy segment itself is a data read.
            exec_before = copy_start.start() if copy_data and copy_start else 0
            for token_match in PATH_TOKEN_RE.finditer(line):
                token = token_match.group(0)
                token_exec = exec_line or token_match.start() < exec_before
                stripped = token.lstrip("/")
                while stripped.startswith(("./", "../")):
                    stripped = stripped.split("/", 1)[1]
                stripped = stripped.rstrip("/.")
                if not stripped:
                    continue
                targets: list[str] = []
                name = stripped
                if "/" in stripped:
                    name = ""
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
                    resolved = bool(targets)
                    for i in range(len(parts) - 1 if not targets else 0):
                        tail = "/".join(parts[i:])
                        matches = self.by_suffix.get(tail, ()) or ([tail] if tail in self.fileset else [])
                        if 0 < len(matches) <= MAX_BASENAME_FANOUT:
                            targets.extend(matches)
                            resolved = True
                            break
                        if allow_dirs:
                            dmatches = self.dir_by_suffix.get(tail, ()) or ([tail] if tail in self.dirs else [])
                            if 0 < len(dmatches) <= MAX_BASENAME_FANOUT:
                                for d in dmatches:
                                    self.add_data(rel, f"dir:{d}")
                                resolved = True
                                break
                    if not resolved:
                        # `$SCRIPT_DIR/local-db-container.sh`: fall back to the basename.
                        name = parts[-1]
                if name and "." in name and not name.startswith("."):
                    matches = [m for m in self.by_basename.get(name, ()) if not m.startswith("docs/")]
                    if 0 < len(matches) <= MAX_BASENAME_FANOUT and name not in BASENAME_STOP:
                        targets.extend(matches)
                elif name and len(name) >= 6 and ("-" in name or "_" in name):
                    # Extensionless executables (`run-bench-fleet`) named alone.
                    matches = [m for m in self.by_basename.get(name, ()) if not m.startswith("docs/")]
                    if 0 < len(matches) <= 2:
                        targets.extend(matches)
                for cand in targets:
                    # A test naming a code path runs or loads it (directly, or after
                    # copying it into a fixture), so its imports count too.
                    runs_it = token_exec or is_test_file(rel)
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


# ------------------------------------------------------ new-test stability ---
# CLAUDE.md: "New tests must pass five consecutive runs with unchanged test code
# before being finalized." An idle devbox hides load-sensitive flakes (CPU steal,
# delayed /proc readability, background Git maintenance on Blacksmith runners),
# so every run executes while every CPU is occupied: nproc load slots, each one
# either a concurrently running stability unit or an owned busy CPU worker that
# this process starts and reaps by its exact PID. The digest of every unit root
# must be identical before and after the runs; any change makes the result
# UNVERIFIED.
#
# Granularity: where the lane's runner can name single cases (Python unittest
# scripts, pytest), only the added/changed test cases are rerun. A case is
# changed when an added line falls inside it or a removed line came from it; a
# change inside a test class outside its test methods (setUp, helpers, class
# attributes) reruns that class when nothing else subclasses or names it. Any
# other non-blank, non-comment change (module level, a new file, no diff
# information) reruns the whole unit: over-include, never under-include. Each unit's own runs stay consecutive; different units
# run concurrently.

STABILITY_RUNS = 5
# A proc-observation unit scans this user's whole /proc table and refuses on any same-user
# process it cannot read (a non-dumpable child: a browser sandbox, a setgid exec, a test fixture).
# Under the stability load every other lane is an arbitrary test, so such a unit runs alone:
# nothing launches beside it, and it waits for running units to drain. Other exclusive groups
# keep the structural runner's rule (never overlap each other, run beside everything else).
STABILITY_SOLO_GROUPS = frozenset({"proc-observation"})
STABILITY_RUN_TIMEOUT_SECONDS = 1200
STABILITY_LOAD_LOOP = (
    "import os, sys\n"
    "parent = int(sys.argv[1])\n"
    "while os.getppid() == parent:\n"
    "    pass\n"
)
# Lanes whose units the check can run with their owning runner. Any other lane is
# UNSUPPORTED, never PASS; mac-app off Darwin is PLATFORM_OMITTED (not a test pass).
STABILITY_LANES = ("deploy-structural-gates", "cloudbench-controller", "agents-pytest", "agents-blackbox",
                   "frontend-vitest", "backend-blackbox", "backend-unit", "backend-structural")
# Lanes that need a platform this host lacks (deploy_test_plan omits their gates the same way).
STABILITY_PLATFORM_LANES = {"mac-app-vitest": "darwin"}
WHOLE_UNIT = "<whole unit>"

# Backend DB lanes. back-end/.env's DATABASE_URL is the REMOTE production database, so every
# blackbox/unit stability unit gets its own empty database on this local server, created before
# its runs and dropped (exact owned name) after them. Concurrent units never share a database:
# the runner's test-db-run-lock fails fast on a second holder. Override the server with
# ROSE_STABILITY_PG_SERVER (it must be localhost).
STABILITY_PG_SERVER_ENV = "ROSE_STABILITY_PG_SERVER"
STABILITY_PG_SERVER_DEFAULT = "postgresql://postgres:postgres@localhost:5432"
# scripts/lib/workspace-env.sh: keep this unit's own identity even inside a prepared deploy
# worktree (whose .context/deploy-worktree.env would otherwise put every unit on one database).
STABILITY_IDENTITY_ENV = "ROSE_STABILITY_UNIT_IDENTITY"
STABILITY_DB_LANES = ("backend-blackbox", "backend-unit")
LOCAL_DB_HOSTS = ("localhost", "127.0.0.1", "::1")
# Ambient runner controls a unit must not inherit: a shared run id/artifact dir/port, an existing
# backend, an inherited lock, or a remote/opt-out database switch.
BACKEND_BLACKBOX_UNSET = (
    "BLACKBOX_TEST_RUN_ID", "CONTRACT_TEST_RUN_ID", "BLACKBOX_TEST_ARTIFACT_DIR", "CONTRACT_TEST_ARTIFACT_DIR",
    "BLACKBOX_TEST_BACKEND_PORT", "CONTRACT_TEST_BACKEND_PORT", "CONTRACT_TEST_BACKEND_START_PORT",
    "BLACKBOX_TEST_USE_EXISTING_BACKEND", "CONTRACT_TEST_USE_EXISTING_BACKEND", "TEST_BASE_URL",
    "BLACKBOX_TEST_SKIP_DB_SYNC", "CONTRACT_TEST_SKIP_DB_SYNC", "CONTRACT_TEST_DATABASE_URL",
    "ROSE_TEST_DB_LOCK_INHERITED_KEY", "ROSE_TEST_DB_LOCK_INHERITED_PID", "BENCHMARK_ISOLATED_RUN",
)
BACKEND_UNIT_UNSET = (
    "BACKEND_UNIT_ALLOW_REMOTE_DB", "BACKEND_UNIT_SHARD", "BACKEND_UNIT_EXCLUDE_FILES", "BACKEND_UNIT_COVERAGE_DIR",
    "BACKEND_UNIT_RESULTS_FILE", "NODE_V8_COVERAGE",
)
DB_SETUP_TIMEOUT_SECONDS = 600


def new_test_units(changed: list[str], lanes: dict[str, Lane] | None = None) -> list[Unit]:
    """Units whose own test files were added or changed (deleted files excluded)."""
    lanes = lanes if lanes is not None else discover_lanes()
    tests = {path for path in changed if is_test_file(path) and (ROOT / path).is_file()}
    units = []
    for lane in lanes.values():
        for unit in lane.units:
            if tests & set(unit.roots):
                units.append(unit)
    return units


@dataclass
class LineChanges:
    """A file's diff against the comparison base, in both coordinate systems."""
    added: set[int]          # 1-based line numbers in the new (run) source
    removed: set[int]        # 1-based line numbers in the old (base) source
    old_source: str | None   # None: the file is new
    new_source: str


_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", re.M)


def parse_unified_zero(diff: str) -> tuple[set[int], set[int]]:
    """(added new-side lines, removed old-side lines) from `git diff -U0` output."""
    added: set[int] = set()
    removed: set[int] = set()
    for match in _HUNK_RE.finditer(diff):
        old_start, old_count = int(match[1]), int(match[2] if match[2] is not None else 1)
        new_start, new_count = int(match[3]), int(match[4] if match[4] is not None else 1)
        removed.update(range(old_start, old_start + old_count))
        added.update(range(new_start, new_start + new_count))
    return added, removed


def _git_text(*args: str) -> str | None:
    proc = subprocess.run(["git", *args], cwd=ROOT, capture_output=True)
    return proc.stdout.decode("utf-8", "replace") if proc.returncode == 0 else None


def line_changes(path: str, base: str | None, head: str | None) -> LineChanges | None:
    """The test file's changed lines vs the merge base, for the bytes that will run.

    None means no trustworthy line information (the caller reruns the whole unit).
    """
    try:
        current = (ROOT / path).read_text()
    except (OSError, UnicodeDecodeError):
        return None
    if head:
        start = _git_text("merge-base", base, head) if base else _git_text("rev-parse", f"{head}^")
        new = _git_text("show", f"{head}:{path}")
        if start is None or new is None or new != current:
            return None  # the worktree is not the revision that was diffed
        start = start.strip()
        diff = _git_text("diff", "-U0", "--no-renames", start, head, "--", path)
    else:
        start = _git_text("merge-base", base or "origin/main", "HEAD")
        if start is None:
            return None
        start = start.strip()
        new = current
        diff = _git_text("diff", "-U0", "--no-renames", start, "--", path)
    if diff is None:
        return None
    old = _git_text("show", f"{start}:{path}")
    added, removed = parse_unified_zero(diff)
    if old is None and new:
        added = set(range(1, new.count("\n") + 2))
    return LineChanges(added, removed, old, new)


def _main_block_runs_unittest(tree: ast.Module) -> bool:
    """True when `__main__` hands argv to a plain unittest.main() (ids are honored)."""
    for node in tree.body:
        if not (isinstance(node, ast.If) and "__name__" in ast.unparse(node.test) and "__main__" in ast.unparse(node.test)):
            continue
        calls = [n for n in ast.walk(node) if isinstance(n, ast.Call)]
        mains = [c for c in calls if ast.unparse(c.func) == "unittest.main"]
        if len(mains) == 1 and not any(k.arg in ("argv", "defaultTest", "module") for k in mains[0].keywords) \
                and not mains[0].args:
            return True
    return False


@dataclass
class TestCases:
    """Addressable cases of one test file: methods/functions, and their enclosing classes."""
    cases: list[tuple[str, int, int]]                      # (id, first line, last line)
    classes: list[tuple[str, int, int, list[str]]]         # (class id, first, last, its case ids)


def python_test_cases(source: str, style: str, rel: str = "") -> TestCases | None:
    """The cases the runner can select by id, or None (the whole unit reruns).

    style "unittest": `Class.test_method` / `Class` for a script whose __main__ runs unittest.main().
    style "pytest": `rel::Class::test_x` / `rel::Class` / `rel::test_x` node ids.
    A class is addressable only when it is not subclassed and its name is not used
    outside its own body: then a change to its setUp/helpers/attributes reaches only it.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    if style == "unittest" and not _main_block_runs_unittest(tree):
        return None
    if style == "unittest":
        # argv consumed anywhere outside the __main__ block could reinterpret appended ids.
        guarded = {id(n) for g in tree.body if isinstance(g, ast.If) and "__main__" in ast.unparse(g.test)
                   for n in ast.walk(g)}
        if any(isinstance(n, ast.Attribute) and ast.unparse(n) == "sys.argv" and id(n) not in guarded
               for n in ast.walk(tree)):
            return None

    def span(node: ast.AST) -> tuple[int, int]:
        first = min([node.lineno] + [d.lineno for d in getattr(node, "decorator_list", [])])
        return first, node.end_lineno or node.lineno

    top_classes = [n for n in tree.body if isinstance(n, ast.ClassDef)]
    subclassed = {ast.unparse(base) for node in ast.walk(tree) if isinstance(node, ast.ClassDef) for base in node.bases}
    cases: list[tuple[str, int, int]] = []
    classes: list[tuple[str, int, int, list[str]]] = []
    class_names = {cls.name for cls in top_classes}
    name_uses: dict[str, list[int]] = defaultdict(list)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in class_names:
            name_uses[node.id].append(node.lineno)
    for cls in top_classes:
        if cls.name in subclassed or (style == "unittest" and not cls.bases):
            continue  # an inherited test runs under other ids; a base-less class is no TestCase
        if style == "pytest" and not cls.name.startswith("Test"):
            continue
        first, last = span(cls)
        used_elsewhere = any(not first <= line <= last for line in name_uses[cls.name])
        own = []
        for item in cls.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name.startswith("test"):
                case = f"{cls.name}.{item.name}" if style == "unittest" else f"{rel}::{cls.name}::{item.name}"
                cases.append((case, *span(item)))
                own.append(case)
        if own and not used_elsewhere:
            classes.append((cls.name if style == "unittest" else f"{rel}::{cls.name}", first, last, own))
    if style == "pytest":
        for item in tree.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name.startswith("test"):
                cases.append((f"{rel}::{item.name}", *span(item)))
    return TestCases(cases, classes)


def _inert_lines(source: str) -> set[int]:
    """Lines that are blank once comments and bare strings are masked (raw source if uncertain)."""
    masked = _mask_python(source)
    return {number for number, line in enumerate(masked.split("\n"), 1) if not line.strip()}


def changed_cases(new: TestCases | None, old: TestCases | None, changes: LineChanges | None) -> list[str] | None:
    """The case/class ids touched by `changes`, or None to rerun the whole unit.

    A line inside a test method selects that method; a line elsewhere inside an
    addressable class selects the whole class; a removed line of a case or class
    that no longer exists is a deleted test (nothing to rerun). Any other
    non-inert line (module level, an unaddressable class) selects the whole unit.
    """
    if new is None or old is None or changes is None or changes.old_source is None:
        return None
    present = {case for case, _, _ in new.cases} | {cls for cls, _, _, _ in new.classes}
    picked: set[str] = set()
    for lines, side, inert in ((changes.added, new, _inert_lines(changes.new_source)),
                               (changes.removed, old, _inert_lines(changes.old_source))):
        for line in lines:
            owner = next((case for case, first, last in side.cases if first <= line <= last), None)
            if owner is None and line in inert:
                continue  # a blank/comment line between definitions changes no behavior
            if owner is None:
                owner = next((cls for cls, first, last, _ in side.classes if first <= line <= last), None)
            if owner is None:
                return None  # a module-level, fixture or unaddressable-class change reaches every case
            if owner in present:
                picked.add(owner)
    if not picked:
        return None  # only inert edits: still rerun the unit rather than certify nothing
    # A selected class already runs its methods; do not run them twice.
    covered = {case for cls, _, _, own in new.classes if cls in picked for case in own}
    picked -= covered
    order = {ident: first for ident, first, _ in new.cases} | {cls: first for cls, first, _, _ in new.classes}
    return sorted(picked, key=lambda ident: order[ident])


BLACKBOX_CASE_FILTER_ENV = "BLACKBOX_CASE_FUNCTIONS"  # agents/tests/blackbox/_test_utils.py
BLACKBOX_CASE_RECEIPT_ENV = "BLACKBOX_CASE_RECEIPT"


def blackbox_test_cases(source: str) -> TestCases | None:
    """Agents blackbox test functions the BlackboxResult case filter can select.

    A module-level `test_*` function is addressable when run_all_tests() registers it
    directly (`r.record("name", fn)` / `await r.record_async("name", fn)`) and no other
    code names it. Its def and its registration statements are its line spans. None when
    run_all_tests() does not use BlackboxResult (the filter would be ignored).
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return None
    defs = {n.name: n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    run_all = defs.get("run_all_tests")
    if run_all is None or not any(isinstance(n, ast.Name) and n.id == "BlackboxResult" for n in ast.walk(run_all)):
        return None
    registrations: dict[str, list[tuple[int, int]]] = defaultdict(list)
    registration_names: set[int] = set()
    for stmt in ast.walk(run_all):
        if not isinstance(stmt, ast.Expr):
            continue
        call = stmt.value.value if isinstance(stmt.value, ast.Await) else stmt.value
        if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
                and call.func.attr in ("record", "record_async") and len(call.args) >= 2
                and isinstance(call.args[1], ast.Name)):
            continue
        name = call.args[1].id
        if name.startswith("test") and name in defs:
            registrations[name].append((stmt.lineno, stmt.end_lineno or stmt.lineno))
            registration_names.add(id(call.args[1]))
    uses: dict[str, list[ast.Name]] = defaultdict(list)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in registrations and id(node) not in registration_names:
            uses[node.id].append(node)
    cases: list[tuple[str, int, int]] = []
    for name, spans in registrations.items():
        node = defs[name]
        first = min([node.lineno] + [d.lineno for d in node.decorator_list])
        last = node.end_lineno or node.lineno
        elsewhere = any(not first <= use.lineno <= last for use in uses[name])
        if elsewhere:
            continue  # another case calls it: a change reaches that case too
        cases.append((name, first, last))
        cases.extend((name, a, b) for a, b in spans)
    return TestCases(cases, [])


def _structural_gate_options() -> dict[str, dict[str, str]]:
    """Keyword options of each structural Gate (the `exclusive` group, verbatim)."""
    tree = ast.parse(src().read("scripts/run-deploy-structural-gates.py"))
    options: dict[str, dict[str, str]] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Gate" and node.args \
                and isinstance(node.args[0], ast.Constant):
            options[node.args[0].value] = {k.arg: ast.unparse(k.value) for k in node.keywords if k.arg}
    return options


def _backend_structural_command(name: str) -> list[str] | None:
    """The unit's own `test:structural` step from back-end/package.json, runnable from back-end/."""
    script = json.loads(src().read("back-end/package.json"))["scripts"]["test:structural"]
    for part in script.split("&&"):
        tokens = part.split()
        files = [t for t in tokens if f"back-end/{t}" in src().fileset]
        if files and Path(files[0]).name == name:
            return ["npx", *tokens] if tokens[0] == "tsx" else tokens
    return None


def stability_command(unit: Unit) -> tuple[list[str], Path] | None:
    python = ROOT / "agents" / "venv" / "bin" / "python"
    agents_python = str(python) if python.exists() else sys.executable
    if unit.lane == "deploy-structural-gates":
        for name, args in _structural_gates():
            if name == unit.name and args:
                return list(args), ROOT
        return None
    if unit.lane == "cloudbench-controller":
        return unit.name.split(), ROOT
    if unit.lane == "agents-pytest":
        return [agents_python, "-m", "pytest", "-q", str(PurePosixPath(unit.name).relative_to("agents"))], ROOT / "agents"
    if unit.lane == "agents-blackbox":
        return [agents_python, "scripts/run_blackbox_tests.py", unit.name], ROOT / "agents"
    if unit.lane == "frontend-vitest":
        return ["npx", "vitest", "run", str(PurePosixPath(unit.name).relative_to("front-end"))], ROOT / "front-end"
    if unit.lane == "backend-blackbox":
        return ["bash", "scripts/run-blackbox-tests.sh", unit.name], ROOT / "back-end"
    if unit.lane == "backend-unit":
        # The file filter (BACKEND_UNIT_TEST_FILES) and its local database come from backend_isolation().
        return ["npx", "tsx", "scripts/run-unit-tests.ts"], ROOT / "back-end"
    if unit.lane == "backend-structural":
        command = _backend_structural_command(unit.name)
        return (command, ROOT / "back-end") if command else None
    return None


def local_database_url(server: str, database: str) -> str:
    """`server`/`database`, refusing anything but a localhost Postgres (never the remote DATABASE_URL)."""
    from urllib.parse import parse_qs, urlsplit
    parts = urlsplit(server)
    query = parse_qs(parts.query)
    if parts.scheme not in ("postgres", "postgresql") or parts.hostname not in LOCAL_DB_HOSTS \
            or "host" in query or "hostaddr" in query:
        raise ValueError(f"refusing a non-localhost stability database server ({parts.hostname or 'unparseable'})")
    if not re.fullmatch(r"victoria_[A-Za-z0-9][A-Za-z0-9_-]{0,53}", database):
        raise ValueError(f"refusing an unowned stability database name {database!r}")
    return f"{parts.scheme}://{parts.netloc}/{database}"


def assert_local_database_env(env: dict[str, str]) -> None:
    """Every database URL a backend unit receives must be localhost (checked again right before running)."""
    from urllib.parse import parse_qs, urlsplit
    for key in ("DATABASE_URL", "DIRECT_URL", "DIRECT_DATABASE_URL", "FAST_MODE_CACHE_DATABASE_URL",
                "BACKEND_UNIT_DATABASE_URL", "BLACKBOX_TEST_DATABASE_URL"):
        if key not in env:
            continue
        parts = urlsplit(env[key])
        query = parse_qs(parts.query)
        if parts.hostname not in LOCAL_DB_HOSTS or "host" in query or "hostaddr" in query:
            raise ValueError(f"refusing to run: {key} is not a localhost database ({parts.hostname or 'unparseable'})")


def backend_isolation(unit: Unit, identity: str, port: int, server: str | None = None) -> dict:
    """Per-unit env, unset list, owned database and schema preparation for a backend DB lane."""
    server = server or os.environ.get(STABILITY_PG_SERVER_ENV) or STABILITY_PG_SERVER_DEFAULT
    database = f"victoria_{identity}"
    url = local_database_url(server, database)
    if unit.lane == "backend-blackbox":
        # The runner takes its explicit database only when it is exactly victoria_<workspace>; it
        # pushes the schema itself under that database's run lock.
        env = {"ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME": "1", "CONDUCTOR_WORKSPACE_NAME": identity,
               STABILITY_IDENTITY_ENV: "1", "BLACKBOX_TEST_DATABASE_URL": url,
               "BLACKBOX_TEST_BACKEND_START_PORT": str(port)}
        return {"env": env, "unset": BACKEND_BLACKBOX_UNSET, "databases": [database], "server": server,
                "prepare": []}
    if unit.lane == "backend-unit":
        relative = str(PurePosixPath(unit.name).relative_to("back-end/src/tests/unit"))
        db_env = {"DATABASE_URL": url, "DIRECT_URL": url, "DIRECT_DATABASE_URL": url,
                  "FAST_MODE_CACHE_DATABASE_URL": url}
        env = {**db_env, "BACKEND_UNIT_DATABASE_URL": url, "BACKEND_UNIT_TEST_FILES": relative,
               "BACKEND_UNIT_CONCURRENCY": "1"}
        # The repo's safe local push (refuses non-localhost), then the runtime SQL hooks the
        # blackbox runner applies, so the unit sees the same schema as the coverage unit phase.
        prepare = [["npm", "run", "--silent", "prisma:push:local", "--", "--skip-generate", "--accept-data-loss"],
                   ["bash", "scripts/apply-local-runtime-sql-hooks.sh"]]
        return {"env": env, "unset": BACKEND_UNIT_UNSET, "databases": [database], "server": server,
                "prepare": prepare}
    raise ValueError(f"lane {unit.lane} has no database isolation")


@dataclass
class StabilityPlan:
    key: str
    command: list[str]
    cwd: Path
    cases: list[str]   # [WHOLE_UNIT] or the selected case ids
    reason: str
    exclusive: str = ""
    env: dict[str, str] = field(default_factory=dict)
    receipt: bool = False  # every selected case must report that it ran (blackbox case filter)
    unset: tuple[str, ...] = ()                         # ambient variables the unit must not inherit
    databases: list[str] = field(default_factory=list)  # owned local databases: created, then dropped
    server: str = ""                                    # their localhost Postgres server URL
    prepare: list[list[str]] = field(default_factory=list)  # schema setup, once, before the runs


def _is_python(executable: str) -> bool:
    return re.fullmatch(r"python(3(\.\d+)?)?", PurePosixPath(executable).name) is not None


def plan_unit(unit: Unit, changed: list[str], diff: Callable[[str], LineChanges | None] | None) -> StabilityPlan | None:
    """The command for `unit`, narrowed to its changed cases when the lane can name them."""
    planned = stability_command(unit) if unit.lane in STABILITY_LANES else None
    if planned is None:
        return None
    command, cwd = planned
    key = f"{unit.lane}:{unit.name}"
    exclusive = _structural_gate_options().get(unit.name, {}).get("exclusive", "") \
        if unit.lane == "deploy-structural-gates" else ""

    def whole(reason: str) -> StabilityPlan:
        return StabilityPlan(key, command, cwd, [WHOLE_UNIT], reason, exclusive)

    tests = sorted({path for path in changed if is_test_file(path) and path in unit.roots and (ROOT / path).is_file()})
    if diff is None:
        return whole("no diff base: changed lines unknown")
    if len(tests) != 1:
        return whole(f"{len(tests)} changed test files in the unit")
    test = tests[0]
    if unit.lane == "agents-pytest":
        style, rel = "pytest", str(PurePosixPath(test).relative_to("agents"))
        if command[-1] != rel:
            return whole("pytest target is not the changed file")
    elif unit.lane == "agents-blackbox":
        changes = diff(test)
        if changes is None or changes.old_source is None:
            return whole("new file or no line information")
        new_cases = blackbox_test_cases(changes.new_source)
        if new_cases is None or not new_cases.cases:
            return whole("run_all_tests() does not register cases through BlackboxResult")
        picked = changed_cases(new_cases, blackbox_test_cases(changes.old_source), changes)
        if picked is None:
            return whole("a change outside any single test case")
        return StabilityPlan(key, command, cwd, picked, "changed cases", exclusive,
                             env={BLACKBOX_CASE_FILTER_ENV: ",".join(picked)}, receipt=True)
    elif unit.lane in ("deploy-structural-gates", "cloudbench-controller") and test.endswith(".py") \
            and len(command) == 2 and _is_python(command[0]) and os.path.normpath(command[1]) == test:
        style, rel = "unittest", test
    else:
        return whole(f"lane {unit.lane} runner cannot select single cases here")
    changes = diff(test)
    if changes is None or changes.old_source is None:
        return whole("new file or no line information")
    new_cases = python_test_cases(changes.new_source, style, rel)
    if new_cases is None or not new_cases.cases:
        return whole("runner does not accept case ids")
    picked = changed_cases(new_cases, python_test_cases(changes.old_source, style, rel), changes)
    if picked is None:
        return whole("a change outside any single test case")
    if style == "pytest":
        return StabilityPlan(key, command[:-1] + picked, cwd, picked, "changed cases", exclusive)
    return StabilityPlan(key, command + picked, cwd, picked, "changed cases", exclusive)


def _roots_digest(units: list[Unit]) -> str:
    digest = hashlib.sha256()
    for root in sorted({r for unit in units for r in unit.roots}):
        digest.update(root.encode() + b"\0")
        try:
            digest.update((ROOT / root).read_bytes())
        except OSError:
            digest.update(b"<missing>")
        digest.update(b"\0")
    return digest.hexdigest()


class CpuLoad:
    """`workers` load slots, each a running stability lane or an owned busy CPU worker.

    Workers are started on enter and reaped by exact PID; `take()` hands one
    slot to a starting lane (stopping one worker) and `give()` returns it
    (starting a replacement), so lanes + live workers always fill every slot.
    stress-ng (bounded by --timeout) is used when installed; otherwise Python
    busy loops that also exit by themselves if this process dies.
    """

    def __init__(self, workers: int, bound_seconds: int) -> None:
        self.workers = workers
        self.bound_seconds = bound_seconds
        self.procs: list[subprocess.Popen] = []
        self.started: list[int] = []
        self.lanes = 0
        self.tool = ""
        self._lock = threading.RLock()

    def _spawn(self) -> None:
        quiet = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        stress = shutil.which("stress-ng")
        if stress:
            self.tool = "stress-ng"
            proc = subprocess.Popen([stress, "--cpu", "1", "--timeout", f"{self.bound_seconds}s", "--quiet"], **quiet)
        else:
            self.tool = "python-busy-loop"
            proc = subprocess.Popen([sys.executable, "-c", STABILITY_LOAD_LOOP, str(os.getpid())], **quiet)
        self.procs.append(proc)
        self.started.append(proc.pid)

    @staticmethod
    def _reap(proc: subprocess.Popen) -> None:
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    def __enter__(self) -> "CpuLoad":
        try:
            with self._lock:
                for _ in range(max(self.workers, 0)):
                    self._spawn()
        except BaseException:
            self.__exit__(None, None, None)
            raise
        return self

    def take(self) -> None:
        with self._lock:
            self.lanes += 1
            if self.procs and len(self.procs) + self.lanes > self.workers:
                self._reap(self.procs.pop())

    def give(self) -> None:
        with self._lock:
            self.lanes -= 1
            while len(self.procs) + self.lanes < self.workers:
                self._spawn()

    @property
    def pids(self) -> list[int]:
        return list(self.started)

    def alive(self) -> bool:
        with self._lock:
            live = all(proc.poll() is None for proc in self.procs)
            return self.workers <= 0 or (live and len(self.procs) + self.lanes >= self.workers)

    def __exit__(self, *_exc: object) -> None:
        with self._lock:
            for proc in self.procs:
                if proc.poll() is None:
                    proc.terminate()
            for proc in self.procs:
                self._reap(proc)


# The gate's own per-test channel (scripts/deploy_gate_progress.py). A rerun test must not inherit it:
# deploy-tooling tests start fake gate workers whose deliberate FAIL/FLAKY rows would otherwise land
# in the real gate's results (hunt round 4: a fixture's 'first' FAIL row opened a false /RCA). The
# stability check reports its own per-file rows.
GATE_CHANNEL_ENV = ("DEPLOY_GATE_PROGRESS", "DEPLOY_GATE_CASE", "DEPLOY_GATE_QUARANTINE_PROGRESS",
                    "DEPLOY_GATE_QUARANTINE_UNIT_PREFIX")


# A whole-unit rerun must never inherit a case filter; only its own plan may set one.
CASE_FILTER_ENV = (BLACKBOX_CASE_FILTER_ENV, BLACKBOX_CASE_RECEIPT_ENV)


def stability_environment(env: dict[str, str] | None = None) -> dict[str, str]:
    return {k: v for k, v in (os.environ if env is None else env).items()
            if k not in GATE_CHANNEL_ENV and k not in CASE_FILTER_ENV}


_RUNNING: dict[int, subprocess.Popen] = {}
_RUNNING_LOCK = threading.Lock()


def _run_once(command: list[str], cwd: Path, log: Path, timeout: float,
              extra_env: dict[str, str] | None = None, unset: tuple[str, ...] = ()) -> tuple[int | None, float]:
    started = time.monotonic()
    env = {k: v for k, v in stability_environment().items() if k not in unset}
    with log.open("wb") as handle:
        proc = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL, stdout=handle,
                                stderr=subprocess.STDOUT, start_new_session=True,
                                env={**env, **(extra_env or {})})
        with _RUNNING_LOCK:
            _RUNNING[proc.pid] = proc
        try:
            code: int | None = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            code = None
        finally:
            # The run owns exactly its own session; reap any descendants left behind.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            proc.wait()
            with _RUNNING_LOCK:
                _RUNNING.pop(proc.pid, None)
    return code, round(time.monotonic() - started, 2)


def _log_slug(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", key).strip("-")[-80:] or "unit"


def _admin_url(server: str) -> str:
    return f"{server.rstrip('/')}/postgres"


def _psql(server: str, statement: str, log: Path | None = None) -> bool:
    proc = subprocess.run(["psql", _admin_url(server), "-v", "ON_ERROR_STOP=1", "-qAtc", statement],
                          stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
    if log is not None:
        with log.open("ab") as handle:
            handle.write(f"$ psql {statement}\n".encode() + proc.stdout + proc.stderr)
    return proc.returncode == 0


def _prepare_databases(plan: StabilityPlan, stem: str, log_root: Path, created: list[str]) -> str:
    """Create the unit's owned databases and prepare their schema; '' on success, else the reason."""
    try:
        assert_local_database_env(plan.env)
    except ValueError as exc:
        return str(exc)
    log = log_root / f"{stem}-prepare.log"
    for name in plan.databases:
        if not re.fullmatch(r"victoria_[A-Za-z0-9][A-Za-z0-9_-]{0,53}", name):
            return f"refusing an unowned stability database name {name!r}"
        if not _psql(plan.server, f'CREATE DATABASE "{name}"', log):
            return f"could not create the local database {name} (see {log})"
        created.append(name)
    for step, command in enumerate(plan.prepare, 1):
        code, _ = _run_once(command, plan.cwd, log_root / f"{stem}-prepare{step}.log", DB_SETUP_TIMEOUT_SECONDS,
                            plan.env, plan.unset)
        if code != 0:
            return f"database setup step {' '.join(command)} exited {code} (see {stem}-prepare{step}.log)"
    return ""


def _drop_databases(server: str, created: list[str]) -> list[str]:
    """Drop exactly the databases this unit created, and their run-lock files; returns the dropped names."""
    dropped = []
    lock_dir = Path(os.environ.get("ROSE_TEST_DB_LOCK_DIR") or "/tmp/rose-test-db-locks")
    host = urlsplit_host_port(server)
    for name in created:
        try:
            if _psql(server, f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'):
                dropped.append(name)
        except (OSError, subprocess.SubprocessError):
            continue
        # back-end/scripts/test-db-run-lock.sh names its lock file after host:port/database.
        key = re.sub(r"[^A-Za-z0-9._-]", "_", f"{host}/{name}")
        for suffix in (".lock", ".lock.owner"):
            with contextlib.suppress(OSError):
                (lock_dir / f"{key}{suffix}").unlink()
    return dropped


def urlsplit_host_port(server: str) -> str:
    from urllib.parse import urlsplit
    parts = urlsplit(server)
    host = "localhost" if parts.hostname in LOCAL_DB_HOSTS else (parts.hostname or "")
    return f"{host}:{parts.port or 5432}"


def _run_plan(index: int, plan: StabilityPlan, runs: int, timeout: float, log_root: Path, load: CpuLoad) -> dict:
    attempts = []
    status = "PASS"
    gone = ""
    started = time.monotonic()
    # Name every file for its unit: a reader of the gate artifact finds a failing run's log
    # from the printed unit name, not an internal launch index.
    stem = f"{index:03d}-{_log_slug(plan.key)}"
    created: list[str] = []
    dropped: list[str] = []
    load.take()
    try:
        if plan.databases or plan.prepare:
            gone = _prepare_databases(plan, stem, log_root, created)
            if gone:
                status = "UNVERIFIED"
        for run in range(1, runs + 1) if not gone else ():
            if not log_root.is_dir():
                status, gone = "UNVERIFIED", f"log root {log_root} was deleted during the runs"
                break
            log = log_root / f"{stem}-run{run}.log"
            env = dict(plan.env)
            receipt = log_root / f"{stem}-run{run}.cases"
            if plan.receipt:
                env[BLACKBOX_CASE_RECEIPT_ENV] = str(receipt)
            code, seconds = _run_once(plan.command, plan.cwd, log, timeout, env, plan.unset)
            loaded = load.alive()
            attempt = {"run": run, "exit": code, "seconds": seconds, "log": str(log), "loaded": loaded}
            if plan.receipt and code == 0:
                ran = set(receipt.read_text().split()) if receipt.exists() else set()
                missing = sorted(set(plan.cases) - ran)
                if missing:
                    # A filtered run that skipped a selected case proves nothing about it.
                    attempt["exit"] = code = -1
                    attempt["missing_cases"] = missing
            attempts.append(attempt)
            if not loaded:
                status = "UNVERIFIED"
                break
            if code != 0:
                status = "FAIL"
                break
    finally:
        if created:
            dropped = _drop_databases(plan.server, created)
        load.give()
    row = {"status": status, "command": plan.command, "cwd": str(plan.cwd), "cases": plan.cases,
           "selection": plan.reason, "attempts": attempts,
           "consecutive_passes": sum(1 for a in attempts if a["exit"] == 0),
           "wall_seconds": round(time.monotonic() - started, 2)}
    if plan.databases:
        row["databases"] = {"created": created, "dropped": dropped}
        leftover = sorted(set(created) - set(dropped))
        if leftover:
            row["leftover_databases"] = leftover
    if gone:
        row["reason"] = gone
    elif status == "UNVERIFIED":
        row["reason"] = "a load slot was empty during the run"
    elif attempts and attempts[-1].get("missing_cases"):
        row["reason"] = f"selected case(s) did not run: {', '.join(attempts[-1]['missing_cases'])}"
    if plan.env:
        row["env"] = plan.env
    return row


def isolate_plan(plan: StabilityPlan, unit: Unit, index: int, server: str | None = None) -> StabilityPlan:
    """Give a backend DB-lane plan its own identity, port, database and schema setup."""
    if unit.lane not in STABILITY_DB_LANES:
        return plan
    identity = f"stab-{os.getpid()}-{index}-{os.urandom(3).hex()}"
    # A distinct start per unit; the runner still probes upward under its port locks.
    port = int(os.environ.get("CONDUCTOR_PORT") or 55000) + 100 + 10 * (index + 1)
    isolation = backend_isolation(unit, identity, port, server)
    plan.env = {**plan.env, **isolation["env"]}
    plan.unset = tuple(isolation["unset"])
    plan.databases = list(isolation["databases"])
    plan.server = isolation["server"]
    plan.prepare = [list(c) for c in isolation["prepare"]]
    return plan


def run_stability(units: list[Unit], runs: int = STABILITY_RUNS, load_workers: int | None = None,
                  timeout: float = STABILITY_RUN_TIMEOUT_SECONDS, log_root: Path | None = None,
                  changed: list[str] | None = None, diff: Callable[[str], LineChanges | None] | None = None,
                  lanes: int | None = None) -> dict:
    """Run each unit `runs` consecutive times; units run concurrently, every CPU slot loaded.

    `load_workers` is the number of load slots (default nproc); `lanes` caps concurrent
    units (default: one per slot). `diff` maps a changed test file to its LineChanges.
    """
    if runs < STABILITY_RUNS:
        raise ValueError(f"the new-test rule requires at least {STABILITY_RUNS} consecutive runs")
    workers = (os.cpu_count() or 1) if load_workers is None else load_workers
    lanes = max(1, min(workers, lanes if lanes is not None else workers))
    log_root = log_root or ROOT / ".context" / "new-test-stability" / time.strftime("%Y%m%dT%H%M%S")
    log_root.mkdir(parents=True, exist_ok=True)
    before = _roots_digest(units)
    began = time.monotonic()
    results: dict[str, dict] = {}
    pending: list[tuple[int, StabilityPlan]] = []
    for unit in units:
        key = f"{unit.lane}:{unit.name}"
        platform = STABILITY_PLATFORM_LANES.get(unit.lane)
        if platform and platform != sys.platform:
            # Same disposition as deploy_test_plan's omitted mac-app gates: nothing ran, nothing passed.
            results[key] = {"status": "PLATFORM_OMITTED", "platform": platform, "executed": False,
                            "reason": "platform not available; not a test pass"}
            continue
        plan = plan_unit(unit, changed if changed is not None else list(unit.roots), diff)
        if plan is None:
            results[key] = {"status": "UNSUPPORTED", "reason": f"lane {unit.lane} has no stability runner here"}
            continue
        try:
            plan = isolate_plan(plan, unit, len(pending))
        except ValueError as exc:
            results[key] = {"status": "UNVERIFIED", "reason": str(exc), "cases": plan.cases, "attempts": [],
                            "consecutive_passes": 0}
            continue
        pending.append((len(pending), plan))
    # Whole units first: they are the long poles of the wall clock.
    pending.sort(key=lambda item: (item[1].cases != [WHOLE_UNIT], item[0]))
    bound = int(timeout * runs * max(1, len(pending)) + 60)
    done = threading.Condition()
    running: dict[str, str] = {}  # key -> exclusive group
    threads: list[threading.Thread] = []
    with CpuLoad(workers, bound) as load:
        try:
            while pending or running:
                with done:
                    held = {group for group in running.values() if group}
                    launch = None
                    if len(running) < lanes and not held & STABILITY_SOLO_GROUPS:
                        for item in pending:
                            if item[1].exclusive in STABILITY_SOLO_GROUPS:
                                if not running:
                                    launch = item
                                break  # drain the lanes first; never start later units ahead of it
                            if not item[1].exclusive or item[1].exclusive not in held:
                                launch = item
                                break
                    if launch is None:
                        done.wait(timeout=1.0)
                        continue
                    pending.remove(launch)
                    index, plan = launch
                    running[plan.key] = plan.exclusive

                def work(index: int = index, plan: StabilityPlan = plan) -> None:
                    try:
                        row = _run_plan(index, plan, runs, timeout, log_root, load)
                    except BaseException as exc:  # recorded, never a silent PASS
                        row = {"status": "FAIL", "reason": f"stability runner error: {exc!r}", "cases": plan.cases,
                               "attempts": [], "consecutive_passes": 0}
                    with done:
                        results[plan.key] = row
                        running.pop(plan.key, None)
                        done.notify_all()

                thread = threading.Thread(target=work, name=f"stability-{index}", daemon=True)
                threads.append(thread)
                thread.start()
        finally:
            if pending or running:
                with _RUNNING_LOCK:
                    for proc in list(_RUNNING.values()):
                        try:
                            os.killpg(proc.pid, signal.SIGKILL)
                        except (ProcessLookupError, PermissionError):
                            pass
            for thread in threads:
                thread.join()
        load_record = {"workers": workers, "lanes": lanes, "tool": load.tool, "pids": load.pids}
    after = _roots_digest(units)
    if before != after:
        for row in results.values():
            if row["status"] == "PASS":
                row.update(status="UNVERIFIED", reason="test code changed during the stability runs")
    ordered = {f"{u.lane}:{u.name}": results[f"{u.lane}:{u.name}"] for u in units if f"{u.lane}:{u.name}" in results}
    for row in ordered.values():
        # Evidence must survive the runs: a rerun test that deletes the log root (or a log)
        # must not leave a PASS without its logs or a FAIL whose log silently vanished.
        lost = [a["log"] for a in row.get("attempts", []) if not Path(a["log"]).is_file()]
        if lost:
            row["missing_logs"] = lost
            note = f"{len(lost)} run log(s) missing after the runs (deleted under {log_root})"
            row["reason"] = f"{row['reason']}; {note}" if row.get("reason") else note
            if row["status"] == "PASS":
                row["status"] = "UNVERIFIED"
    statuses = {row["status"] for row in ordered.values()}
    # A platform-omitted unit neither passes nor blocks; it never counts as a PASS.
    verdicts = statuses - {"PLATFORM_OMITTED"}
    overall = ("FAIL" if "FAIL" in verdicts else "UNVERIFIED" if verdicts - {"PASS"}
               else "PASS" if verdicts else "PLATFORM_OMITTED")
    counts = {status: sum(1 for row in ordered.values() if row["status"] == status) for status in sorted(statuses)}
    report = {"status": overall, "counts": counts, "runs": runs, "load": load_record, "digest_before": before,
              "digest_after": after, "units": ordered, "logs": str(log_root),
              "wall_seconds": round(time.monotonic() - began, 2)}
    # The unit -> attempt -> log index travels with the logs into the gate artifact.
    log_root.mkdir(parents=True, exist_ok=True)
    (log_root / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


# ------------------------------------------------------------------- cli ---

def changed_files(base: str | None, head: str | None) -> list[str]:
    def git(*args: str) -> list[str]:
        out = subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout
        return [line for line in out.splitlines() if line]

    if head:
        revisions = [f"{base}...{head}"] if base else [f"{head}^", head]
        changed = set(git("diff", "--no-renames", "--name-only", *revisions))
        return sorted(path for path in changed if not path.startswith(EXCLUDED_TOP))
    base = base or "origin/main"
    files = set(git("diff", "--no-renames", "--name-only", f"{base}...HEAD"))
    files |= set(git("diff", "--no-renames", "--name-only", "HEAD"))
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


def _terminate(_signum: int, _frame: object) -> None:
    raise SystemExit(143)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--changed-file", action="append", default=[])
    parser.add_argument("--changed-files-from")
    parser.add_argument("--format", default="report")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--rev", help="map the tree of this revision instead of the worktree (history replay)")
    parser.add_argument("--stability", action="store_true",
                        help="run every added/changed test case (or its whole unit) --stability-runs consecutive times under CPU load")
    parser.add_argument("--stability-runs", type=int, default=STABILITY_RUNS)
    parser.add_argument("--load-workers", type=int,
                        help="load slots kept busy during the runs: concurrent units plus busy CPU workers (default: nproc)")
    parser.add_argument("--stability-lanes", type=int,
                        help="units run concurrently (default and maximum: the load slots)")
    parser.add_argument("--stability-timeout", type=float, default=STABILITY_RUN_TIMEOUT_SECONDS,
                        help="per-run seconds (the suite's own deadline still applies inside)")
    args = parser.parse_args(argv)
    if args.stability:
        if args.stability_runs < STABILITY_RUNS:
            parser.error(f"--stability-runs must be at least {STABILITY_RUNS}")
        if args.load_workers is not None and args.load_workers < 1:
            parser.error("--load-workers must be positive; the check always runs under load")
        if args.stability_lanes is not None and args.stability_lanes < 1:
            parser.error("--stability-lanes must be positive")
        changed = list(args.changed_file)
        if args.changed_files_from:
            changed += [line.strip() for line in Path(args.changed_files_from).read_text().splitlines() if line.strip()]
        if not changed:
            changed = changed_files(args.base, args.head)
        units = new_test_units(changed)
        if not units:
            print("new-test stability: no added or changed test units")
            return 0
        # A TERM (gate timeout/cancel) unwinds run_stability so every running unit's own
        # session and every owned load worker is reaped instead of being orphaned.
        signal.signal(signal.SIGTERM, _terminate)
        # Case narrowing needs the diff; an explicit file list without --base reruns whole units.
        explicit = bool(args.changed_file or args.changed_files_from)
        diff = None if explicit and not args.base else (lambda path: line_changes(path, args.base, args.head))
        report = run_stability(units, args.stability_runs, args.load_workers, args.stability_timeout,
                               changed=changed, diff=diff, lanes=args.stability_lanes)
        if args.format == "json":
            print(json.dumps(report, indent=2))
        else:
            load = report["load"]
            tally = ", ".join(f"{n} {status}" for status, n in report["counts"].items())
            print(f"new-test stability: {report['status']} [{tally}] ({report['runs']} consecutive runs per unit, "
                  f"{load['lanes']} concurrent lanes, {load['workers']} load slots topped up with "
                  f"{load['tool'] or 'no'} workers, wall {report['wall_seconds']:.0f}s, logs {report['logs']})")
            for key, row in report["units"].items():
                passes = row.get("consecutive_passes", 0)
                cases = row.get("cases") or []
                scope = "whole unit" if cases == [WHOLE_UNIT] else f"{len(cases)} case(s)"
                wall = f" {row['wall_seconds']:.0f}s" if "wall_seconds" in row else ""
                print(f"  {row['status']:11s} {key} {passes}/{report['runs']}{wall} [{scope}] "
                      f"{row.get('reason', '')}".rstrip())
                if cases and cases != [WHOLE_UNIT]:
                    for case in cases:
                        print(f"      {case}")
                attempts = row.get("attempts") or []
                if row["status"] != "PASS" and attempts:
                    print(f"      log {attempts[-1]['log']}")
        return {"PASS": 0, "PLATFORM_OMITTED": 0, "FAIL": 1}.get(report["status"], 2)
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
    if not args.changed_file and not args.changed_files_from:
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
