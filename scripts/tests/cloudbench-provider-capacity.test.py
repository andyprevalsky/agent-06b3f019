#!/usr/bin/env python3
"""Offline: benchmark concurrency above the provider rate-limit cap is refused.

The cap comes from the reviewed registry (scripts/cloudbench-provider-limits.json):
floor(limit * (1 - production reserve) / per-bench peak) per enforced provider,
minimum across enforced providers. The CLI entrypoints refuse a wider global
simultaneous width with one exact message before any credential or provider call.
"""
from __future__ import annotations

import contextlib
from decimal import Decimal
from fractions import Fraction
import io
import json
import math
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "scripts/cloudbench-provider-capacity.py"
REGISTRY = ROOT / "scripts/cloudbench-provider-limits.json"
CAMPAIGN = ROOT / "scripts/run-bench-campaign.py"
FLEET = ROOT / "scripts/run-bench-fleet"
MEMBERS = ("cloudbench-provider-capacity.py", "cloudbench-provider-limits.json")

REFUSAL_600 = """\
❌ Benchmark concurrency is limited by provider rate limits: requested 600 concurrent benches, maximum 70.
Limiting providers (20% of each limit reserved for production):
  - Parallel Search+Extract API: 600 requests/min per key (PARRALLEL_API_KEY) → max 70 concurrent benches (peak 6.83 requests/min per bench, measured run600c)
  - Kernel browser sessions: 150 concurrent sessions, Start-up plan (KERNEL_API_KEY) → max 135 concurrent benches (peak 0.884 sessions per bench, measured run600c)
STOP: do not retry, split, or work around this limit. Halt and ask the user to either
  1. increase these provider rate limits (then record the new limits in scripts/cloudbench-provider-limits.json), or
  2. rerun with a lower concurrency (70 or fewer concurrent benches).
"""
PARALLEL_LINE = (
    "  - Parallel Search+Extract API: 600 requests/min per key (PARRALLEL_API_KEY) → max 70 concurrent benches "
    "(peak 6.83 requests/min per bench, measured run600c)"
)


def clean_env(**extra: str) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith(("CLOUDBENCH_", "RUN_BENCH_CAMPAIGN_", "BENCHMARK_HUB_GROUP", "FLY_"))}
    # Pin a Kernel fleet so these exact refusals never depend on this host's
    # back-end/.env BROWSER_PROVIDER. Tilion-scoped rows have their own tests.
    env["CLOUDBENCH_BROWSER_PROVIDER"] = "kernel"
    env.update(extra)
    return env


def helper(*argv: str, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, "-I", "-S", "-B", str(HELPER), *argv], env=clean_env(**env),
                          capture_output=True, text=True, timeout=30)


def registry_value() -> dict:
    return json.loads(REGISTRY.read_text())


def expected_cap(value: dict, browser_provider: str = "kernel") -> tuple[int, dict[str, int]]:
    """Independent exact recomputation from the registry's decimal digits."""
    raw = json.loads(json.dumps(value), parse_float=Decimal)
    reserve = Fraction(raw["production_reserve_fraction"])
    caps = {row["id"]: math.floor(Fraction(row["limit"]) * (1 - reserve) / Fraction(row["per_bench_peak"]))
            for row in raw["enforced"] if row.get("browser_provider") in (None, browser_provider)}
    return min(caps.values()), caps


class ProviderCapacityRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="provider-capacity-"))
        self.addCleanup(shutil.rmtree, self.tmp)

    def registry_file(self, value: dict, name: str = "limits.json") -> Path:
        path = self.tmp / name
        path.write_text(json.dumps(value))
        return path

    def test_provider_capacity_exact_refusal_at_600(self) -> None:
        result = helper("check", "--benches", "600")
        self.assertEqual(result.returncode, 78)
        self.assertEqual(result.stderr, REFUSAL_600)
        self.assertEqual(result.stdout, "")

    def test_provider_capacity_cap_is_computed_from_the_registry(self) -> None:
        cap, caps = expected_cap(registry_value())
        self.assertEqual((cap, caps), (70, {"parallel-search-extract": 70, "kernel-browser-sessions": 135}))
        self.assertEqual(helper("cap").stdout, "70\n")
        table = json.loads(helper("cap", "--json").stdout)
        self.assertEqual(table["max_concurrent_benches"], 70)
        self.assertEqual({row["id"]: row["max_concurrent_benches"] for row in table["enforced"]}, caps)
        self.assertEqual({row["id"]: row["max_concurrent_benches"] for row in table["informational"]},
                         {"azure-foundry-gpt-6-sol": 60, "cerebras-qwen-3.8-27b": 85, "firecrawl": 261})
        # The registry, not code, owns the cap: doubling the Parallel limit moves
        # the binding provider to Kernel.
        value = registry_value()
        value["enforced"][0]["limit"] = 1200
        path = self.registry_file(value)
        cap, caps = expected_cap(value)
        self.assertEqual((cap, caps["parallel-search-extract"]), (135, 140))
        self.assertEqual(helper("cap", CLOUDBENCH_PROVIDER_LIMITS_FILE=str(path)).stdout, "135\n")
        fits = helper("check", "--benches", "135", CLOUDBENCH_PROVIDER_LIMITS_FILE=str(path))
        self.assertEqual(fits.returncode, 0, fits.stderr)
        self.assertIn(f"provider limits from CLOUDBENCH_PROVIDER_LIMITS_FILE={path} (validated", fits.stderr)
        over = helper("check", "--benches", "136", CLOUDBENCH_PROVIDER_LIMITS_FILE=str(path))
        self.assertEqual(over.returncode, 78)
        self.assertIn("requested 136 concurrent benches, maximum 135.", over.stderr)
        self.assertIn("  - Kernel browser sessions: 150 concurrent sessions", over.stderr)
        self.assertNotIn("Parallel", over.stderr)
        self.assertIn("record the new limits in scripts/cloudbench-provider-limits.json", over.stderr)

    def test_provider_capacity_cap_passes_and_cap_plus_one_lists_every_binding_provider(self) -> None:
        for benches in ("0", "1", "70"):
            result = helper("check", "--benches", benches)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("❌", result.stderr)
        over = helper("check", "--benches", "71")
        self.assertEqual(over.returncode, 78)
        self.assertEqual(over.stderr.splitlines()[0],
                         "❌ Benchmark concurrency is limited by provider rate limits: requested 71 concurrent benches, maximum 70.")
        self.assertEqual([line for line in over.stderr.splitlines() if line.startswith("  - ")], [PARALLEL_LINE])
        both = helper("check", "--benches", "136")
        listed = [line for line in both.stderr.splitlines() if line.startswith("  - ")]
        self.assertEqual(both.returncode, 78)
        self.assertEqual([line.split(":")[0] for line in listed],
                         ["  - Parallel Search+Extract API", "  - Kernel browser sessions"])
        self.assertTrue(both.stderr.endswith("  2. rerun with a lower concurrency (70 or fewer concurrent benches).\n"))

    def test_provider_capacity_informational_providers_are_notes_only(self) -> None:
        quiet = helper("check", "--benches", "60")
        self.assertEqual((quiet.returncode, quiet.stderr), (0, ""))
        noted = helper("check", "--benches", "61")
        self.assertEqual(noted.returncode, 0)
        self.assertEqual(noted.stderr.count("provider note (not enforced)"), 1)
        self.assertIn("Azure Foundry gpt-6-sol: 13,330,000 tokens/min", noted.stderr)
        self.assertIn("overflow is served by OpenRouter (no rate limit, credit-bound)", noted.stderr)
        # Informational overflow never refuses, and never alters the refusal text.
        value = registry_value()
        value["enforced"][0]["limit"] = 6000
        value["enforced"][1]["limit"] = 1500
        wide = self.registry_file(value)
        result = helper("check", "--benches", "600", CLOUDBENCH_PROVIDER_LIMITS_FILE=str(wide))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count("provider note (not enforced)"), 3)

    def test_provider_capacity_invalid_registry_fails_closed(self) -> None:
        def broken(change) -> dict:
            value = registry_value()
            change(value)
            return value
        cases = {
            "extra key": broken(lambda v: v.update(skip=True)),
            "schema": broken(lambda v: v.update(schema="other")),
            "no enforced": broken(lambda v: v.update(enforced=[])),
            "zero limit": broken(lambda v: v["enforced"][0].update(limit=0)),
            "boolean peak": broken(lambda v: v["enforced"][0].update(per_bench_peak=True)),
            "string limit": broken(lambda v: v["enforced"][1].update(limit="150")),
            "reserve one": broken(lambda v: v.update(production_reserve_fraction=1)),
            "duplicate id": broken(lambda v: v["enforced"][1].update(id=v["enforced"][0]["id"])),
            "missing field": broken(lambda v: v["enforced"][0].pop("credential_env")),
        }
        for label, value in cases.items():
            with self.subTest(label):
                path = self.registry_file(value, label.replace(" ", "-") + ".json")
                result = helper("check", "--benches", "1", CLOUDBENCH_PROVIDER_LIMITS_FILE=str(path))
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn("provider limit registry", result.stderr)
        nan = self.tmp / "nan.json"
        nan.write_text(REGISTRY.read_text().replace('"limit": 600,', '"limit": NaN,'))
        link = self.tmp / "link.json"
        link.symlink_to(REGISTRY)
        for label, value in {"nan": str(nan), "symlink": str(link), "missing": str(self.tmp / "absent.json"),
                             "relative": "limits.json", "empty": ""}.items():
            with self.subTest(label):
                result = helper("check", "--benches", "1", CLOUDBENCH_PROVIDER_LIMITS_FILE=value)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertNotIn("Traceback", result.stderr)

    def test_provider_capacity_has_no_bypass_option(self) -> None:
        usage = helper("check", "--help").stdout
        # --browser-provider only selects which provider-scoped rows bind; it
        # cannot raise any unscoped row's cap.
        self.assertEqual(sorted({word.rstrip(",]") for word in usage.split() if word.startswith("--")}),
                         ["--benches", "--browser-provider", "--help"])
        for flag in ("--force", "--skip", "--allow-over-cap"):
            self.assertEqual(helper("check", "--benches", "600", flag).returncode, 2)
        # Unrelated env vars change nothing; the refusal is identical.
        self.assertEqual(helper("check", "--benches", "600", CLOUDBENCH_PROVIDER_CAPACITY_SKIP="1",
                                CLOUDBENCH_SKIP_PROVIDER_LIMITS="1").stderr, REFUSAL_600)


class ProviderCapacityBrowserProviderTests(unittest.TestCase):
    """The Tilion pilot (20 browsers, one shared account) binds Tilion fleets only."""

    TILION_LINE = ("  - Tilion browser sessions: 20 concurrent browsers, pilot plan (TILION_API_KEY) → max 16 "
                   "concurrent benches (peak 1 sessions per bench, assumed, not yet measured on Tilion)")

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="provider-capacity-browser-"))
        self.addCleanup(shutil.rmtree, self.tmp)
        # A copied root controls back-end/.env, the default provider source.
        self.root = self.tmp / "root"
        (self.root / "scripts").mkdir(parents=True)
        (self.root / "back-end").mkdir()
        for member in MEMBERS:
            shutil.copy2(ROOT / "scripts" / member, self.root / "scripts" / member)

    def copied(self, *argv: str, backend_env: str | None = None, **env: str) -> subprocess.CompletedProcess[str]:
        if backend_env is not None:
            (self.root / "back-end/.env").write_text(backend_env)
        environment = clean_env(**env)
        if "CLOUDBENCH_BROWSER_PROVIDER" not in env:
            environment.pop("CLOUDBENCH_BROWSER_PROVIDER")
        return subprocess.run([sys.executable, "-I", "-S", "-B", str(self.root / "scripts" / MEMBERS[0]), *argv],
                              env=environment, capture_output=True, text=True, timeout=30)

    def test_tilion_row_is_scoped_to_tilion_fleets(self) -> None:
        rows = {row["id"]: row for row in registry_value()["enforced"]}
        self.assertEqual(rows["tilion-browser-sessions"]["browser_provider"], "tilion")
        self.assertEqual(rows["tilion-browser-sessions"]["limit"], 20)
        self.assertNotIn("browser_provider", rows["kernel-browser-sessions"])
        self.assertEqual(expected_cap(registry_value(), "tilion")[0], 16)
        for provider in ("kernel", "steel", "browser-use"):
            with self.subTest(provider):
                self.assertEqual(helper("cap", "--browser-provider", provider).stdout, "70\n")
                fits = helper("check", "--benches", "70", "--browser-provider", provider)
                self.assertEqual(fits.returncode, 0, fits.stderr)
                self.assertNotIn("Tilion", fits.stderr)
        self.assertEqual(helper("cap", "--browser-provider", "tilion").stdout, "16\n")
        self.assertEqual(helper("check", "--benches", "16", "--browser-provider", "tilion").returncode, 0)
        over = helper("check", "--benches", "17", "--browser-provider", "tilion")
        self.assertEqual(over.returncode, 78)
        self.assertEqual([line for line in over.stderr.splitlines() if line.startswith("  - ")], [self.TILION_LINE])
        self.assertIn("rerun with a lower concurrency (16 or fewer concurrent benches)", over.stderr)
        table = json.loads(helper("cap", "--json", "--browser-provider", "tilion").stdout)
        self.assertEqual((table["browser_provider"], table["max_concurrent_benches"]), ("tilion", 16))
        kernel = json.loads(helper("cap", "--json").stdout)
        self.assertNotIn("tilion-browser-sessions", {row["id"] for row in kernel["enforced"]})

    def test_provider_source_order_and_fail_closed_default(self) -> None:
        cases = [
            ("env selects tilion", 16, {"CLOUDBENCH_BROWSER_PROVIDER": "tilion"}, 'BROWSER_PROVIDER="kernel"\n'),
            ("backend env tilion", 16, {}, 'OTHER=1\nBROWSER_PROVIDER="tilion" # default\n'),
            ("backend env kernel", 70, {}, "BROWSER_PROVIDER=kernel\n"),
            ("backend env last wins", 16, {}, "BROWSER_PROVIDER=kernel\nBROWSER_PROVIDER='tilion'\n"),
            ("no provider anywhere binds every row", 16, {}, "OTHER=1\n"),
            ("unknown provider binds every row", 16, {}, "BROWSER_PROVIDER=browserbase\n"),
        ]
        for label, cap, env, backend_env in cases:
            with self.subTest(label):
                result = self.copied("cap", backend_env=backend_env, **env)
                self.assertEqual((result.returncode, result.stdout), (0, f"{cap}\n"), result.stderr)
        explicit = self.copied("cap", "--browser-provider", "kernel", backend_env="BROWSER_PROVIDER=tilion\n",
                               CLOUDBENCH_BROWSER_PROVIDER="tilion")
        self.assertEqual(explicit.stdout, "70\n")
        self.assertEqual(self.copied("cap", "--browser-provider", "browserbase").returncode, 2)

    def test_scoped_row_validation_fails_closed(self) -> None:
        value = registry_value()
        value["enforced"][2]["browser_provider"] = "browserbase"
        bad = self.tmp / "bad.json"
        bad.write_text(json.dumps(value))
        result = helper("check", "--benches", "1", CLOUDBENCH_PROVIDER_LIMITS_FILE=str(bad))
        self.assertEqual(result.returncode, 2)
        self.assertIn("browser_provider must be one of", result.stderr)
        value = registry_value()
        value["informational"][0]["browser_provider"] = "tilion"
        bad.write_text(json.dumps(value))
        self.assertEqual(helper("check", "--benches", "1", CLOUDBENCH_PROVIDER_LIMITS_FILE=str(bad)).returncode, 2)
        value = registry_value()
        value["enforced"][2]["demand_measurement"] = ""
        bad.write_text(json.dumps(value))
        self.assertEqual(helper("check", "--benches", "1", CLOUDBENCH_PROVIDER_LIMITS_FILE=str(bad)).returncode, 2)

    def test_tilion_cap_binds_a_tilion_fleet_before_any_provider_call(self) -> None:
        fakebin = self.tmp / "bin"
        fakebin.mkdir()
        calls = self.tmp / "provider-calls"
        for name in ("fly", "flyctl", "curl"):
            path = fakebin / name
            path.write_text(f'#!/bin/sh\necho "{name} $*" >> {calls}\nexit 99\n')
            path.chmod(0o700)
        result = subprocess.run(
            ["bash", str(FLEET), "demo-fleet-alpha"], cwd=ROOT,
            env=clean_env(PATH=f"{fakebin}:{os.environ['PATH']}", TMPDIR=str(self.tmp),
                          CLOUDBENCH_BROWSER_PROVIDER="tilion", CLOUDBENCH_CAMPAIGN_CONCURRENT_GUESTS="17"),
            capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
        self.assertIn("requested 17 concurrent benches, maximum 16.", result.stderr)
        self.assertIn(self.TILION_LINE, result.stderr)
        self.assertFalse(calls.exists())


class ProviderCapacityCampaignTests(unittest.TestCase):
    def setUp(self) -> None:
        # In-process helper calls need the same isolated policy as subprocesses.
        environment = patch.dict(os.environ, clean_env(), clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.tmp = Path(tempfile.mkdtemp(prefix="provider-capacity-campaign-"))
        self.addCleanup(shutil.rmtree, self.tmp)
        # A disposable control root: the real helper/registry and a run-bench
        # that only records an invocation. Refusal must precede every child.
        self.root = self.tmp / "root"
        (self.root / "scripts").mkdir(parents=True)
        for member in MEMBERS:
            shutil.copy2(ROOT / "scripts" / member, self.root / "scripts" / member)
        self.child_marker = self.tmp / "child-launched"
        run_bench = self.root / "scripts/run-bench"
        run_bench.write_text(f"#!/bin/sh\n: > {self.child_marker}\nexit 1\n")
        run_bench.chmod(0o700)
        self.campaigns = self.tmp / "campaigns"

    def campaign(self, *, tasks: int, runs: int, concurrency: int, **env: str) -> subprocess.CompletedProcess[str]:
        argv = [sys.executable, str(CAMPAIGN), f"--root={self.root}", f"--runs={runs}",
                f"--concurrency={concurrency}", *[f"--task=task-{index:03d}" for index in range(tasks)]]
        return subprocess.run(argv, env=clean_env(RUN_BENCH_CAMPAIGN_ROOT=str(self.campaigns), **env),
                              capture_output=True, text=True, timeout=60)

    def assert_no_campaign_started(self) -> None:
        self.assertFalse(self.child_marker.exists())
        self.assertFalse(self.campaigns.exists())

    def test_provider_capacity_sharded_campaign_counts_the_global_group(self) -> None:
        # One 30-copy shard of a 600-copy sharded group (10 tasks x k3).
        result = self.campaign(tasks=10, runs=3, concurrency=30, RUN_BENCH_CAMPAIGN_GROUP_TOTAL="600",
                               BENCHMARK_HUB_GROUP_RUN_ID="provider-capacity-fixture-group")
        self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
        self.assertIn(REFUSAL_600, result.stderr)
        self.assert_no_campaign_started()

    def test_provider_capacity_campaign_width_refuses_before_any_controller(self) -> None:
        result = self.campaign(tasks=71, runs=1, concurrency=71)
        self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
        self.assertIn("requested 71 concurrent benches, maximum 70.", result.stderr)
        self.assertIn(PARALLEL_LINE, result.stderr)
        self.assert_no_campaign_started()

    def test_provider_capacity_campaign_simultaneous_width(self) -> None:
        module = runpy.run_path(str(CAMPAIGN))
        width = module["campaign_simultaneous_benches"]
        refusal = module["provider_capacity_refusal"]
        self.assertEqual(width(30, 30, 600), 600)   # shard of a sharded group
        self.assertEqual(width(50, 600, None), 50)  # bounded sliding campaign
        self.assertEqual(width(100, 10, None), 10)  # fewer jobs than width
        self.assertEqual(width(70, 70, None), 70)
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(refusal(70), 0)
            self.assertEqual(refusal(71), 78)
        self.assertIn("requested 71 concurrent benches, maximum 70.", stderr.getvalue())
        self.assertEqual(module["PROVIDER_GLOBAL_BENCHES_ENV"], "CLOUDBENCH_CAMPAIGN_GLOBAL_BENCHES")
        # Children receive the whole group's width for their own fleet check.
        self.assertIn("PROVIDER_GLOBAL_BENCHES_ENV: str(global_benches)", CAMPAIGN.read_text())


class ProviderCapacityFleetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="provider-capacity-fleet-"))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.fakebin = self.tmp / "bin"
        self.fakebin.mkdir()
        self.provider_calls = self.tmp / "provider-calls"
        for name in ("fly", "flyctl", "curl"):
            path = self.fakebin / name
            path.write_text(f'#!/bin/sh\necho "{name} $*" >> {self.provider_calls}\nexit 99\n')
            path.chmod(0o700)

    def fleet(self, *benches: str, **env: str) -> subprocess.CompletedProcess[str]:
        environment = clean_env(PATH=f"{self.fakebin}:{os.environ['PATH']}", TMPDIR=str(self.tmp), **env)
        return subprocess.run(["bash", str(FLEET), *benches], cwd=ROOT, env=environment,
                              capture_output=True, text=True, timeout=120)

    def test_provider_capacity_fleet_child_counts_its_sharded_group_before_provider_calls(self) -> None:
        result = self.fleet("demo-fleet-alpha", CLOUDBENCH_CAMPAIGN_CONCURRENT_GUESTS="30",
                            CLOUDBENCH_CAMPAIGN_GLOBAL_BENCHES="600")
        self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
        self.assertIn(REFUSAL_600, result.stderr)
        self.assertFalse(self.provider_calls.exists(), self.provider_calls.read_text() if self.provider_calls.exists() else "")
        self.assertEqual(list(self.tmp.glob("cloudbench-scripts.*")), [])  # owned script snapshot retired

    def test_provider_capacity_fleet_campaign_width_and_inherited_widths_only_raise(self) -> None:
        guests = self.fleet("demo-fleet-alpha", CLOUDBENCH_CAMPAIGN_CONCURRENT_GUESTS="71")
        self.assertEqual(guests.returncode, 78, guests.stdout + guests.stderr)
        self.assertIn("requested 71 concurrent benches, maximum 70.", guests.stderr)
        # A tiny validated registry (cap 1): two benches cannot be lowered to one.
        value = registry_value()
        value["enforced"][0]["limit"] = 10
        tiny = self.tmp / "tiny-limits.json"
        tiny.write_text(json.dumps(value))
        lowered = self.fleet("demo-fleet-alpha", "demo-fleet-beta", CLOUDBENCH_CAMPAIGN_GLOBAL_BENCHES="1",
                             CLOUDBENCH_CAMPAIGN_CONCURRENT_GUESTS="1", CLOUDBENCH_PROVIDER_LIMITS_FILE=str(tiny))
        self.assertEqual(lowered.returncode, 78, lowered.stdout + lowered.stderr)
        self.assertIn("requested 2 concurrent benches, maximum 1.", lowered.stderr)
        for value in ("abc", "0", "007", "-1"):
            with self.subTest(value):
                invalid = self.fleet("demo-fleet-alpha", CLOUDBENCH_CAMPAIGN_GLOBAL_BENCHES=value)
                self.assertEqual(invalid.returncode, 2, invalid.stderr)
                self.assertIn("CLOUDBENCH_CAMPAIGN_GLOBAL_BENCHES must be a positive integer", invalid.stderr)
        self.assertFalse(self.provider_calls.exists())


class ProviderCapacityLocalTests(unittest.TestCase):
    def test_provider_capacity_local_width_refuses_before_any_stack(self) -> None:
        with tempfile.TemporaryDirectory(prefix="provider-capacity-local-") as name:
            value = registry_value()
            value["enforced"][0]["limit"] = 10  # validated registry with cap 1
            tiny = Path(name) / "tiny-limits.json"
            tiny.write_text(json.dumps(value))
            result = subprocess.run(
                [sys.executable, "benchmarks/local.py", "--max-concurrency", "2", "demo-fleet-alpha", "demo-fleet-beta"],
                cwd=ROOT / "agents", env=clean_env(CLOUDBENCH_PROVIDER_LIMITS_FILE=str(tiny)),
                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
        self.assertIn("requested 2 concurrent benches, maximum 1.", result.stderr)
        self.assertNotIn("Starting", result.stdout)
        local = (ROOT / "agents/benchmarks/local.py").read_text()
        self.assertIn('enforce_provider_capacity(min(args.max_concurrency, len(selected_tasks)))', local)
        self.assertLess(local.index("enforce_provider_capacity(min("), local.index("stack = build_service_stack(args)"))
        self.assertLess(local.index("enforce_provider_capacity(min("), local.index("return run_task_worlds("))


if __name__ == "__main__":
    unittest.main()
