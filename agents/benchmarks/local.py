#!/usr/bin/env python3
"""Local benchmark orchestrator.

Owns local service startup/teardown, benchmark invocation, load-test isolation,
and post-failure diagnostics. Benchmark definitions remain in tasks.json.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

AGENTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENTS_DIR.parent
if str(AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(AGENTS_DIR))

from benchmarks.benchmark_tasks import all_tasks

LOAD_TEST_TASKS = {"load-test-sias"}
SERVICES_MANIFEST = REPO_ROOT / ".context" / "services.json"
SERVICE_LOG = REPO_ROOT / ".context" / "local-benchmark-services.log"
TUNNEL_LOG = REPO_ROOT / ".context" / "local-benchmark-ngrok.log"
RUNS_DIR = AGENTS_DIR / "benchmarks" / "runs"
AGENT_PAYMENT_TEST_SHOP_TASK_NAME = "agent-payment-test-shop"
BENCHMARK_USER_ID = "1f85ff25-6e29-4c1b-8739-f917bd101a30"


@dataclass(frozen=True)
class BenchmarkInvocation:
    label: str
    tasks: list[str]
    is_load: bool = False


@dataclass(frozen=True)
class FailedTask:
    name: str
    agent_id: str
    failure_reason: str


@dataclass(frozen=True)
class FrontendTunnel:
    process: subprocess.Popen
    public_url: str


def known_task_names() -> list[str]:
    return [task.name for task in all_tasks()]


def validate_task_names(names: Sequence[str]) -> list[str]:
    known = set(known_task_names())
    unknown = sorted(set(names) - known)
    if unknown:
        raise ValueError(f"Unknown benchmark task(s): {', '.join(unknown)}")
    deduped: list[str] = []
    for name in names:
        if name not in deduped:
            deduped.append(name)
    return deduped


def split_load_tasks(tasks: Sequence[str]) -> tuple[list[str], list[str]]:
    non_load = [name for name in tasks if name not in LOAD_TEST_TASKS]
    load = [name for name in tasks if name in LOAD_TEST_TASKS]
    return non_load, load


def plan_invocations(tasks: Sequence[str]) -> list[BenchmarkInvocation]:
    non_load, load = split_load_tasks(tasks)
    invocations: list[BenchmarkInvocation] = []
    if non_load:
        invocations.append(BenchmarkInvocation("non-load", list(non_load), is_load=False))
    for name in load:
        invocations.append(BenchmarkInvocation(name, [name], is_load=True))
    return invocations


def build_task_selector_args(selected_tasks: Sequence[str], all_names: Sequence[str]) -> list[str]:
    selected = list(selected_tasks)
    if len(selected) == 1:
        return ["--task", selected[0]]
    excluded = [name for name in all_names if name not in set(selected)]
    args = ["--suite", "all"]
    if excluded:
        args.extend(["--exclude-task", ",".join(excluded)])
    return args


def build_benchmark_args(
    selected_tasks: Sequence[str],
    *,
    port: int,
    bootstrap: bool = False,
    anon: bool = False,
    max_concurrency: int = 5,
    keep_failed_agents: bool = True,
) -> list[str]:
    args = [sys.executable, "benchmarks/run_benchmark.py"]
    args.extend(build_task_selector_args(selected_tasks, known_task_names()))
    args.extend(["--port", str(port), "--ci"])
    if bootstrap:
        args.append("--bootstrap")
    if anon:
        args.append("--anon")
    if keep_failed_agents:
        args.append("--keep-failed-agents")
    if len(selected_tasks) > 1:
        args.extend(["--parallel", "--max-concurrency", str(max_concurrency)])
    return args


def load_services_manifest(path: Path = SERVICES_MANIFEST) -> dict:
    with open(path) as f:
        data = json.load(f)
    ports = data.get("ports") if isinstance(data, dict) else None
    if not isinstance(ports, dict) or not ports.get("backend") or not ports.get("health"):
        raise ValueError(f"Invalid services manifest: missing backend/health ports in {path}")
    return data


def services_manifest_anon_enabled(manifest: dict) -> bool:
    env = manifest.get("env") if isinstance(manifest, dict) else None
    if not isinstance(env, dict):
        return False
    return (
        env.get("benchmark_anon_steel_profile") is True
        and env.get("benchmark_disable_saved_browser_auth") is True
    )


def http_ok(url: str, timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 500
    except Exception:
        return False


def _ngrok_public_url_for_port(port: int) -> str | None:
    try:
        with urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=1.0) as response:
            data = json.load(response)
    except Exception:
        return None
    for tunnel in data.get("tunnels", []) or []:
        if not isinstance(tunnel, dict):
            continue
        public_url = tunnel.get("public_url")
        config = tunnel.get("config") if isinstance(tunnel.get("config"), dict) else {}
        addr = str(config.get("addr") or "")
        if isinstance(public_url, str) and public_url.startswith("https://") and addr.endswith(f":{port}"):
            return public_url.rstrip("/")
    return None


def start_frontend_tunnel(port: int, timeout_seconds: int = 45) -> FrontendTunnel:
    if not shutil.which("ngrok"):
        raise RuntimeError("agent-payment-test-shop requires ngrok so the cloud browser can reach the local test site")
    existing = _ngrok_public_url_for_port(port)
    if existing:
        return FrontendTunnel(process=subprocess.Popen(["true"]), public_url=existing)

    (REPO_ROOT / ".context").mkdir(exist_ok=True)
    tunnel_log = open(TUNNEL_LOG, "w")
    process = subprocess.Popen(
        ["ngrok", "http", str(port), "--log=stdout", "--log-format=json"],
        cwd=REPO_ROOT,
        stdout=tunnel_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    tunnel_log.close()

    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ngrok exited early with code {process.returncode}; see {TUNNEL_LOG}")
        public_url = _ngrok_public_url_for_port(port)
        if public_url:
            return FrontendTunnel(process=process, public_url=public_url)
        time.sleep(1)

    process.terminate()
    raise TimeoutError(f"Timed out waiting for ngrok test-site tunnel; see {TUNNEL_LOG}")


def stop_frontend_tunnel(tunnel: FrontendTunnel | None) -> None:
    if tunnel is None or tunnel.process.poll() is not None:
        return
    tunnel.process.terminate()
    try:
        tunnel.process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        tunnel.process.kill()
        tunnel.process.wait()


def needs_frontend_tunnel(tasks: Sequence[str]) -> bool:
    return AGENT_PAYMENT_TEST_SHOP_TASK_NAME in set(tasks) and not os.environ.get("BENCHMARK_FRONTEND_URL")


def needs_payment_fixture(tasks: Sequence[str]) -> bool:
    return AGENT_PAYMENT_TEST_SHOP_TASK_NAME in set(tasks)


def seed_payment_fixture(manifest: dict) -> None:
    db_port = manifest.get("ports", {}).get("local_db")
    if not db_port:
        raise ValueError("Invalid services manifest: missing local_db port")
    database_url = f"postgresql://postgres:postgres@localhost:{db_port}/victoria"
    env = {
        **os.environ,
        "DATABASE_URL": database_url,
        "DIRECT_URL": database_url,
    }
    print("Seeding Stripe test billing fixture for agent-payment-test-shop")
    subprocess.run(
        [
            "npx",
            "tsx",
            "scripts/setup-benchmark-payment.ts",
            "--user-id",
            os.environ.get("BENCHMARK_USER_ID", BENCHMARK_USER_ID),
        ],
        cwd=REPO_ROOT / "back-end",
        env=env,
        check=True,
    )


def wait_for_services(
    manifest_path: Path = SERVICES_MANIFEST,
    *,
    process: subprocess.Popen | None = None,
    timeout_seconds: int = 180,
) -> dict:
    deadline = time.time() + timeout_seconds
    last_error = ""
    while time.time() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError(f"run.sh exited early with code {process.returncode}; see {SERVICE_LOG}")
        try:
            manifest = load_services_manifest(manifest_path)
            ports = manifest["ports"]
            backend_ok = http_ok(f"http://localhost:{ports['backend']}/health")
            worker_ok = http_ok(f"http://localhost:{ports['health']}/health")
            if manifest.get("status") == "running" and backend_ok and worker_ok:
                return manifest
            last_error = f"status={manifest.get('status')} backend={backend_ok} worker={worker_ok}"
        except Exception as exc:
            last_error = str(exc)
        time.sleep(2)
    raise TimeoutError(f"Timed out waiting for benchmark services ({last_error}); see {SERVICE_LOG}")


def start_services(clean_first: bool = True, *, anon_steel_profile: bool = False) -> tuple[subprocess.Popen, dict]:
    (REPO_ROOT / ".context").mkdir(exist_ok=True)
    if clean_first:
        subprocess.run(["bash", "scripts/kill-services.sh"], cwd=REPO_ROOT, check=True)
    service_log = open(SERVICE_LOG, "w")
    env = {**os.environ, "DISABLE_GMAIL_SYNC": "1"}
    if anon_steel_profile:
        env["BENCHMARK_ANON_STEEL_PROFILE"] = "true"
        env["BENCHMARK_DISABLE_SAVED_BROWSER_AUTH"] = "true"
    process = subprocess.Popen(
        ["bash", "scripts/run.sh", "--benchmark"],
        cwd=REPO_ROOT,
        stdout=service_log,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    service_log.close()
    manifest = wait_for_services(process=process)
    return process, manifest


def stop_services(process: subprocess.Popen | None = None) -> None:
    subprocess.run(["bash", "scripts/kill-services.sh"], cwd=REPO_ROOT, check=False)
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return


def extract_results_path(output: str) -> Path | None:
    marker = "Results saved:"
    for line in output.splitlines():
        if marker in line:
            candidate = line.split(marker, 1)[1].strip()
            if candidate:
                return Path(candidate)
    return None


def latest_result_file(after_timestamp: float | None = None) -> Path | None:
    if not RUNS_DIR.exists():
        return None
    candidates = sorted(RUNS_DIR.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in candidates:
        if after_timestamp is None or path.stat().st_mtime >= after_timestamp:
            return path
    return None


def failed_tasks_from_run(path: Path) -> list[FailedTask]:
    with open(path) as f:
        data = json.load(f)
    failed: list[FailedTask] = []
    for task in data.get("tasks", data.get("task_results", [])):
        if task.get("passed") or task.get("status") == "SKIPPED":
            continue
        failed.append(
            FailedTask(
                name=str(task.get("name", "")),
                agent_id=str(task.get("agent_id", "")),
                failure_reason=str(task.get("failure_reason", "") or ""),
            )
        )
    return failed


def resolve_run_path(value: str) -> Path:
    if value == "latest":
        latest = latest_result_file()
        if latest is None:
            raise FileNotFoundError("No benchmark result files found")
        return latest
    path = Path(value)
    if not path.is_absolute():
        path = AGENTS_DIR / path
    if not path.exists():
        raise FileNotFoundError(path)
    return path


def diagnostic_commands(agent_id: str, *, task_name: str, port: int) -> list[list[str]]:
    return [
        [sys.executable, "benchmarks/agent_latency.py", agent_id, "--benchmark", task_name, "--environment", "local"],
        [
            sys.executable,
            "benchmarks/agent_logs.py",
            agent_id,
            "--tree",
            "--diagnostics",
            "--url",
            f"http://localhost:{port}",
        ],
        [sys.executable, "benchmarks/agent_cache.py", agent_id],
    ]


def run_diagnostics(
    failures: Sequence[FailedTask],
    *,
    port: int,
    result_path: Path,
    timeout_seconds: float = 180,
) -> Path | None:
    runnable = [failure for failure in failures if failure.agent_id]
    if not runnable:
        return None
    out_root = result_path.with_suffix("")
    diag_root = out_root.parent / f"{out_root.name}_diagnostics"
    diag_root.mkdir(parents=True, exist_ok=True)
    for failure in runnable:
        task_dir = diag_root / f"{failure.name}_{failure.agent_id[:12]}"
        task_dir.mkdir(exist_ok=True)
        processes: list[tuple[subprocess.Popen, object]] = []
        for command in diagnostic_commands(failure.agent_id, task_name=failure.name, port=port):
            label = Path(command[1]).stem
            outfile = open(task_dir / f"{label}.txt", "w")
            outfile.write(f"$ {' '.join(command)}\n\n")
            outfile.flush()
            processes.append((subprocess.Popen(command, cwd=AGENTS_DIR, stdout=outfile, stderr=subprocess.STDOUT), outfile))
        for process, outfile in processes:
            try:
                process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                outfile.write(f"\n[diagnostic timed out after {timeout_seconds:g} seconds]\n")
            outfile.close()
    return diag_root


def run_benchmark_invocation(
    invocation: BenchmarkInvocation,
    *,
    port: int,
    bootstrap: bool,
    anon: bool,
    max_concurrency: int,
) -> Path:
    started = time.time()
    command = build_benchmark_args(
        invocation.tasks,
        port=port,
        bootstrap=bootstrap,
        anon=anon,
        max_concurrency=max_concurrency,
        keep_failed_agents=True,
    )
    print(f"\n== Running {invocation.label}: {', '.join(invocation.tasks)}")
    print("$ " + " ".join(command))
    process = subprocess.Popen(command, cwd=AGENTS_DIR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    output_lines: list[str] = []
    assert process.stdout is not None
    for line in process.stdout:
        print(line, end="")
        output_lines.append(line)
    code = process.wait()
    output = "".join(output_lines)
    result_path = extract_results_path(output) or latest_result_file(started)
    if result_path is None:
        raise RuntimeError(f"Benchmark command produced no result file (exit {code})")
    if code != 0:
        print(f"Benchmark invocation failed with exit code {code}; result: {result_path}")
    return result_path


def tasks_from_args(args: argparse.Namespace) -> list[str]:
    if args.rerun_failed:
        run_path = resolve_run_path(args.rerun_failed)
        failures = failed_tasks_from_run(run_path)
        names = [failure.name for failure in failures if failure.name]
        if not names:
            raise ValueError(f"No failed tasks found in {run_path}")
        return validate_task_names(names)
    if args.full:
        return known_task_names()
    if args.tasks:
        return validate_task_names(args.tasks)
    raise ValueError("Specify benchmark task names, --full, or --rerun-failed latest")


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run local benchmarks with managed services and diagnostics")
    parser.add_argument("tasks", nargs="*", help="Benchmark task names, e.g. browser-agent cache-coverage")
    parser.add_argument("--full", action="store_true", help="Run every benchmark; load-test-sias runs by itself")
    parser.add_argument("--rerun-failed", metavar="RUN", help="Rerun failed tasks from a result JSON or 'latest'")
    parser.add_argument("--bootstrap", action="store_true", help="Pass --bootstrap through to run_benchmark.py")
    parser.add_argument(
        "--anon",
        action="store_true",
        help="Pass --anon through to run_benchmark.py so minted-auth benchmarks start without saved auth",
    )
    parser.add_argument("--max-concurrency", type=int, default=5, help="Max concurrent non-load benchmark tasks")
    parser.add_argument("--keep-services", action="store_true", help="Leave local services running after benchmarks")
    parser.add_argument("--use-existing", action="store_true", help="Use services from .context/services.json")
    parser.add_argument("--no-clean", action="store_true", help="Do not call scripts/kill-services.sh before startup")
    args = parser.parse_args(argv)
    selected_modes = sum(1 for enabled in (bool(args.tasks), args.full, bool(args.rerun_failed)) if enabled)
    if selected_modes != 1:
        parser.error("specify exactly one benchmark selection: tasks, --full, or --rerun-failed")
    if args.max_concurrency < 1:
        parser.error("--max-concurrency must be >= 1")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    selected_tasks = tasks_from_args(args)
    process: subprocess.Popen | None = None
    frontend_tunnel: FrontendTunnel | None = None
    result_paths: list[Path] = []
    try:
        if args.use_existing:
            manifest = wait_for_services()
            if args.anon and not services_manifest_anon_enabled(manifest):
                raise RuntimeError(
                    "Existing local stack was not started with anon browser auth disabled. "
                    "Run without --use-existing so local.py can restart the stack with --anon."
                )
        else:
            process, manifest = start_services(
                clean_first=not args.no_clean,
                anon_steel_profile=args.anon,
            )
        if needs_payment_fixture(selected_tasks):
            seed_payment_fixture(manifest)
        if needs_frontend_tunnel(selected_tasks):
            # Prefer the stable public URL run.sh assigned at startup (reserved ngrok domain →
            # frontend port, where /test_payment is now served). Only spin an ad-hoc tunnel if
            # run.sh did not publish one.
            stable_public = ((manifest.get("urls") or {}).get("public") or "").strip()
            if stable_public:
                os.environ["BENCHMARK_FRONTEND_URL"] = stable_public.rstrip("/")
                print(f"Test payment public URL (run.sh): {stable_public}")
            else:
                frontend_tunnel = start_frontend_tunnel(int(manifest["ports"]["frontend"]))
                os.environ["BENCHMARK_FRONTEND_URL"] = frontend_tunnel.public_url.rstrip("/")
                print(f"Test payment tunnel (fallback): {frontend_tunnel.public_url}")
        port = int(manifest["ports"]["backend"])
        for invocation in plan_invocations(selected_tasks):
            result_path = run_benchmark_invocation(
                invocation,
                port=port,
                bootstrap=args.bootstrap,
                anon=args.anon,
                max_concurrency=args.max_concurrency,
            )
            result_paths.append(result_path)
            failures = failed_tasks_from_run(result_path)
            if failures:
                diag_dir = run_diagnostics(failures, port=port, result_path=result_path)
                if diag_dir:
                    print(f"Diagnostics saved: {diag_dir}")
        all_failures = [failure for path in result_paths for failure in failed_tasks_from_run(path)]
        if all_failures:
            print("\nFailed tasks:")
            for failure in all_failures:
                print(f"- {failure.name}: {failure.failure_reason or 'no reason'}")
            return 1
        print("\nAll requested benchmarks passed.")
        return 0
    finally:
        stop_frontend_tunnel(frontend_tunnel)
        if not args.keep_services and not args.use_existing:
            stop_services(process)


if __name__ == "__main__":
    raise SystemExit(main())
