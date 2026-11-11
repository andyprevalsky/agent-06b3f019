"""Code-capability benchmark fixtures and evaluators (rose-bench ``code-bench-*``).

Each fixture under ``fixtures/code_bench/<id>/`` is a small self-contained repo:

  fixture.json   task text, hidden-test commands and optional git/screenshot checks
  repo/          the starting repository (committed once, deterministically)
  hidden/        tests the agent never sees; copied in as ``_hidden_tests/`` at grading
  reference/     a known-good overlay used only by the evaluator proofs

Data path (identical for Rose and for the raw CLI parity leg):

  build_fixture_archive()  -> <id>.tar.gz  (<id>/repo [+ <id>/origin.git])
        |  Rose: uploaded as a task attachment -> /home/user/attachments in the E2B sandbox
        |  raw CLI: copied to <sandbox>/attachments
        v
  agent edits <id>/repo, writes <output>/result.tar.gz
        |  Rose: returned as a file_pointer in Task Complete outputs
        v
  evaluate_archive_bytes()  -> extract (safe), locate repo by marker, git checks,
                               unchanged files, required patterns, then run the
                               visible + hidden test commands in a scratch copy.

The grading commands execute agent-written code. They run in a scratch copy
with a minimal environment (no inherited secrets), a per-command timeout and
their own process group, which is killed on timeout.
"""

from __future__ import annotations

import base64
import contextlib
import functools
import gzip
import hashlib
import http.server
import io
import json
import os
import re
import shutil
import signal
import socketserver
import subprocess
import tarfile
import tempfile
import threading
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable, Optional

FIXTURES_ROOT = Path(__file__).resolve().parent / "fixtures" / "code_bench"
ATTACHMENT_PREFIX = "code-bench/"
ARCHIVE_SUFFIX = ".tar.gz"
MARKER_FILE = ".codebench-fixture"
RESULT_ARCHIVE = "result.tar.gz"
HIDDEN_DIR_NAME = "_hidden_tests"
ROSE_ATTACHMENTS_DIR = "/home/user/attachments"
ROSE_OUTPUT_DIR = "/home/user/output"
STATIC_CHECK_TYPE = "code_bench_hidden_tests"
SCREENSHOT_METHOD = "code_bench_screenshot_judge"
TASK_NAME_PREFIX = "code-bench-"
STATE_KEY = "code_bench"

COMMAND_TIMEOUT_SECONDS = 120
MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 20_000
_FIXED_EPOCH = 1767225600  # 2026-01-01T00:00:00Z
_GIT_DATE = "2026-01-01T00:00:00+0000"
_DEFAULT_GITIGNORE = "__pycache__/\n*.pyc\nnode_modules/\n"
_SCREENSHOT_JUDGE_MODEL = "rose-labs/rose-1-ultra"


@dataclass(frozen=True)
class Fixture:
    id: str
    kind: str
    language: str
    task: str
    root: Path
    commands: tuple[tuple[str, ...], ...]
    hidden_dir: str = "hidden"
    remote: bool = False
    git: dict = field(default_factory=dict)
    required_patterns: tuple[dict, ...] = ()
    unchanged_files: tuple[str, ...] = ()
    screenshot: Optional[dict] = None

    @property
    def repo_dir(self) -> Path:
        return self.root / "repo"

    @property
    def reference_dir(self) -> Path:
        return self.root / "reference"


# ---------------------------------------------------------------------------
# Fixture loading and task text
# ---------------------------------------------------------------------------


def fixture_ids() -> list[str]:
    return sorted(p.name for p in FIXTURES_ROOT.iterdir() if (p / "fixture.json").is_file())


@functools.lru_cache(maxsize=None)
def load_fixture(fixture_id: str) -> Fixture:
    root = FIXTURES_ROOT / fixture_id
    raw = json.loads((root / "fixture.json").read_text())
    if raw.get("id") != fixture_id:
        raise ValueError(f"{root}/fixture.json id {raw.get('id')!r} does not match its directory")
    hidden = raw.get("hidden_tests") or {}
    commands = tuple(tuple(str(part) for part in cmd) for cmd in hidden.get("commands") or [])
    if not commands:
        raise ValueError(f"{fixture_id}: hidden_tests.commands must be non-empty")
    for name in ("task", "kind", "language"):
        if not isinstance(raw.get(name), str) or not raw[name].strip():
            raise ValueError(f"{fixture_id}: {name} must be a non-empty string")
    return Fixture(
        id=fixture_id,
        kind=raw["kind"],
        language=raw["language"],
        task=raw["task"],
        root=root,
        commands=commands,
        hidden_dir=str(hidden.get("dir") or "hidden"),
        remote=bool(raw.get("remote")),
        git=dict(raw.get("git") or {}),
        required_patterns=tuple(raw.get("required_patterns") or ()),
        unchanged_files=tuple(raw.get("unchanged_files") or ()),
        screenshot=raw.get("screenshot"),
    )


def archive_name(fixture_id: str) -> str:
    return f"{fixture_id}{ARCHIVE_SUFFIX}"


def attachment_ref(fixture_id: str) -> str:
    """The tasks.json ``attachments`` entry that materializes this fixture."""
    return f"{ATTACHMENT_PREFIX}{archive_name(fixture_id)}"


def render_code_task(fixture: Fixture, attachments_dir: str, output_dir: str) -> str:
    """The code-agent instructions. Rose and the raw CLI get the same text; only paths differ."""
    archive = f"{attachments_dir.rstrip('/')}/{archive_name(fixture.id)}"
    output = f"{output_dir.rstrip('/')}/{RESULT_ARCHIVE}"
    layout = f"the repository is {fixture.id}/repo"
    if fixture.remote:
        layout += f" and its remote origin is the bare repository {fixture.id}/origin.git next to it"
    return (
        f"The archive {archive} contains a git repository. Extract it into a working directory "
        f"(tar -xzf {archive}); {layout}.\n\n"
        f"{fixture.task}\n\n"
        f"Work only inside {fixture.id}/. When you are done, package the whole {fixture.id} directory, "
        f"including .git, as {output} (run tar -czf {output} {fixture.id} from the directory you "
        "extracted into). Do not ask questions."
    )


def rose_prompt(fixture: Fixture) -> str:
    """Root-agent prompt for the Rose leg (catalog ``prompt``)."""
    return (
        "Use exactly one code agent (spawn_claude_code_agent) for this task and pass it the attached "
        f"archive {archive_name(fixture.id)}. Do not use browser or explore agents and do not write the "
        "code yourself. Give the code agent these instructions verbatim:\n\n<<<\n"
        f"{render_code_task(fixture, ROSE_ATTACHMENTS_DIR, ROSE_OUTPUT_DIR)}\n>>>\n\n"
        f"When the code agent finishes, return its {RESULT_ARCHIVE} as the result_archive file_pointer "
        "in your structured output."
    )


def fixture_id_for_task(task_name: str) -> str:
    if not task_name.startswith(TASK_NAME_PREFIX):
        raise ValueError(f"{task_name} is not a code-bench task")
    return task_name[len(TASK_NAME_PREFIX) :]


# ---------------------------------------------------------------------------
# Deterministic fixture archive
# ---------------------------------------------------------------------------


def _git_env(home: Path) -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_AUTHOR_NAME": "Code Bench",
        "GIT_AUTHOR_EMAIL": "code-bench@roselabs.ai",
        "GIT_COMMITTER_NAME": "Code Bench",
        "GIT_COMMITTER_EMAIL": "code-bench@roselabs.ai",
        "GIT_AUTHOR_DATE": _GIT_DATE,
        "GIT_COMMITTER_DATE": _GIT_DATE,
        "LANG": "C.UTF-8",
    }


def _git(args: list[str], cwd: Path, env: dict[str, str]) -> str:
    result = subprocess.run(
        # Auto maintenance runs detached after commits and creates/removes .git lock files while the
        # workspace is archived (code_bench_test FileNotFoundError on objects/maintenance.lock).
        # Disable it, and keep any maintenance that still runs (explicit or receive-side) in the foreground.
        ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
         "-c", "maintenance.auto=false", "-c", "gc.auto=0",
         "-c", "gc.autoDetach=false", "-c", "maintenance.autoDetach=false", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed in {cwd}: {result.stderr.strip()[:500]}")
    return result.stdout.strip()


def build_workspace(fixture: Fixture, parent: Path, files_from: Optional[Path] = None) -> dict[str, str]:
    """Create ``parent/<id>/repo`` (+ ``origin.git``) as one deterministic commit.

    ``files_from`` defaults to the fixture's starting repo. Returns ``base_sha``.
    """
    top = parent / fixture.id
    repo = top / "repo"
    shutil.copytree(files_from or fixture.repo_dir, repo, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    (repo / MARKER_FILE).write_text(fixture.id + "\n")
    if not (repo / ".gitignore").exists():
        (repo / ".gitignore").write_text(_DEFAULT_GITIGNORE)
    env = _git_env(parent)
    _git(["init", "-q", "-b", "main"], repo, env)
    _git(["config", "user.name", "Code Bench Agent"], repo, env)
    _git(["config", "user.email", "agent@code-bench.invalid"], repo, env)
    _git(["add", "-A"], repo, env)
    _git(["commit", "-q", "-m", "Initial fixture import"], repo, env)
    base_sha = _git(["rev-parse", "HEAD"], repo, env)
    if fixture.remote:
        origin = top / "origin.git"
        _git(["clone", "-q", "--bare", "--no-hardlinks", str(repo), str(origin)], parent, env)
        # The bare clone records the build directory as its own origin; drop it so
        # the archive carries no host path and stays byte-identical across builds.
        _git(["--git-dir", str(origin), "remote", "remove", "origin"], parent, env)
        # A push into origin.git runs receive-pack's auto maintenance on the receiving
        # side, where `-c` options never reach; git >= 2.47 detaches it, so its
        # maintenance.lock could be written while the result archive is captured.
        _git(["--git-dir", str(origin), "config", "receive.autogc", "false"], parent, env)
        _git(["remote", "add", "origin", "../origin.git"], repo, env)
        _git(["fetch", "-q", "origin"], repo, env)
        _git(["branch", "-q", "--set-upstream-to=origin/main", "main"], repo, env)
    normalize_git_index(repo / ".git" / "index")
    return {"base_sha": base_sha}


_INDEX_ENTRY_FIXED = 62  # stat (40) + sha1 (20) + flags (2)


def normalize_git_index(index_path: Path) -> None:
    """Zero the host-specific stat data in a v2/v3 git index.

    The index caches ctime/mtime/dev/inode/uid/gid of the build checkout, which
    made every fixture archive differ. Entries keep their mode, size, blob id and
    path; mtimes become the archive's fixed epoch (the extracted files' mtime), so
    git re-validates content on first use and reports a clean tree.
    """
    data = bytearray(index_path.read_bytes())
    if data[:4] != b"DIRC":
        raise ValueError(f"{index_path} is not a git index")
    version = int.from_bytes(data[4:8], "big")
    if version not in (2, 3):
        raise ValueError(f"{index_path}: unsupported git index version {version}")
    count = int.from_bytes(data[8:12], "big")
    offset = 12
    for _ in range(count):
        stat = bytearray(40)
        stat[0:4] = _FIXED_EPOCH.to_bytes(4, "big")  # ctime seconds
        stat[8:12] = _FIXED_EPOCH.to_bytes(4, "big")  # mtime seconds
        stat[24:28] = data[offset + 24 : offset + 28]  # mode
        stat[36:40] = data[offset + 36 : offset + 40]  # size
        data[offset : offset + 40] = stat
        flags = int.from_bytes(data[offset + 60 : offset + 62], "big")
        header = _INDEX_ENTRY_FIXED + (2 if version == 3 and flags & 0x4000 else 0)
        path_end = data.index(b"\0", offset + header)
        entry_len = path_end - offset + 1
        offset += (entry_len + 7) // 8 * 8
    body = bytes(data[:-20])
    index_path.write_bytes(body + hashlib.sha1(body).digest())


def _tar_reset(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    info.mtime = _FIXED_EPOCH
    return info


def write_deterministic_tar_gz(parent: Path, top_name: str, out_path: Path) -> Path:
    paths = [parent / top_name]
    for dirpath, dirnames, filenames in os.walk(parent / top_name):
        dirnames.sort()
        paths.extend(Path(dirpath) / d for d in dirnames)
        paths.extend(Path(dirpath) / f for f in sorted(filenames))
    paths = sorted(set(paths), key=lambda p: p.relative_to(parent).as_posix())
    with open(out_path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
            for path in paths:
                tar.add(path, arcname=path.relative_to(parent).as_posix(), recursive=False, filter=_tar_reset)
    return out_path


def build_fixture_archive(fixture_id: str, dest_dir: Path) -> Path:
    """Write ``dest_dir/<id>.tar.gz`` and return its path."""
    fixture = load_fixture(fixture_id)
    dest_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="code-bench-build-") as tmp:
        build_workspace(fixture, Path(tmp))
        return write_deterministic_tar_gz(Path(tmp), fixture.id, dest_dir / archive_name(fixture.id))


def resolve_attachment(name: str, dest_dir: Path) -> Optional[Path]:
    """Materialize a ``code-bench/<id>.tar.gz`` attachment; None for ordinary assets."""
    if not name.startswith(ATTACHMENT_PREFIX):
        return None
    filename = name[len(ATTACHMENT_PREFIX) :]
    if not filename.endswith(ARCHIVE_SUFFIX):
        raise ValueError(f"code-bench attachment must end with {ARCHIVE_SUFFIX}: {name}")
    return build_fixture_archive(filename[: -len(ARCHIVE_SUFFIX)], dest_dir)


@functools.lru_cache(maxsize=None)
def base_sha(fixture_id: str) -> str:
    with tempfile.TemporaryDirectory(prefix="code-bench-base-") as tmp:
        return build_workspace(load_fixture(fixture_id), Path(tmp))["base_sha"]


# ---------------------------------------------------------------------------
# Grading
# ---------------------------------------------------------------------------


@dataclass
class Step:
    name: str
    ok: bool
    detail: str = ""

    def as_dict(self) -> dict:
        return {"name": self.name, "ok": self.ok, "detail": self.detail}


def safe_extract(data: bytes, filename: str, dest: Path) -> None:
    """Extract a tar(.gz) or zip archive without path traversal, links out or devices."""
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError(f"archive is {len(data)} bytes; limit {MAX_ARCHIVE_BYTES}")
    lower = filename.lower()
    if lower.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            members = zf.infolist()
            if len(members) > MAX_ARCHIVE_MEMBERS:
                raise ValueError("archive has too many members")
            root = dest.resolve()
            for member in members:
                target = (dest / member.filename).resolve()
                if root not in target.parents and target != root:
                    raise ValueError(f"unsafe zip member {member.filename!r}")
            zf.extractall(dest)
        return
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tar:
        members = tar.getmembers()
        if len(members) > MAX_ARCHIVE_MEMBERS:
            raise ValueError("archive has too many members")
        tar.extractall(dest, filter="data")


def locate_repo(root: Path, fixture_id: str) -> Optional[Path]:
    """Shallowest directory whose marker names this fixture."""
    candidates = []
    for marker in root.rglob(MARKER_FILE):
        with contextlib.suppress(OSError, UnicodeDecodeError):
            if marker.is_file() and marker.read_text().strip() == fixture_id:
                candidates.append(marker.parent)
    if not candidates:
        return None
    return min(candidates, key=lambda p: (len(p.relative_to(root).parts), str(p)))


def _git_steps(fixture: Fixture, repo: Path, scratch_home: Path) -> list[Step]:
    spec = fixture.git
    if not spec:
        return []
    env = _git_env(scratch_home)
    safe = ["-c", f"safe.directory={repo}"]
    steps: list[Step] = []
    base = base_sha(fixture.id)
    try:
        head = _git([*safe, "rev-parse", "HEAD"], repo, env)
    except RuntimeError as exc:
        return [Step("git.head", False, f"repository has no readable HEAD: {exc}")]
    if spec.get("base_is_ancestor"):
        result = subprocess.run(
            ["git", *safe, "merge-base", "--is-ancestor", base, head],
            cwd=repo,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        steps.append(Step("git.base_is_ancestor", result.returncode == 0, f"base {base[:12]} -> HEAD {head[:12]}"))
    min_new = spec.get("min_new_commits")
    if min_new is not None:
        try:
            count = int(_git([*safe, "rev-list", "--count", f"{base}..{head}"], repo, env))
        except (RuntimeError, ValueError) as exc:
            count, detail = 0, f"cannot count commits: {exc}"
        else:
            detail = f"{count} new commit(s) on top of the fixture base"
        steps.append(Step("git.new_commits", count >= int(min_new), detail))
    if spec.get("clean_worktree"):
        status = _git([*safe, "status", "--porcelain", "--untracked-files=all"], repo, env)
        steps.append(Step("git.clean_worktree", not status, status[:400] or "clean"))
    if spec.get("origin_unchanged"):
        steps.append(_origin_unchanged_step(fixture, repo, env, base))
    return steps


def _origin_unchanged_step(fixture: Fixture, repo: Path, env: dict[str, str], base: str) -> Step:
    origin = (repo.parent / "origin.git").resolve()
    if not origin.is_dir():
        return Step("git.origin_unchanged", False, "origin.git is missing from the result; cannot verify no push")
    try:
        refs = _git(
            [
                "-c",
                f"safe.directory={origin}",
                "--git-dir",
                str(origin),
                "for-each-ref",
                "--format=%(refname) %(objectname)",
            ],
            repo,
            env,
        )
    except RuntimeError as exc:
        return Step("git.origin_unchanged", False, str(exc))
    observed = dict(line.split(" ", 1) for line in refs.splitlines() if line.strip())
    expected = {"refs/heads/main": base}
    return Step("git.origin_unchanged", observed == expected, f"origin refs: {observed}")


def _minimal_env(home: Path) -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home),
        "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "NODE_NO_WARNINGS": "1",
        "CI": "1",
    }


def _run_command(cmd: tuple[str, ...], cwd: Path, home: Path, timeout: int) -> tuple[int, str]:
    proc = subprocess.Popen(
        list(cmd),
        cwd=cwd,
        env=_minimal_env(home),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
    )
    try:
        out, _ = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
        out, _ = proc.communicate()
        return -9, f"timed out after {timeout}s\n{(out or '')[-1500:]}"
    return proc.returncode, (out or "")[-1500:]


def evaluate_repo(
    fixture: Fixture,
    repo: Path,
    *,
    timeout: int = COMMAND_TIMEOUT_SECONDS,
    capture_screenshot: bool = False,
) -> dict[str, Any]:
    """Grade one repository directory. Never mutates ``repo``."""
    steps: list[Step] = []
    with tempfile.TemporaryDirectory(prefix="code-bench-grade-") as tmp:
        scratch = Path(tmp)
        home = scratch / "home"
        home.mkdir()
        steps.extend(_git_steps(fixture, repo, home))
        for rel in fixture.unchanged_files:
            original = fixture.repo_dir / rel
            current = repo / rel
            same = current.is_file() and current.read_bytes() == original.read_bytes()
            steps.append(Step(f"unchanged:{rel}", same, "identical" if same else "modified or missing"))
        for pattern in fixture.required_patterns:
            regex = re.compile(pattern["pattern"])
            matched = [
                p.relative_to(repo).as_posix()
                for p in sorted(repo.glob(pattern["glob"]))
                if p.is_file() and regex.search(p.read_text(errors="replace"))
            ]
            need = int(pattern.get("min_files", 1))
            steps.append(
                Step(
                    f"pattern:{pattern['glob']}~{pattern['pattern']}",
                    len(matched) >= need,
                    f"{pattern.get('description', '')} matched={matched}".strip(),
                )
            )
        work = scratch / "work"
        shutil.copytree(repo, work, symlinks=True, ignore=shutil.ignore_patterns(".git", "node_modules"))
        hidden_dest = work / HIDDEN_DIR_NAME
        if hidden_dest.exists():
            shutil.rmtree(hidden_dest)
        shutil.copytree(fixture.root / fixture.hidden_dir, hidden_dest)
        if fixture.language == "python":
            (hidden_dest / "__init__.py").touch()
        for cmd in fixture.commands:
            code, output = _run_command(cmd, work, home, timeout)
            steps.append(Step("run:" + " ".join(cmd), code == 0, f"exit={code}\n{output}"))
        passed = all(step.ok for step in steps)
        result: dict[str, Any] = {
            "fixture": fixture.id,
            "passed": passed,
            "reason": _summarize(steps),
            "steps": [step.as_dict() for step in steps],
        }
        if capture_screenshot and passed and fixture.screenshot:
            try:
                result["screenshot_b64"] = base64.b64encode(render_screenshot(repo, fixture.screenshot)).decode()
            except Exception as exc:
                result["screenshot_error"] = f"{type(exc).__name__}: {exc}"[:500]
        return result


def _summarize(steps: list[Step]) -> str:
    failed = [step for step in steps if not step.ok]
    if not failed:
        return f"All {len(steps)} code-bench checks passed"
    first = failed[0]
    detail = first.detail.strip().splitlines()
    tail = " | ".join(detail[-6:])[:600]
    return f"{len(failed)}/{len(steps)} code-bench checks failed; first: {first.name}: {tail}"


def evaluate_archive_bytes(
    fixture: Fixture,
    data: bytes,
    filename: str,
    *,
    timeout: int = COMMAND_TIMEOUT_SECONDS,
    capture_screenshot: bool = False,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="code-bench-extract-") as tmp:
        root = Path(tmp)
        try:
            safe_extract(data, filename, root)
        except Exception as exc:
            return {"fixture": fixture.id, "passed": False, "reason": f"could not extract {filename}: {exc}"[:600]}
        repo = locate_repo(root, fixture.id)
        if repo is None:
            return {
                "fixture": fixture.id,
                "passed": False,
                "reason": f"{filename} does not contain the {fixture.id} repository ({MARKER_FILE} marker missing)",
            }
        result = evaluate_repo(fixture, repo, timeout=timeout, capture_screenshot=capture_screenshot)
        result["archive"] = filename
        return result


def _archive_candidates(pointers: Iterable[dict]) -> list[dict]:
    exts = (".tar.gz", ".tgz", ".tar", ".zip")
    ranked = [p for p in pointers if str(p.get("original_filename") or "").lower().endswith(exts)]
    return sorted(ranked, key=lambda p: str(p.get("original_filename")) != RESULT_ARCHIVE)


async def _default_download(pointer: dict) -> bytes:
    from helpers.attachments import FilePointer, get_file_content

    return await get_file_content(FilePointer.from_dict(pointer))


async def hydrate(
    data: dict,
    fixture_ids_needed: Iterable[str],
    pointers: list[dict],
    *,
    download: Optional[Callable[[dict], Awaitable[bytes]]] = None,
    capture_screenshot: bool = False,
) -> None:
    """Grade the returned archive once per fixture into ``data['_benchmark']['code_bench']``."""
    import asyncio

    state = data.setdefault("_benchmark", {}).setdefault(STATE_KEY, {})
    download = download or _default_download
    candidates = _archive_candidates(pointers)
    for fixture_id in fixture_ids_needed:
        if fixture_id in state:
            continue
        fixture = load_fixture(fixture_id)
        if not candidates:
            state[fixture_id] = {
                "fixture": fixture_id,
                "passed": False,
                "reason": f"no archive file_pointer in Task Complete outputs (expected {RESULT_ARCHIVE})",
            }
            continue
        last: dict[str, Any] = {}
        for pointer in candidates:
            filename = str(pointer.get("original_filename"))
            try:
                payload = await download(pointer)
            except Exception as exc:
                last = {"fixture": fixture_id, "passed": False, "reason": f"download of {filename} failed: {exc}"[:600]}
                continue
            last = await asyncio.to_thread(
                evaluate_archive_bytes, fixture, payload, filename, capture_screenshot=capture_screenshot
            )
            if "marker missing" not in last.get("reason", "") and "could not extract" not in last.get("reason", ""):
                break
        state[fixture_id] = last


def static_check(data: dict, check: dict) -> tuple[bool, str]:
    fixture_id = str(check.get("fixture") or "")
    result = (data.get("_benchmark", {}).get(STATE_KEY) or {}).get(fixture_id)
    if result is None:
        return False, f"code-bench fixture {fixture_id!r} was not graded"
    return bool(result.get("passed")), str(result.get("reason") or "")


def needed_fixtures(evaluators: Iterable[dict]) -> tuple[list[str], bool]:
    """Fixture ids declared by code-bench checks, and whether a screenshot judge needs a capture."""
    ids: list[str] = []
    screenshot = False
    for evaluator in evaluators:
        if evaluator.get("method") == SCREENSHOT_METHOD:
            screenshot = True
            if evaluator.get("fixture") and evaluator["fixture"] not in ids:
                ids.append(evaluator["fixture"])
        if evaluator.get("method") == "static_check":
            for check in evaluator.get("checks") or []:
                if check.get("type") == STATIC_CHECK_TYPE and check.get("fixture") not in ids:
                    ids.append(check["fixture"])
    return ids, screenshot


# ---------------------------------------------------------------------------
# Screenshot capture + judge (front-end fixture)
# ---------------------------------------------------------------------------


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:
        return


def render_screenshot(repo: Path, spec: dict) -> bytes:
    """Serve ``repo`` on loopback and capture the page with Chromium (ES modules need http)."""
    from playwright.sync_api import sync_playwright

    handler = functools.partial(_QuietHandler, directory=str(repo))
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/{spec.get('page', 'index.html')}"
            viewport = spec.get("viewport") or {"width": 1200, "height": 720}
            with sync_playwright() as pw:
                browser = pw.chromium.launch()
                try:
                    page = browser.new_page(viewport=viewport)
                    page.goto(url, wait_until="load", timeout=30_000)
                    if spec.get("wait_selector"):
                        page.wait_for_selector(spec["wait_selector"], timeout=10_000)
                    return page.screenshot(full_page=True)
                finally:
                    browser.close()
        finally:
            server.shutdown()


SCREENSHOT_JUDGE_SYSTEM = """You grade a screenshot of a web page that a coding agent built.

You receive the build requirements and one screenshot of the rendered page.
Judge only what is visible. Pass only when every listed criterion is clearly met.

Respond in exactly this format:

Thoughts: <short reasoning that cites what the screenshot shows>
Status: "success" or "failure"
"""


def parse_judge_status(text: str) -> tuple[bool, str]:
    status = re.search(r'Status:\s*"?(success|failure)"?', text or "", re.IGNORECASE)
    thoughts = re.search(r"Thoughts:\s*(.*?)(?:\n\s*Status:|$)", text or "", re.IGNORECASE | re.DOTALL)
    reasoning = (thoughts.group(1).strip() if thoughts else (text or "").strip())[:1200] or "Empty judge response"
    return bool(status and status.group(1).lower() == "success"), reasoning


async def _default_judge_llm(messages: list[dict[str, Any]]) -> str:
    from helpers.llm import call_llm

    result = await call_llm(
        messages=messages,
        model=_SCREENSHOT_JUDGE_MODEL,
        temperature=0.0,
        max_tokens=800,
        call_site="code_bench_screenshot_judge",
    )
    content = result.get("content") if isinstance(result, dict) else None
    return content if isinstance(content, str) else str(content or "")


async def run_screenshot_judge(
    evaluator: dict,
    data: dict,
    *,
    llm: Optional[Callable[[list[dict[str, Any]]], Awaitable[str]]] = None,
) -> dict[str, Any]:
    fixture_id = str(evaluator.get("fixture") or "")
    graded = (data.get("_benchmark", {}).get(STATE_KEY) or {}).get(fixture_id) or {}
    shot = graded.get("screenshot_b64")
    if not shot:
        reason = graded.get("screenshot_error") or graded.get("reason") or "no screenshot was captured"
        return {"score": 0.0, "reasoning": f"No screenshot to judge: {reason}"}
    criteria = "\n".join(f"- {c}" for c in evaluator.get("criteria") or [])
    user_text = f"{evaluator.get('judge_prompt', '')}\n\nCriteria:\n{criteria}"
    messages = [
        {"role": "system", "content": SCREENSHOT_JUDGE_SYSTEM},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{shot}", "detail": "high"}},
            ],
        },
    ]
    text = await (llm or _default_judge_llm)(messages)
    ok, reasoning = parse_judge_status(text)
    return {"score": 1.0 if ok else 0.0, "reasoning": reasoning}


def apply_reference(fixture: Fixture, repo: Path) -> None:
    """Overlay the known-good reference files onto a working repo (evaluator proofs only)."""
    shutil.copytree(fixture.reference_dir, repo, dirs_exist_ok=True)
