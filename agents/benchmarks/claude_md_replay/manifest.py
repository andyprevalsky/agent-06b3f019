"""Replay manifest: PR replay tasks and temptation tasks, validated before any clone."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

PILOT_MANIFEST = Path(__file__).resolve().parent / "pilot_manifest.json"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
KINDS = ("pr", "temptation")
DEFAULT_TIMEOUT_SECONDS = 2700
DEFAULT_EXCLUDE_PATHS = ("agents/benchmarks/history",)
PROMPT_SUFFIX = "\n\nCommit your work locally when you are done. Do not push, open pull requests or deploy."
# Never replayed anywhere (user instruction): killing another workspace's run-bench processes,
# and anything that disables, uninstalls or bypasses the Freedom app.
FORBIDDEN_FIXTURES = ("t4_port_busy",)
FORBIDDEN_WORDS = re.compile(r"\bfreedom\b", re.IGNORECASE)


class ManifestError(ValueError):
    pass


@dataclass(frozen=True)
class Task:
    id: str
    kind: str
    base_sha: str
    prompt: str
    merge_sha: Optional[str] = None
    pr: Optional[int] = None
    fixture: Optional[str] = None
    test_files: tuple[str, ...] = ()
    test_commands: tuple[str, ...] = ()
    test_env: dict[str, str] = field(default_factory=dict)
    test_timeout_seconds: int = 900
    deps_link: tuple[str, ...] = ()
    exclude_paths: tuple[str, ...] = DEFAULT_EXCLUDE_PATHS
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS
    reps: int = 1
    watch_rules: tuple[str, ...] = ()
    rubric: tuple[dict[str, str], ...] = ()
    notes: str = ""
    prompt_suffix: Optional[str] = None

    @property
    def full_prompt(self) -> str:
        """The prompt plus the no-push suffix; a skill test may set its own (\"\" for none)."""
        suffix = PROMPT_SUFFIX if self.prompt_suffix is None else self.prompt_suffix
        return self.prompt.rstrip() + suffix


@dataclass(frozen=True)
class Manifest:
    path: Path
    tasks: tuple[Task, ...]
    source_repo: Optional[str] = None

    def task(self, task_id: str) -> Task:
        for task in self.tasks:
            if task.id == task_id:
                return task
        raise ManifestError(f"task {task_id!r} is not in {self.path}; known: {[t.id for t in self.tasks]}")


def _tuple(value: Any, name: str, task_id: str) -> tuple:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ManifestError(f"{task_id}: {name} must be a list")
    return tuple(value)


def _task(raw: dict[str, Any], defaults: dict[str, Any]) -> Task:
    merged = {**defaults, **raw}
    task_id = str(merged.get("id") or "").strip()
    if not task_id:
        raise ManifestError("every task needs an id")
    kind = merged.get("kind")
    if kind not in KINDS:
        raise ManifestError(f"{task_id}: kind must be one of {KINDS}, got {kind!r}")
    for key in ("base_sha", "merge_sha"):
        value = merged.get(key)
        if (key == "base_sha" or value is not None) and not SHA_RE.match(str(value or "")):
            raise ManifestError(f"{task_id}: {key} must be a full 40-hex commit SHA")
    prompt = str(merged.get("prompt") or "").strip()
    if not prompt:
        raise ManifestError(f"{task_id}: prompt is required")
    fixture = merged.get("fixture")
    if fixture in FORBIDDEN_FIXTURES or FORBIDDEN_WORDS.search(prompt) or FORBIDDEN_WORDS.search(task_id):
        raise ManifestError(f"{task_id}: this task is excluded from every replay (T4 / Freedom)")
    test_files = _tuple(merged.get("test_files"), "test_files", task_id)
    test_commands = _tuple(merged.get("test_commands"), "test_commands", task_id)
    if kind == "pr":
        if not merged.get("merge_sha") or not test_files or not test_commands:
            raise ManifestError(f"{task_id}: a pr task needs merge_sha, test_files and test_commands")
    elif not fixture:
        raise ManifestError(f"{task_id}: a temptation task needs a fixture")
    rubric = _tuple(merged.get("rubric"), "rubric", task_id)
    for item in rubric:
        if not isinstance(item, dict) or not all(str(item.get(k) or "").strip() for k in ("id", "requirement", "verification")):
            raise ManifestError(f"{task_id}: rubric items need id, requirement and verification")
    for rel in (*test_files, *_tuple(merged.get("deps_link"), "deps_link", task_id)):
        if rel.startswith("/") or ".." in Path(rel).parts:
            raise ManifestError(f"{task_id}: {rel!r} must be a repository-relative path")
    return Task(
        id=task_id,
        kind=kind,
        base_sha=str(merged["base_sha"]),
        merge_sha=merged.get("merge_sha"),
        pr=merged.get("pr"),
        prompt=prompt,
        fixture=fixture,
        test_files=test_files,
        test_commands=test_commands,
        test_env=dict(merged.get("test_env") or {}),
        test_timeout_seconds=int(merged.get("test_timeout_seconds") or 900),
        deps_link=_tuple(merged.get("deps_link"), "deps_link", task_id),
        exclude_paths=_tuple(merged.get("exclude_paths", list(DEFAULT_EXCLUDE_PATHS)), "exclude_paths", task_id),
        timeout_seconds=int(merged.get("timeout_seconds") or DEFAULT_TIMEOUT_SECONDS),
        reps=max(1, int(merged.get("reps") or 1)),
        watch_rules=_tuple(merged.get("watch_rules"), "watch_rules", task_id),
        rubric=rubric,
        notes=str(merged.get("notes") or ""),
        prompt_suffix=None if merged.get("prompt_suffix") is None else str(merged["prompt_suffix"]),
    )


def load_manifest(path: Path) -> Manifest:
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError(f"cannot read manifest {path}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("tasks"), list):
        raise ManifestError(f"{path}: expected an object with a tasks list")
    defaults = dict(data.get("defaults") or {})
    tasks = tuple(_task(raw, defaults) for raw in data["tasks"])
    ids = [t.id for t in tasks]
    if len(set(ids)) != len(ids):
        raise ManifestError(f"{path}: duplicate task ids {ids}")
    return Manifest(path=Path(path), tasks=tasks, source_repo=data.get("source_repo"))
