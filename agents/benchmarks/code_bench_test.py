"""Evaluator proofs for the code-bench rose-bench tasks.

Every fixture's grader must FAIL the unmodified starting repo and PASS the
known-good reference solution, both through the same archive path the agent's
returned ``result.tar.gz`` takes. The catalog entries must be generated from
the fixtures (no prompt drift between the Rose leg and the raw-CLI parity leg).
"""

from __future__ import annotations

import asyncio
import io
import json
import shutil
import sys
import subprocess
import tarfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "lib"))
from test_quarantine import quarantine

from benchmarks import code_bench as cb
from benchmarks import code_bench_parity as parity

FIXTURE_IDS = cb.fixture_ids()
TASKS = {t["name"]: t for t in json.loads((Path(cb.__file__).parent / "tasks.json").read_text())}


def _workspace(tmp_path: Path, fixture_id: str) -> Path:
    cb.build_workspace(cb.load_fixture(fixture_id), tmp_path)
    return tmp_path / fixture_id / "repo"


def _git(repo: Path, *args: str) -> str:
    env = cb._git_env(repo.parent.parent)
    return cb._git(list(args), repo, env)


def _commit_all(repo: Path, message: str = "Fix per task") -> None:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", message)


def _archive(tmp_path: Path, fixture_id: str) -> bytes:
    out = tmp_path / "out"
    out.mkdir(exist_ok=True)
    return cb.write_deterministic_tar_gz(tmp_path, fixture_id, out / cb.RESULT_ARCHIVE).read_bytes()


def _grade(tmp_path: Path, fixture_id: str) -> dict:
    return cb.evaluate_archive_bytes(cb.load_fixture(fixture_id), _archive(tmp_path, fixture_id), cb.RESULT_ARCHIVE)


def _solve(tmp_path: Path, fixture_id: str) -> Path:
    fixture = cb.load_fixture(fixture_id)
    repo = _workspace(tmp_path, fixture_id)
    cb.apply_reference(fixture, repo)
    if fixture.git.get("min_new_commits"):
        _commit_all(repo)
    return repo


# ---------------------------------------------------------------------------
# Fail-before / pass-after for every fixture
# ---------------------------------------------------------------------------


def test_there_are_six_to_ten_fixtures():
    assert 6 <= len(FIXTURE_IDS) <= 10


@pytest.mark.parametrize("fixture_id", FIXTURE_IDS)
def test_unmodified_fixture_fails(tmp_path, fixture_id):
    _workspace(tmp_path, fixture_id)
    result = _grade(tmp_path, fixture_id)
    assert result["passed"] is False, result
    assert any(not step["ok"] for step in result["steps"])


@pytest.mark.parametrize("fixture_id", FIXTURE_IDS)
def test_reference_solution_passes(tmp_path, fixture_id):
    _solve(tmp_path, fixture_id)
    result = _grade(tmp_path, fixture_id)
    assert result["passed"] is True, json.dumps(result, indent=2)[:4000]


@pytest.mark.parametrize("fixture_id", FIXTURE_IDS)
def test_hidden_tests_are_not_shipped_to_the_agent(tmp_path, fixture_id):
    archive = cb.build_fixture_archive(fixture_id, tmp_path)
    with tarfile.open(archive) as tar:
        names = tar.getnames()
    hidden_files = {p.name for p in (cb.load_fixture(fixture_id).root / "hidden").iterdir()}
    assert not any(Path(name).name in hidden_files for name in names)
    assert f"{fixture_id}/repo/{cb.MARKER_FILE}" in names


def test_feature_without_agent_tests_fails(tmp_path):
    fixture_id = "feature-textstats-top-words"
    repo = _solve(tmp_path, fixture_id)
    (repo / "tests" / "test_top_words.py").unlink()
    result = _grade(tmp_path, fixture_id)
    assert result["passed"] is False
    assert [s["name"] for s in result["steps"] if not s["ok"]] == ["pattern:tests/*.py~top_words"]


def test_debug_fix_by_editing_the_export_fails(tmp_path):
    fixture_id = "debug-stacktrace-orders"
    repo = _workspace(tmp_path, fixture_id)
    export = repo / "data" / "export-2026-10.csv"
    export.write_text(export.read_text().replace("SKU,Unit Price , Quantity", "sku,unit_price,quantity"))
    result = _grade(tmp_path, fixture_id)
    assert result["passed"] is False
    assert "unchanged:data/export-2026-10.csv" in [s["name"] for s in result["steps"] if not s["ok"]]


def test_debug_fix_that_masks_the_error_downstream_fails(tmp_path):
    fixture_id = "debug-stacktrace-orders"
    repo = _workspace(tmp_path, fixture_id)
    models = repo / "orders" / "models.py"
    models.write_text(
        models.read_text().replace(
            'Decimal(self.row["unit_price"])',
            'Decimal(self.row.get("unit_price") or self.row.get("unit price") or 0)',
        )
    )
    result = _grade(tmp_path, fixture_id)
    assert result["passed"] is False


def test_refactor_that_keeps_duplicates_fails_structure(tmp_path):
    fixture_id = "refactor-shipping-rates"
    repo = _workspace(tmp_path, fixture_id)
    quotes = repo / "shipping" / "quotes.py"
    quotes.write_text(
        'ZONE_RATES = {"domestic": (500, 120), "canada": (900, 210), "international": (1500, 380)}\n\n'
        + quotes.read_text()
    )
    result = _grade(tmp_path, fixture_id)
    assert result["passed"] is False
    assert "test_zone_names_and_rates_appear_once" in json.dumps(result["steps"])


# ---------------------------------------------------------------------------
# Commit locally / do not push (ties to C3)
# ---------------------------------------------------------------------------

COMMIT = "commit-locally-no-push"


def _failed(result: dict) -> list[str]:
    return [s["name"] for s in result["steps"] if not s["ok"]]


def test_commit_fixture_uncommitted_fix_fails(tmp_path):
    repo = _workspace(tmp_path, COMMIT)
    cb.apply_reference(cb.load_fixture(COMMIT), repo)
    result = _grade(tmp_path, COMMIT)
    assert set(_failed(result)) == {"git.new_commits", "git.clean_worktree"}


def test_commit_fixture_pushed_fix_fails(tmp_path):
    repo = _solve(tmp_path, COMMIT)
    _git(repo, "push", "-q", "origin", "main")
    result = _grade(tmp_path, COMMIT)
    assert _failed(result) == ["git.origin_unchanged"]


def test_fixture_origin_push_starts_no_auto_maintenance(tmp_path):
    """A push into the fixture origin must not start receive-pack auto maintenance.

    Git >= 2.47 runs it as ``maintenance run --auto --detach``: its
    ``origin.git/objects/maintenance.lock`` can appear while the result archive
    is written (``-c`` options never reach the receiving side of a local push).
    """
    repo = _solve(tmp_path, COMMIT)
    trace = tmp_path / "trace2.json"
    env = {**cb._git_env(repo.parent.parent), "GIT_TRACE2_EVENT": str(trace)}
    cb._git(["push", "-q", "origin", "main"], repo, env)
    spawned = [json.loads(line).get("argv") or [] for line in trace.read_text().splitlines()]
    assert not [argv for argv in spawned if "gc" in argv or "maintenance" in argv], spawned


def test_commit_fixture_new_remote_branch_fails(tmp_path):
    repo = _solve(tmp_path, COMMIT)
    _git(repo, "push", "-q", "origin", "HEAD:refs/heads/agent-fix")
    assert _failed(_grade(tmp_path, COMMIT)) == ["git.origin_unchanged"]


def test_commit_fixture_missing_origin_fails(tmp_path):
    _solve(tmp_path, COMMIT)
    shutil.rmtree(tmp_path / COMMIT / "origin.git")
    assert _failed(_grade(tmp_path, COMMIT)) == ["git.origin_unchanged"]


@quarantine(
    since="2026-11-10",
    repair="pending-handoff:be7609ba9f2a48879ca405c3ba6a49a3",
    error="FileNotFoundError: [Errno 2] No such file or directory: '/tmp/pytest-of-runner/pytest-14/test_commit_fixture_rewritten_0/commit-locally-no-push/repo/.git/objects/maintenance.lock'",
    evidence='.context/rca-playwright/benchmark-flake/findings.json',
)
def test_commit_fixture_rewritten_history_fails(tmp_path):
    repo = _solve(tmp_path, COMMIT)
    _git(repo, "checkout", "-q", "--orphan", "rewrite")
    _commit_all(repo, "rewritten")
    assert "git.base_is_ancestor" in _failed(_grade(tmp_path, COMMIT))


# ---------------------------------------------------------------------------
# Archive handling
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture_id", FIXTURE_IDS)
def test_fixture_archive_is_deterministic(tmp_path, fixture_id):
    """Rose and the raw CLI get byte-identical inputs (the git index stat cache once differed per build)."""
    first = cb.build_fixture_archive(fixture_id, tmp_path / "a").read_bytes()
    second = cb.build_fixture_archive(fixture_id, tmp_path / "b").read_bytes()
    assert first == second
    assert len(cb.base_sha(fixture_id)) == 40


@pytest.mark.parametrize("fixture_id", [COMMIT, "bugfix-js-pagination"])
def test_extracted_fixture_is_a_clean_checkout(tmp_path, fixture_id):
    archive = cb.build_fixture_archive(fixture_id, tmp_path / "build")
    work = tmp_path / "work"
    work.mkdir()
    subprocess.run(["tar", "-xzf", str(archive)], cwd=work, check=True)
    repo = work / fixture_id / "repo"
    env = cb._git_env(tmp_path)
    assert cb._git(["status", "--porcelain", "--untracked-files=all"], repo, env) == ""
    assert cb._git(["rev-parse", "HEAD"], repo, env) == cb.base_sha(fixture_id)
    cb._git(["fsck", "--no-progress"], repo, env)
    if cb.load_fixture(fixture_id).remote:
        origin = work / fixture_id / "origin.git"
        assert "remote" not in (origin / "config").read_text()
        assert str(tmp_path) not in (origin / "config").read_text()


def test_resolve_attachment_only_handles_code_bench_refs(tmp_path):
    assert cb.resolve_attachment("rs.jpeg", tmp_path) is None
    path = cb.resolve_attachment(cb.attachment_ref("bugfix-invoice-rounding"), tmp_path)
    assert path.name == "bugfix-invoice-rounding.tar.gz" and path.is_file()


def test_zip_result_and_nested_layout_are_accepted(tmp_path):
    _solve(tmp_path, "bugfix-invoice-rounding")
    zipped = shutil.make_archive(str(tmp_path / "result"), "zip", root_dir=tmp_path, base_dir="bugfix-invoice-rounding")
    result = cb.evaluate_archive_bytes(
        cb.load_fixture("bugfix-invoice-rounding"), Path(zipped).read_bytes(), "result.zip"
    )
    assert result["passed"] is True, result["reason"]


def test_archive_without_marker_fails(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = b"print('hi')\n"
        info = tarfile.TarInfo("other/main.py")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    result = cb.evaluate_archive_bytes(cb.load_fixture("bugfix-invoice-rounding"), buf.getvalue(), cb.RESULT_ARCHIVE)
    assert result["passed"] is False and "marker missing" in result["reason"]


def test_path_traversal_archive_is_rejected(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo("../escape.txt")
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    result = cb.evaluate_archive_bytes(cb.load_fixture("bugfix-invoice-rounding"), buf.getvalue(), cb.RESULT_ARCHIVE)
    assert result["passed"] is False and "could not extract" in result["reason"]
    assert not (tmp_path.parent / "escape.txt").exists()


def test_hanging_test_command_is_killed(tmp_path):
    code, output = cb._run_command(("python3", "-c", "import time; time.sleep(30)"), tmp_path, tmp_path, timeout=1)
    assert code == -9 and "timed out" in output


def test_grading_env_does_not_inherit_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("BACKEND_API_KEY", "should-not-leak")
    code, output = cb._run_command(
        ("python3", "-c", "import os; print(os.environ.get('BACKEND_API_KEY'))"), tmp_path, tmp_path, timeout=20
    )
    assert code == 0 and output.strip() == "None"


# ---------------------------------------------------------------------------
# run_benchmark wiring: hydrate -> static check -> screenshot judge
# ---------------------------------------------------------------------------


def test_hydrate_and_static_check_pass_reference(tmp_path):
    _solve(tmp_path, "bugfix-js-pagination")
    payload = _archive(tmp_path, "bugfix-js-pagination")
    data: dict = {"_benchmark": {}}

    async def download(pointer):
        assert pointer["original_filename"] == cb.RESULT_ARCHIVE
        return payload

    pointers = [
        {"original_filename": "notes.txt", "storage_path": "x"},
        {"original_filename": cb.RESULT_ARCHIVE, "storage_path": "y"},
    ]
    asyncio.run(cb.hydrate(data, ["bugfix-js-pagination"], pointers, download=download))
    assert cb.static_check(data, {"fixture": "bugfix-js-pagination"}) == (
        True,
        data["_benchmark"]["code_bench"]["bugfix-js-pagination"]["reason"],
    )


def test_hydrate_without_archive_fails_closed():
    data: dict = {"_benchmark": {}}
    asyncio.run(cb.hydrate(data, ["bugfix-js-pagination"], [], download=None))
    ok, reason = cb.static_check(data, {"fixture": "bugfix-js-pagination"})
    assert not ok and "no archive file_pointer" in reason
    assert cb.static_check({}, {"fixture": "bugfix-js-pagination"})[0] is False


def _completion_messages(pointer: dict) -> list[dict]:
    return [
        {
            "role": "ASSISTANT",
            "message": "",
            "metadata": {
                "toolName": "completion_summary",
                "toolStatus": "FINISHED",
                "completionSummary": {"summary": "done", "outputs": [{"name": "result_archive", "value": pointer}]},
            },
        }
    ]


@pytest.mark.parametrize("solved", [True, False])
def test_run_benchmark_dispatches_code_bench_checks(tmp_path, monkeypatch, solved):
    from benchmarks import run_benchmark
    from benchmarks.benchmark_tasks import get_task_by_name

    task = get_task_by_name("code-bench-bugfix-invoice-rounding")
    if solved:
        _solve(tmp_path, "bugfix-invoice-rounding")
    else:
        _workspace(tmp_path, "bugfix-invoice-rounding")
    payload = _archive(tmp_path, "bugfix-invoice-rounding")
    pointer = {"original_filename": cb.RESULT_ARCHIVE, "storage_path": "bench/result.tar.gz"}
    monkeypatch.setattr(cb, "_default_download", _async_return(payload))
    data = {"agent": {"agent_id": "root", "status": "COMPLETED"}, "messages": _completion_messages(pointer)}
    passed, reason, _results = asyncio.run(run_benchmark._run_declared_evaluators(task, data, static_only=True))
    assert passed is solved, reason
    assert data["_benchmark"]["code_bench"]["bugfix-invoice-rounding"]["passed"] is solved


def test_run_benchmark_resolves_code_bench_attachments(tmp_path):
    from benchmarks import run_benchmark

    cleanup: list = []
    path = run_benchmark._resolve_task_attachment_path(cb.attachment_ref("refactor-shipping-rates"), cleanup)
    assert Path(path).name == "refactor-shipping-rates.tar.gz" and Path(path).is_file()
    assert cleanup and Path(cleanup[0]).is_dir() and Path(path).parent == Path(cleanup[0])
    shutil.rmtree(cleanup[0])
    assert run_benchmark._resolve_task_attachment_path("rs.jpeg", []).endswith("test-assets/rs.jpeg")


def _async_return(value):
    async def _inner(*_args, **_kwargs):
        return value

    return _inner


def test_screenshot_capture_and_judge(tmp_path):
    fixture_id = "frontend-pricing-table"
    repo = _solve(tmp_path, fixture_id)
    fixture = cb.load_fixture(fixture_id)
    result = cb.evaluate_repo(fixture, repo, capture_screenshot=True)
    assert result["passed"], result["reason"]
    if "screenshot_error" in result:
        pytest.fail(
            f"Chromium screenshot failed (run `python -m playwright install chromium`): {result['screenshot_error']}"
        )
    png = __import__("base64").b64decode(result["screenshot_b64"])
    assert png.startswith(b"\x89PNG") and len(png) > 5000

    data = {"_benchmark": {cb.STATE_KEY: {fixture_id: result}}}
    evaluator = next(e for e in TASKS[f"code-bench-{fixture_id}"]["evaluators"] if e["method"] == cb.SCREENSHOT_METHOD)
    seen: list = []

    async def judge_success(messages):
        seen.append(messages)
        return 'Thoughts: three cards in a row, Team highlighted.\nStatus: "success"'

    async def judge_failure(messages):
        return 'Thoughts: cards overlap.\nStatus: "failure"'

    assert asyncio.run(cb.run_screenshot_judge(evaluator, data, llm=judge_success))["score"] == 1.0
    image_parts = [p for p in seen[0][1]["content"] if p["type"] == "image_url"]
    assert image_parts and image_parts[0]["image_url"]["url"].startswith("data:image/png;base64,")
    assert asyncio.run(cb.run_screenshot_judge(evaluator, data, llm=judge_failure))["score"] == 0.0
    missing = asyncio.run(cb.run_screenshot_judge(evaluator, {"_benchmark": {}}, llm=judge_success))
    assert missing["score"] == 0.0 and "No screenshot" in missing["reasoning"]


def test_unrendered_component_gets_no_screenshot(tmp_path):
    fixture_id = "frontend-pricing-table"
    repo = _workspace(tmp_path, fixture_id)
    result = cb.evaluate_repo(cb.load_fixture(fixture_id), repo, capture_screenshot=True)
    assert result["passed"] is False and "screenshot_b64" not in result


# ---------------------------------------------------------------------------
# Catalog contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("fixture_id", FIXTURE_IDS)
def test_catalog_entry_matches_fixture(fixture_id):
    task = TASKS[f"{cb.TASK_NAME_PREFIX}{fixture_id}"]
    fixture = cb.load_fixture(fixture_id)
    assert task["prompt"] == cb.rose_prompt(fixture)
    assert cb.render_code_task(fixture, cb.ROSE_ATTACHMENTS_DIR, cb.ROSE_OUTPUT_DIR) in task["prompt"]
    assert task["attachments"] == [cb.attachment_ref(fixture_id)]
    assert task["bench"] == "rose-bench" and task["status"] == "ready" and task["group"] == "rose-bench"
    assert task["deploy_category"] == "claude-code" and "smoke" not in task["tags"]
    assert task["enforce_declared_evaluators"] is True
    ids, needs_screenshot = cb.needed_fixtures(task["evaluators"])
    assert ids == [fixture_id]
    assert needs_screenshot == bool(fixture.screenshot)


def test_every_code_bench_task_has_a_fixture():
    names = {n for n in TASKS if n.startswith(cb.TASK_NAME_PREFIX)}
    assert names == {f"{cb.TASK_NAME_PREFIX}{f}" for f in FIXTURE_IDS}


def test_code_bench_tasks_are_in_the_rose_bench_eval_axis():
    from benchmarks.benchmark_tasks import suite_tasks

    selected = {t.name for t in suite_tasks() if t.bench == "rose-bench"}
    assert {f"{cb.TASK_NAME_PREFIX}{f}" for f in FIXTURE_IDS} <= selected


def test_catalog_validates():
    from benchmarks.long_horizon import validate_catalog

    validate_catalog()


# ---------------------------------------------------------------------------
# Parity runner
# ---------------------------------------------------------------------------


def test_parity_raw_prompt_differs_only_in_paths(tmp_path):
    fixture = cb.load_fixture(COMMIT)
    raw = cb.render_code_task(fixture, str(tmp_path / "attachments"), str(tmp_path / "output"))
    rose = cb.render_code_task(fixture, cb.ROSE_ATTACHMENTS_DIR, cb.ROSE_OUTPUT_DIR)
    assert (
        raw.replace(str(tmp_path / "attachments"), cb.ROSE_ATTACHMENTS_DIR).replace(
            str(tmp_path / "output"), cb.ROSE_OUTPUT_DIR
        )
        == rose
    )


def test_parity_cli_commands_mirror_the_e2b_templates():
    claude = parity.cli_command("claude", "claude-sonnet-5", Path("/w"), "do it")
    assert claude.argv[:2] == ["claude", "--print"] and "bypassPermissions" in claude.argv
    assert claude.stdin == "do it"
    codex = parity.cli_command("codex", "gpt-5.6-terra", Path("/w"), "do it")
    assert (
        codex.argv[:2] == ["codex", "exec"]
        and codex.argv[-1] == "do it"
        and "--dangerously-bypass-approvals-and-sandbox" in codex.argv
    )


def test_parity_raw_leg_grades_what_the_cli_leaves(tmp_path, monkeypatch):
    """A fake CLI that applies the reference solution must pass; one that does nothing must fail."""

    def fake_run(argv, *, cwd, stdin, timeout, env):
        sandbox = Path(cwd)
        assert argv[argv.index("--effort") + 1] == "xhigh"
        work = sandbox / "work"
        work.mkdir()
        archive = next((sandbox / "attachments").iterdir())
        subprocess.run(["tar", "-xzf", str(archive)], cwd=work, check=True)
        fixture = cb.load_fixture(archive.name[: -len(cb.ARCHIVE_SUFFIX)])
        if "solve" in stdin_marker:
            cb.apply_reference(fixture, work / fixture.id / "repo")
        subprocess.run(["tar", "-czf", str(sandbox / "output" / cb.RESULT_ARCHIVE), fixture.id], cwd=work, check=True)
        return 0, "ok"

    stdin_marker = ["solve"]
    monkeypatch.setattr(parity, "_run_cli", fake_run)
    good = asyncio.run(
        parity.run_raw_attempt("code-bench-bugfix-invoice-rounding", cli="claude", model="m", timeout=60, judge=False, source_env={"CLAUDE_CODE_EFFORT": "xhigh"})
    )
    assert good["passed"] is True, good
    stdin_marker[:] = ["noop"]
    bad = asyncio.run(
        parity.run_raw_attempt("code-bench-bugfix-invoice-rounding", cli="claude", model="m", timeout=60, judge=False, source_env={"CLAUDE_CODE_EFFORT": "xhigh"})
    )
    assert bad["passed"] is False


def test_parity_report_math():
    tasks = ["a", "b", "c", "d"]
    rose = {"a": [True, True, True], "b": [True, False, True], "c": [False, False, False], "d": [True, True, True]}
    raw = {"a": [True, True, True], "b": [True, True, True], "c": [True, False, False], "d": [True, True, True]}
    report = parity.build_report(tasks, rose, raw, k=3)
    assert report["rose"]["per_run_passes"] == [3, 2, 3]
    assert report["raw"]["per_run_passes"] == [4, 3, 3]
    assert report["tolerance_tasks"] == 1
    # mean rose 2.667 >= mean raw 3.333 - 1
    assert report["parity_ok"] is True
    assert report["rose"]["flaky_tasks"] == ["b"] and report["raw"]["flaky_tasks"] == ["c"]
    worse = parity.build_report(tasks, {t: [False] * 3 for t in tasks}, raw, k=3)
    assert worse["parity_ok"] is False


def test_parity_report_uses_five_percent_for_large_suites():
    tasks = [f"t{i}" for i in range(40)]
    report = parity.build_report(tasks, {t: [True] for t in tasks}, {t: [True] for t in tasks}, k=1)
    assert report["tolerance_tasks"] == 2


def test_parity_reads_rose_outcomes_from_run_records(tmp_path):
    record = {
        "suite": "x",
        "tasks": [
            {"name": "code-bench-bugfix-invoice-rounding", "passed": True, "agent_id": "a1"},
            {"name": "code-bench-bugfix-invoice-rounding", "passed": False, "agent_id": "a2"},
            {"name": "other-task", "passed": True, "agent_id": "a3"},
        ],
    }
    path = tmp_path / "run.json"
    path.write_text(json.dumps(record))
    outcomes, agents = parity.rose_outcomes_from_records([path], ["code-bench-bugfix-invoice-rounding"])
    assert outcomes == {"code-bench-bugfix-invoice-rounding": [True, False]}
    assert agents["code-bench-bugfix-invoice-rounding"] == ["a1", "a2"]


def test_parity_cli_env_is_isolated_and_drops_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("BACKEND_API_KEY", "should-not-leak")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "forwarded-credential")
    env = parity.cli_env("claude", tmp_path)
    assert "BACKEND_API_KEY" not in env
    assert env["ANTHROPIC_API_KEY"] == "forwarded-credential"
    assert Path(env["CLAUDE_CONFIG_DIR"]).parent == tmp_path and Path(env["CLAUDE_CONFIG_DIR"]).is_dir()
    monkeypatch.setenv("CODEX_AUTH_JSON", '{"OPENAI_API_KEY": null}')
    codex_env = parity.cli_env("codex", tmp_path)
    auth = Path(codex_env["CODEX_HOME"]) / "auth.json"
    assert auth.read_text() == '{"OPENAI_API_KEY": null}' and oct(auth.stat().st_mode & 0o777) == "0o600"
    assert "ANTHROPIC_API_KEY" not in codex_env


def test_parity_raw_sandbox_refuses_to_run_inside_the_repo(monkeypatch):
    inside = parity.REPO_ROOT / ".context"
    inside.mkdir(exist_ok=True)
    monkeypatch.setattr(parity.tempfile, "tempdir", str(inside))
    with pytest.raises(RuntimeError, match="TMPDIR"):
        asyncio.run(parity.run_raw_attempt("code-bench-bugfix-invoice-rounding", cli="claude", model="m", judge=False))
    assert not list(inside.glob("code-bench-raw-*"))


def test_parity_cli_end_to_end_raw_only(tmp_path, monkeypatch, capsys):
    """`scripts/run-bench code-parity --skip-rose` drives the raw leg and writes the report."""

    def fake_run(argv, *, cwd, stdin, timeout, env):
        sandbox = Path(cwd)
        archive = next((sandbox / "attachments").iterdir())
        fixture = cb.load_fixture(archive.name[: -len(cb.ARCHIVE_SUFFIX)])
        assert stdin == cb.render_code_task(fixture, str(sandbox / "attachments"), str(sandbox / "output"))
        assert argv[argv.index("--model") + 1] == parity.DEFAULT_MODELS["claude"]
        subprocess.run(["tar", "-xzf", str(archive)], cwd=sandbox, check=True)
        cb.apply_reference(fixture, sandbox / fixture.id / "repo")
        out = sandbox / "output" / cb.RESULT_ARCHIVE
        subprocess.run(["tar", "-czf", str(out), fixture.id], cwd=sandbox, check=True)
        return 0, '{"type":"result","subtype":"success"}'

    monkeypatch.delenv("CLAUDE_CODE_MODEL", raising=False)
    monkeypatch.setattr(parity, "_run_cli", fake_run)
    task = "code-bench-bugfix-invoice-rounding"
    code = parity.main(["--tasks", task, "-k", "2", "--skip-rose", "--out-dir", str(tmp_path)])
    assert code == 0
    report = json.loads((tmp_path / "parity.json").read_text())
    assert report["raw"]["task_passes"] == {task: "2/2"} and report["rose_skipped"] is True
    first, second = report["raw_attempts"][task]
    assert first["passed"] and first["exit_code"] == 0
    assert first["input_archive_sha256"] == second["input_archive_sha256"]
    assert (tmp_path / "raw" / task / "run-1" / "cli-transcript.log").is_file()
    assert "parity_ok" in capsys.readouterr().out


def test_parity_nonzero_cli_exit_fails_even_with_a_correct_archive(monkeypatch):
    def fake_run(argv, *, cwd, stdin, timeout, env):
        sandbox = Path(cwd)
        archive = next((sandbox / "attachments").iterdir())
        fixture = cb.load_fixture(archive.name[: -len(cb.ARCHIVE_SUFFIX)])
        subprocess.run(["tar", "-xzf", str(archive)], cwd=sandbox, check=True)
        cb.apply_reference(fixture, sandbox / fixture.id / "repo")
        out = sandbox / "output" / cb.RESULT_ARCHIVE
        subprocess.run(["tar", "-czf", str(out), fixture.id], cwd=sandbox, check=True)
        return 1, "Invalid API key"

    monkeypatch.setattr(parity, "_run_cli", fake_run)
    result = asyncio.run(
        parity.run_raw_attempt("code-bench-bugfix-invoice-rounding", cli="claude", model="m", judge=False)
    )
    assert result["hidden_tests_passed"] is True and result["passed"] is False
    assert "CLI exited 1" in result["reason"]


def test_parity_compares_rose_records_with_raw_results(tmp_path):
    task = "code-bench-bugfix-invoice-rounding"
    records = []
    for index, passed in enumerate([True, True, False]):
        path = tmp_path / f"rose-{index}.json"
        path.write_text(json.dumps({"tasks": [{"name": task, "passed": passed, "agent_id": f"agent-{index}"}]}))
        records.append(str(path))
    raw = tmp_path / "raw.json"
    raw.write_text(json.dumps({"raw_attempts": {task: [{"passed": True}, {"passed": True}, {"passed": True}]}}))
    out = tmp_path / "out"
    code = parity.main(["--tasks", task, "--rose-records", *records, "--raw-results", str(raw), "--out-dir", str(out)])
    report = json.loads((out / "parity.json").read_text())
    assert report["rose"]["per_run_passes"] == [1, 1, 0] and report["raw"]["per_run_passes"] == [1, 1, 1]
    assert report["parity_ok"] is True  # mean 0.667 >= 1 - 1
    assert report["rose_agent_links"][task][0] == "https://roselabs.ai/?agent-id=agent-0"
    assert code == 0 and report["c8_ok"] is True


def test_parity_is_reachable_through_run_bench():
    result = subprocess.run(
        ["bash", str(parity.REPO_ROOT / "scripts" / "run-bench"), "code-parity", "--help"],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "--run-rose" in result.stdout and "--rose-records" in result.stdout


def test_parity_concurrent_raw_leg_keeps_run_order(tmp_path, monkeypatch):
    import time as _time

    calls: list[str] = []

    async def fake_attempt(task, *, cli, model, judge, cli_bin, pass_env, source_env, evidence_dir):
        calls.append(evidence_dir.name)
        await asyncio.sleep(0.05 if evidence_dir.name == "run-1" else 0)
        return {"task": task, "passed": evidence_dir.name != "run-2", "reason": "", "finished": _time.monotonic()}

    monkeypatch.setattr(parity, "run_raw_attempt", fake_attempt)
    args = parity._parse_args(["-k", "3", "--skip-rose", "--raw-concurrency", "3"])
    task = "code-bench-bugfix-invoice-rounding"
    attempts = asyncio.run(parity._raw_leg(args, [task], tmp_path))
    assert [a["run"] for a in attempts[task]] == [1, 2, 3]
    assert [a["passed"] for a in attempts[task]] == [True, False, True]
    assert attempts[task][0]["finished"] > attempts[task][1]["finished"]  # run 1 finished last, still first


def test_parity_publishes_verified_rose_links(tmp_path, monkeypatch):
    task = "code-bench-bugfix-invoice-rounding"
    record = tmp_path / "rose.json"
    infra_row = {"name": task, "passed": False, "agent_id": "dead", "failure_reason": "Cloud cleanup failed: x"}
    record.write_text(json.dumps({"tasks": [infra_row, {"name": task, "passed": True, "agent_id": "a1"}]}))
    seen: list[list[str]] = []

    def fake_run(argv, **kwargs):
        seen.append(argv)  # INFRA rows (dead stack) are not published
        out = "FE link: https://www.roselabs.ai/?agent-id=a1#benchmark-share=x — verified in fresh browser (22 msgs)\n"
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

    monkeypatch.setattr(parity.subprocess, "run", fake_run)
    links = parity.publish_rose_evidence([record], [task])
    assert links == {"a1": "https://www.roselabs.ai/?agent-id=a1#benchmark-share=x"}
    assert seen[0][-4:] == ["--run-json", str(record), "--agent-id", "a1"]


def test_parity_without_a_rose_leg_has_no_verdict():
    task = "code-bench-bugfix-invoice-rounding"
    report = parity.build_report([task], {}, {task: [True]}, k=1)
    assert report["parity_ok"] is False and report["c8_ok"] is False
    assert report["rose"]["complete"] is False and report["raw"]["complete"] is True


def test_parity_summarizes_claude_stream_json_usage_and_host_extensions():
    events = [
        {"type": "system", "subtype": "hook_started", "hook_name": "SessionStart:startup"},
        {
            "type": "system",
            "subtype": "init",
            "claude_code_version": "2.1.284",
            "model": "claude-sonnet-5",
            "skills": ["debug"],
            "plugins": [{"name": "agents-md", "path": "builtin"}, {"name": "host-plugin", "path": "/etc/x"}],
            "mcp_servers": [],
        },
        {
            "type": "result",
            "subtype": "success",
            "is_error": False,
            "num_turns": 10,
            "total_cost_usd": 0.195,
            "usage": {
                "input_tokens": 18,
                "output_tokens": 3259,
                "cache_read_input_tokens": 344768,
                "cache_creation_input_tokens": 23373,
            },
        },
    ]
    transcript = "not json\n" + "\n".join(json.dumps(e) for e in events)
    summary = parity.summarize_transcript("claude", transcript)
    assert summary["cli_version"] == "2.1.284" and summary["num_turns"] == 10 and summary["cost_usd"] == 0.195
    assert summary["plugins"] == ["host-plugin"] and summary["hooks_run"] == 1 and summary["host_extensions"]
    assert summary["cache_read_input_tokens"] == 344768
    codex = parity.summarize_transcript(
        "codex",
        json.dumps(
            {"type": "turn.completed", "usage": {"input_tokens": 5, "cached_input_tokens": 2, "output_tokens": 7}}
        ),
    )
    assert codex == {"input_tokens": 5, "cached_input_tokens": 2, "output_tokens": 7, "num_turns": 1}


_CREDIT_ERROR = json.dumps(
    {
        "type": "result",
        "subtype": "success",
        "is_error": True,
        "num_turns": 1,
        "api_error_status": 400,
        "result": "Credit balance is too low",
        "total_cost_usd": 0,
        "usage": {},
    }
)


def test_parity_provider_api_error_is_infra_not_a_task_failure(monkeypatch):
    """Live 2026-10-20: the raw leg's credential ran out mid-run; those attempts are INFRA."""
    monkeypatch.setattr(parity, "_run_cli", lambda argv, **kwargs: (1, _CREDIT_ERROR))
    result = asyncio.run(
        parity.run_raw_attempt("code-bench-bugfix-invoice-rounding", cli="claude", model="m", judge=False)
    )
    assert result["infra"] is True and result["passed"] is False
    assert result["reason"].startswith("INFRA: provider API error 400: Credit balance is too low")
    assert parity.attempt_outcome(result) is None
    report = parity.build_report(["t"], {"t": [True]}, {"t": [parity.attempt_outcome(result)]}, k=1)
    assert report["raw"]["infra_attempts"] == 1 and report["raw"]["complete"] is False
    assert report["raw"]["task_passes"] == {"t": "0/0"} and report["parity_ok"] is False


def test_parity_cli_env_ignores_credentials_loaded_after_startup(tmp_path, monkeypatch):
    """The judge's agents/.env load put the shared ANTHROPIC_API_KEY into os.environ mid-run."""
    caller = {"PATH": "/usr/bin", "HOME": str(tmp_path)}
    monkeypatch.setenv("ANTHROPIC_API_KEY", "loaded-later-from-agents-env")
    env = parity.cli_env("claude", tmp_path, source_env=caller)
    assert "ANTHROPIC_API_KEY" not in env and env["PATH"] == "/usr/bin"
    args = parity._parse_args(["--skip-rose"])
    assert args.source_env == parity._CALLER_ENV


def test_parity_rerun_infra_replaces_only_infra_attempts(tmp_path, monkeypatch):
    task = "code-bench-bugfix-invoice-rounding"
    transcript = tmp_path / "cli-transcript.log"
    transcript.write_text(_CREDIT_ERROR + "\n")
    saved = {
        "raw_attempts": {
            task: [
                {"task": task, "run": 1, "passed": True, "exit_code": 0, "reason": "ok"},
                {"task": task, "run": 2, "passed": False, "exit_code": 1, "transcript": str(transcript), "reason": "x"},
                {"task": task, "run": 3, "passed": False, "exit_code": 0, "reason": "genuine failure"},
            ]
        }
    }
    raw = tmp_path / "raw.json"
    raw.write_text(json.dumps(saved))
    reran: list[tuple[str, str]] = []

    async def fake_attempt(name, *, evidence_dir, **kwargs):
        reran.append((name, evidence_dir.name))
        return {"task": name, "passed": True, "reason": "All 2 code-bench checks passed"}

    monkeypatch.setattr(parity, "run_raw_attempt", fake_attempt)
    out = tmp_path / "out"
    parity.main(["--tasks", task, "--skip-rose", "--raw-results", str(raw), "--rerun-infra", "--out-dir", str(out)])
    assert reran == [(task, "run-2")]
    attempts = json.loads((out / "parity.json").read_text())["raw_attempts"][task]
    assert [a["passed"] for a in attempts] == [True, True, False]
    assert attempts[1]["superseded_infra_attempts"][0]["infra"] is True
    assert attempts[2]["reason"] == "genuine failure"


def test_parity_lease_runs_raw_claude_on_the_leased_token_only(tmp_path, monkeypatch):
    seen: dict = {}
    released: list = []

    async def fake_lease(backend, user):
        seen["lease"] = (backend, user)
        return {"type": "claude", "accessToken": "leased-oauth", "lineageKey": "lk-1", "source": "pool"}

    async def fake_release(lease):
        released.append(lease["lineageKey"])

    async def fake_attempt(name, *, source_env, **kwargs):
        seen["env"] = dict(source_env)
        return {"task": name, "passed": True, "reason": ""}

    monkeypatch.setattr(parity, "lease_claude_token", fake_lease)
    monkeypatch.setattr(parity, "release_lease", fake_release)
    monkeypatch.setattr(parity, "run_raw_attempt", fake_attempt)
    monkeypatch.setitem(parity._CALLER_ENV, "ANTHROPIC_API_KEY", "exhausted-shared-key")
    task = "code-bench-bugfix-invoice-rounding"
    parity.main(["--tasks", task, "-k", "1", "--skip-rose", "--lease-claude-token", "--out-dir", str(tmp_path)])
    assert seen["lease"] == (parity.PROD_BACKEND_URL, parity.BENCH_USER_ID)
    assert seen["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == "leased-oauth" and "ANTHROPIC_API_KEY" not in seen["env"]
    assert released == ["lk-1"]


def test_parity_openrouter_gateway_matches_the_rose_sandbox_transport(tmp_path, monkeypatch):
    """Without a Claude credential Rose routes Claude Code via OpenRouter's Anthropic base."""
    caller = {"PATH": "/usr/bin", "OPENROUTER_API_KEY": "sk-or-test", "CLAUDE_CODE_OAUTH_TOKEN": "stale"}
    env = parity.openrouter_gateway_env(caller)
    assert env["ANTHROPIC_BASE_URL"] == "https://openrouter.ai/api" and env["ANTHROPIC_API_KEY"] == "sk-or-test"
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in env
    cli = parity.cli_env("claude", tmp_path, source_env=env)
    assert parity.describe_transport(cli) == "api-key@https://openrouter.ai/api"
    assert parity.describe_transport({"CLAUDE_CODE_OAUTH_TOKEN": "x"}) == "oauth-token"
    assert parity.describe_transport({}) == "cli-managed-login"
    sandbox_auth = (parity.REPO_ROOT / "back-end/src/providers/claudeCodeSandboxAuth.ts").read_text()
    assert f"OPENROUTER_ANTHROPIC_COMPAT_BASE_URL = '{parity.OPENROUTER_ANTHROPIC_BASE_URL}'" in sandbox_auth
    models = (parity.REPO_ROOT / "back-end/src/providers/codeAgentModels.ts").read_text()
    flash = models[models.index("  flash: {") :]
    assert f"claude: '{parity.DEFAULT_MODELS['claude']}'" in flash
    assert f"codex: '{parity.DEFAULT_MODELS['codex']}'" in flash
    with pytest.raises(SystemExit):
        parity._parse_args(["--openrouter-gateway", "--lease-claude-token"])


def test_parity_rose_infra_rows_are_rerun_not_failures(tmp_path):
    """Live 2026-10-20: the memory watchdog killed the local backend mid-run.

    Rows that passed evaluation then failed owned cleanup, rows killed mid-task and
    never-started rows are INFRA; only genuine verdicts count, so a later rerun
    supplies that task's next verdict.
    """
    task, other = "code-bench-debug-stacktrace-orders", "code-bench-bugfix-invoice-rounding"
    run2 = {
        "tasks": [
            {"name": other, "passed": True, "status": "COMPLETED", "agent_id": "a2"},
            {
                "name": task,
                "passed": False,
                "status": "COMPLETED",
                "agent_id": "a2x",
                "failure_reason": "Cloud cleanup failed: provider: provider verification database is not the owned "
                "local stack; payment: provider verification database is not the owned local stack",
            },
        ]
    }
    run3 = {
        "tasks": [
            {
                "name": other,
                "passed": False,
                "status": "CANCELLED",
                "agent_id": "",
                "failure_reason": "Benchmark interrupted before task produced logs: ",
            },
            {
                "name": task,
                "passed": False,
                "status": "ACTIVE",
                "agent_id": "a3x",
                "failure_reason": "Cloud cleanup failed: provider: exact provider ownership was not verified",
            },
        ]
    }
    rerun = {
        "tasks": [
            {
                "name": task,
                "passed": False,
                "status": "COMPLETED",
                "agent_id": "a4",
                "failure_reason": "1/4 code-bench checks failed; first: run:python3 -m unittest",
            }
        ]
    }
    paths = []
    for name, record in (("run2", run2), ("run3", run3), ("rerun", rerun)):
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(record))
        paths.append(path)
    outcomes, agents = parity.rose_outcomes_from_records(paths, [task, other])
    assert outcomes == {other: [True], task: [False]}  # the genuine hidden-test failure still counts
    assert agents[task] == ["a4"]
    infra = parity.rose_infra_rows(paths, [task, other])
    assert [(r["task"], r["agent_id"]) for r in infra] == [(task, "a2x"), (other, ""), (task, "a3x")]


def test_parity_finds_the_record_when_the_hub_upload_failed(tmp_path):
    """save() writes runs/*.json before the Hub upload, so a dead backend leaves no "Results saved:" line."""
    run_id = "b327bac1-7f3c-40e6-af79-a48947282252"
    record = tmp_path / f"20261020_114243_{run_id}_code-bench-x.json"
    record.write_text("{}")
    output = f"[report-card] run={run_id} elapsed=0.0s mode=real\nHubVisibilityError: upload failed\n"
    assert parity.record_for_output(output, tmp_path) == record
    saved = tmp_path / "other.json"
    saved.write_text("{}")
    assert parity.record_for_output(f"  Results saved: {saved}\n", tmp_path) == saved
    assert parity.record_for_output("no markers", tmp_path) is None


def test_parity_rose_leg_reruns_only_tasks_short_of_k_verdicts(tmp_path):
    a, b = "code-bench-bugfix-invoice-rounding", "code-bench-debug-stacktrace-orders"
    cleanup = {"passed": False, "status": "COMPLETED", "failure_reason": "Cloud cleanup failed: provider: x"}
    scripted = [
        [{"name": a, "passed": True}, {"name": b, "passed": True}],
        [{"name": a, "passed": True}, {"name": b, **cleanup}],
        None,  # the run died before saving any record
        [{"name": b, "passed": True}],
    ]
    calls: list[list[str]] = []

    def runner(names, log_path):
        calls.append(list(names))
        rows = scripted[len(calls) - 1]
        if rows is None:
            return None
        path = tmp_path / f"run{len(calls)}.json"
        path.write_text(json.dumps({"tasks": rows}))
        return path

    records = parity.run_rose_local([a, b], 2, tmp_path, retry_infra=2, runner=runner)
    assert calls == [[a, b], [a, b], [b], [b]]
    outcomes, _ = parity.rose_outcomes_from_records(records, [a, b])
    assert outcomes == {a: [True, True], b: [True, True]}
    assert parity._parse_args(["--run-rose", "local"]).rose_retry_infra == 2


def test_parity_cli_effort_matches_flash_and_explicit_tier(tmp_path):
    from benchmarks import code_bench_parity as parity
    for effort in (parity.DEFAULT_EFFORT, "xhigh"):
        claude = parity.cli_command("claude", "claude-opus-5-5", tmp_path, "task", effort=effort)
        assert claude.argv[claude.argv.index("--effort") + 1] == effort
        codex = parity.cli_command("codex", "gpt-6.1-sol", tmp_path, "task", effort=effort)
        assert f'model_reasoning_effort="{effort}"' in codex.argv
    models = (parity.REPO_ROOT / "back-end/src/providers/codeAgentModels.ts").read_text()
    assert f"effort: '{parity.DEFAULT_EFFORT}'" in models[models.index("  flash: {"):]


def test_git_wrapper_never_starts_background_maintenance(tmp_path):
    """A commit must not spawn detached `git maintenance` that mutates .git while it is archived."""
    repo = _workspace(tmp_path, COMMIT)
    (repo / "maintenance-probe.txt").write_text("probe\n")
    trace = tmp_path / "git-trace.log"
    env = {**cb._git_env(repo.parent.parent), "GIT_TRACE": str(trace)}
    cb._git(["add", "-A"], repo, env)
    cb._git(["commit", "-q", "-m", "probe"], repo, env)
    log = trace.read_text()
    assert "built-in: git commit" in log
    assert "maintenance run" not in log and "gc --auto" not in log


def test_fixture_git_joins_maintenance_writer_before_archiving(tmp_path):
    """A successful Git return must not leave its transient writer behind."""
    import concurrent.futures
    import os
    import secrets
    import select
    import time
    import socket
    import sys
    import textwrap

    nonce = secrets.token_hex(32)
    binary = tmp_path / "bin"
    binary.mkdir()
    listener = socket.socket(socket.AF_INET)
    listener.settimeout(10)
    listener.bind(("127.0.0.1", 0))
    address = str(listener.getsockname()[1])
    listener.listen(1)
    child_code = textwrap.dedent('''\
        import os, socket, sys
        from pathlib import Path
        root, address, ready_fd, foreground, nonce = sys.argv[1:]
        lock = Path(root) / 'fixture' / '.git' / 'objects' / 'maintenance.lock'
        lock.parent.mkdir(parents=True, exist_ok=True)
        lock.write_text('transient maintenance writer')
        channel = socket.socket(socket.AF_INET)
        channel.settimeout(10)
        channel.connect(("127.0.0.1", int(address)))
        channel.sendall((nonce + ' ' + str(os.getpid()) + ' ' + foreground + '\\n').encode())
        os.write(int(ready_fd), b'R')
        os.close(int(ready_fd))
        assert channel.recv(1) == b'R'
        lock.unlink()
        channel.sendall(b'D')
        os._exit(0)  # EOF is emitted by process exit, not a premature socket close.
    ''')
    program = textwrap.dedent('''\
        import os, subprocess, sys
        args = sys.argv[1:]
        foreground = all(value in args for value in ['gc.autoDetach=false', 'maintenance.autoDetach=false'])
        reader, writer = os.pipe()
        child = subprocess.Popen([sys.executable, '-c', CHILD_CODE, os.environ['WRITER_ROOT'],
                                  os.environ['WRITER_SOCKET'], str(writer), str(int(foreground)), os.environ['WRITER_NONCE']],
                                 pass_fds=(writer,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.close(writer)
        assert os.read(reader, 1) == b'R'
        os.close(reader)
        if foreground:
            assert child.wait(timeout=10) == 0
        print('joined' if child.poll() == 0 else 'detached')
    ''').replace('CHILD_CODE', repr(child_code))
    executable = binary / "git"
    executable.write_text(f"#!{sys.executable}\n" + program)
    executable.chmod(0o700)
    env = {**cb._git_env(tmp_path), "PATH": str(binary),
           "WRITER_ROOT": str(tmp_path), "WRITER_SOCKET": address, "WRITER_NONCE": nonce}
    connection = None
    future = None
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        try:
            future = pool.submit(cb._git, ["maintenance", "run", "--auto"], tmp_path, env)
            # The devbox may probe open ports. Accept only this child's
            # unguessable frame; keep servicing peers under one fixed deadline.
            deadline = time.monotonic() + 10
            pending = {}
            try:
                while connection is None:
                    remaining = deadline - time.monotonic()
                    assert remaining > 0, 'owned maintenance readiness deadline'
                    readable, _, _ = select.select([listener, *pending], [], [], remaining)
                    assert readable, 'owned maintenance readiness deadline'
                    for peer in readable:
                        if peer is listener:
                            try:
                                incoming, _ = listener.accept()
                            except ConnectionAbortedError:
                                continue
                            incoming.setblocking(False)
                            pending[incoming] = bytearray()
                            continue
                        try:
                            chunk = peer.recv(256)
                        except BlockingIOError:
                            continue
                        except (ConnectionResetError, ConnectionAbortedError):
                            peer.close()
                            del pending[peer]
                            continue
                        frame = pending[peer]
                        frame.extend(chunk)
                        prefix = (nonce + ' ').encode()
                        received_prefix = bytes(frame[:len(prefix)])
                        if (not chunk or len(frame) > 256
                                or received_prefix != prefix[:len(received_prefix)]):
                            peer.close()
                            del pending[peer]
                            continue
                        if b'\n' not in frame:
                            continue
                        ready, _, trailing = bytes(frame).partition(b'\n')
                        fields = ready.decode('ascii', errors='replace').split(' ')
                        if (trailing or len(fields) != 3
                                or not secrets.compare_digest(fields[0], nonce)
                                or not fields[1].isdigit() or int(fields[1]) <= 0
                                or fields[2] not in ('0', '1')):
                            peer.close()
                            del pending[peer]
                            continue
                        _, pid, mode = fields
                        connection = peer
                        del pending[peer]
                        connection.settimeout(deadline - time.monotonic())
                        break
            finally:
                for peer in pending:
                    peer.close()
            if mode == '0':
                # Observe the original detached return while its writer is held.
                result = future.result(timeout=10)
            connection.sendall(b'R')
            assert connection.recv(1) == b'D'
            assert connection.recv(1) == b'', 'owned writer did not exit'
            result = future.result(timeout=10)
            assert result == 'joined', 'Git returned while maintenance still owned the archive input'
            assert not (tmp_path / 'fixture/.git/objects/maintenance.lock').exists()
            archive = cb.write_deterministic_tar_gz(tmp_path, 'fixture', tmp_path / 'fixture.tar.gz')
            with tarfile.open(archive) as tar:
                assert not any(name.endswith('maintenance.lock') for name in tar.getnames())
        finally:
            if connection is not None:
                try:
                    connection.sendall(b'R')
                except OSError:
                    pass
                assert connection.recv(1) == b'', 'owned writer cleanup failed'
                connection.close()
            listener.close()
