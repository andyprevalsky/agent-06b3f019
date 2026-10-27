#!/usr/bin/env python3
"""Sample ready catalog task names for fleet stability proofs.

Fleet ``--infra-probe`` still runs catalog preflight, so canaries MUST use
real unified-catalog names (``tasks.json`` + ``polar_tasks.json``). Fake
``infra-canary-$i`` names fail closed before Fly provisioning.

This helper is shared by:
  - ``scripts/run-fleet-infra-canary``
  - ``scripts/run-fleet-infra-stability-proof``
"""

from __future__ import annotations

import argparse
import json
import os
import random
import runpy
import sys
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

from cloudbench_catalog import CatalogError, load_unified_catalog


def catalog_path(repo_root: Path) -> Path:
    return repo_root / "agents" / "benchmarks" / "tasks.json"


def load_pool(repo_root: Path) -> list[str]:
    tasks = load_unified_catalog(catalog_path(repo_root))
    names = [
        str(task["name"])
        for task in tasks
        if isinstance(task, dict)
        and task.get("name")
        and task.get("status", "ready") == "ready"
    ]
    if not names:
        raise CatalogError("unified catalog produced an empty name pool")
    return names


def configured_callee_names(repo_root: Path) -> set[str] | None:
    """Mirror the benchmark's env lookup before admitting phone-callee tasks.

    An empty mapping leaves the benchmark's dynamic-number path available.
    A nonempty mapping makes every phone persona require an exact assignment,
    and tasks sharing one number are unassigned: a run attaches its persona to
    that number, so concurrent runs would answer each other's calls.
    """
    key = "BENCHMARK_CALLEE_PHONE_NUMBER_IDS"
    raw = os.environ.get(key, "")
    if not raw:
        path = repo_root / "back-end" / ".env"
        if path.is_file():
            for line in path.read_text().splitlines():
                line = line.strip()
                if line.startswith(key + "="):
                    raw = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if " #" in raw:
                        raw = raw[: raw.index(" #")].rstrip()
                    break
    if not raw:
        return None
    assignments: dict[str, str] = {}
    for entry in raw.split(","):
        name, separator, number_id = entry.strip().partition("=")
        if not separator or not name or not number_id or name in assignments:
            raise ValueError(f"invalid {key} task assignment")
        assignments[name] = number_id
    shared = Counter(assignments.values())
    return {name for name, number_id in assignments.items() if shared[number_id] == 1}


def eligible_pool(
    repo_root: Path, pool_file: Path | None, exclude_file: Path | None = None,
    *, require_cloud_root: bool = False, minimum_successful_llm: int = 0,
) -> list[str]:
    if minimum_successful_llm != 0 and minimum_successful_llm < 3:
        raise ValueError("minimum successful LLM queries must be zero or at least three")
    catalog = load_pool(repo_root)
    names = catalog
    if pool_file is not None:
        names = json.loads(pool_file.read_text())
        if not isinstance(names, list) or not names or any(
            not isinstance(name, str) for name in names
        ):
            raise ValueError("eligibility pool must be a nonempty JSON name list")
        if len(names) != len(set(names)):
            raise ValueError("eligibility pool contains duplicate names")
        unknown = set(names) - set(catalog)
        if unknown:
            raise ValueError(f"eligibility pool contains non-ready tasks: {sorted(unknown)}")
    if require_cloud_root:
        # The SMS supervisor is a rootless backend loop. Capability proof
        # requires a root-anchored archive and >=3 correlated live LLM calls;
        # reject it before provisioning rather than failing at teardown.
        unified = load_unified_catalog(catalog_path(repo_root))
        rootless = {
            str(task["name"])
            for task in unified
            if isinstance(task, dict) and task.get("runner") == "sms"
        }
        # The live iMessage bench explicitly needs an authenticated Mac app
        # polling its backend. A Linux/cloud controller rejects it before the
        # agent starts and cannot produce the required runtime/LLM evidence.
        mac_relay = {
            str(task["name"])
            for task in unified
            if isinstance(task, dict)
            and "macOS Messages bridge" in (task.get("environment") or {}).get("services", [])
        }
        production_only = {
            str(task["name"])
            for task in unified
            if isinstance(task, dict) and task.get("production_only") is True
        }
        callee_names = configured_callee_names(repo_root)
        unassigned_callees = {
            str(task["name"])
            for task in unified
            if isinstance(task, dict) and task.get("phone_persona")
            and callee_names is not None and str(task.get("name")) not in callee_names
        }
        selected_rootless = set(names) & rootless
        if pool_file is not None and selected_rootless:
            raise ValueError(
                "capability proof requires cloud-root tasks; rootless SMS tasks: "
                f"{sorted(selected_rootless)}"
            )
        selected_mac_relay = set(names) & mac_relay
        if pool_file is not None and selected_mac_relay:
            raise ValueError(
                "capability proof requires Linux/cloud runnable tasks; Mac Messages relay tasks: "
                f"{sorted(selected_mac_relay)}"
            )
        selected_production_only = set(names) & production_only
        if pool_file is not None and selected_production_only:
            raise ValueError(
                "capability proof requires isolated-stack tasks; production-only tasks: "
                f"{sorted(selected_production_only)}"
            )
        selected_unassigned_callees = set(names) & unassigned_callees
        if pool_file is not None and selected_unassigned_callees:
            raise ValueError(
                "capability proof requires configured callee numbers; unassigned phone tasks: "
                f"{sorted(selected_unassigned_callees)}"
            )
        names = [name for name in names
                 if name not in rootless | mac_relay | production_only | unassigned_callees]
    if minimum_successful_llm:
        # These tasks intentionally grade zero live spend. Their cache replay
        # cannot satisfy a live-completion proof without changing that contract.
        unified = load_unified_catalog(catalog_path(repo_root))
        zero_live_spend = {
            str(task["name"])
            for task in unified
            if any(check.get("type") == "zero_live_spend"
                   for evaluator in task.get("evaluators") or []
                   for check in evaluator.get("checks") or [])
        }
        selected_zero_live = set(names) & zero_live_spend
        if pool_file is not None and selected_zero_live:
            raise ValueError(
                "live-query proof cannot run zero-live-spend tasks: "
                f"{sorted(selected_zero_live)}"
            )
        # Replay admission is independent of the provider-speed button and can
        # include a DEMO-bound child without a DEMO tag or zero-spend evaluator.
        # Reuse the runtime's pure policy rather than duplicating its goal rules.
        sys.path.insert(0, str(repo_root / "agents"))
        try:
            replay_policy = runpy.run_path(str(
                repo_root / "agents/providers/demo_cache/normalize.py"))
        finally:
            sys.path.pop(0)
        demo_replay = {
            str(task["name"]) for task in unified
            if replay_policy["demo_cache_allowed"](task.get("prompt"))
        }
        selected_replay = set(names) & demo_replay
        if pool_file is not None and selected_replay:
            raise ValueError(
                "live-query proof cannot run DEMO-replay tasks: "
                f"{sorted(selected_replay)}"
            )
        names = [name for name in names if name not in zero_live_spend | demo_replay]
    if exclude_file is not None:
        excluded = json.loads(exclude_file.read_text())
        if not isinstance(excluded, list) or any(not isinstance(name, str) for name in excluded):
            raise ValueError("exclusion file must be a JSON name list")
        excluded_names = set(excluded)
        names = [name for name in names if name not in excluded_names]
        if not names:
            raise ValueError("exclusion file exhausted the eligible pool")
    return names


def sample_slice(
    pool: list[str], *, width: int, seed: int, slice_index: int, disjoint: bool = False
) -> list[str]:
    if width < 1:
        raise ValueError("width must be a positive integer")
    if width > len(pool):
        raise ValueError(f"width {width} exceeds catalog pool size {len(pool)}")
    if slice_index < 0:
        raise ValueError("slice index must be nonnegative")
    if disjoint:
        if width * (slice_index + 1) > len(pool):
            raise ValueError("disjoint slices exceed the eligible catalog pool")
        shuffled = list(pool)
        random.Random(int(seed)).shuffle(shuffled)
        return shuffled[width * slice_index : width * (slice_index + 1)]
    rng = random.Random(int(seed) ^ (int(slice_index) + 1))
    return rng.sample(pool, width)


def cmd_sample(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    try:
        pool = eligible_pool(
            repo, args.pool_file, args.exclude_file,
            require_cloud_root=args.require_cloud_root,
            minimum_successful_llm=args.min_successful_llm,
        )
        names = sample_slice(pool, width=args.width, seed=args.seed, slice_index=args.slice, disjoint=args.disjoint)
    except (CatalogError, ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps({"slice": args.slice, "seed": args.seed, "names": names}))
    else:
        print("\n".join(names))
    return 0


def cmd_dry_proof(args: argparse.Namespace) -> int:
    """Emit all slices for the stability proof; assert uniqueness within each."""
    repo = Path(args.repo).resolve()
    try:
        pool = eligible_pool(
            repo, args.pool_file, args.exclude_file,
            require_cloud_root=args.require_cloud_root,
            minimum_successful_llm=args.min_successful_llm,
        )
    except (CatalogError, ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"❌ {exc}", file=sys.stderr)
        return 2
    if args.width < 1:
        print("❌ width must be a positive integer", file=sys.stderr)
        return 2
    if args.width > len(pool):
        print(
            f"❌ width {args.width} exceeds catalog pool size {len(pool)}",
            file=sys.stderr,
        )
        return 2
    if args.runs < 1:
        print("❌ runs must be a positive integer", file=sys.stderr)
        return 2
    if args.disjoint and args.width * args.runs > len(pool):
        print("❌ disjoint slices exceed the eligible catalog pool", file=sys.stderr)
        return 2

    slices: list[dict[str, object]] = []
    for i in range(args.runs):
        names = sample_slice(pool, width=args.width, seed=args.seed, slice_index=i, disjoint=args.disjoint)
        if len(set(names)) != len(names):
            print(f"❌ slice {i} has duplicate names", file=sys.stderr)
            return 2
        unknown = [n for n in names if n not in pool]
        if unknown:
            print(f"❌ slice {i} left the catalog: {unknown}", file=sys.stderr)
            return 2
        slices.append({"slice": i, "names": names})

    payload = {
        "pool_size": len(pool),
        "runs": args.runs,
        "width": args.width,
        "seed": args.seed,
        "slices": slices,
    }
    print(json.dumps(payload, indent=2))
    print(
        f"OK dry-sample: {args.runs} slices × {args.width} from pool={len(pool)} "
        f"seed={args.seed}",
        file=sys.stderr,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    def add_repo(sp: argparse.ArgumentParser) -> None:
        sp.add_argument(
            "--repo",
            default=str(SCRIPT_DIR.parent),
            help="repository root (default: parent of scripts/)",
        )
        sp.add_argument(
            "--pool-file", type=Path,
            help="JSON list of ready names eligible for this proof; selection only",
        )
        sp.add_argument("--exclude-file", type=Path, help="JSON list of previously used names")
        sp.add_argument("--disjoint", action="store_true", help="never reuse a name across slices")
        sp.add_argument(
            "--min-successful-llm", type=int, default=0,
            help="exclude tasks whose zero-live-spend contract conflicts with this minimum",
        )
        sp.add_argument(
            "--require-cloud-root", action="store_true",
            help="exclude rootless and Mac-only runners from cloud capability proofs",
        )

    sample = sub.add_parser("sample", help="print one newline-separated slice")
    add_repo(sample)
    sample.add_argument("--width", type=int, required=True)
    sample.add_argument("--seed", type=int, required=True)
    sample.add_argument("--slice", type=int, default=0)
    sample.add_argument("--json", action="store_true")
    sample.set_defaults(func=cmd_sample)

    dry = sub.add_parser("dry-proof", help="print all proof slices as JSON (no Fly)")
    add_repo(dry)
    dry.add_argument("--runs", type=int, required=True)
    dry.add_argument("--width", type=int, required=True)
    dry.add_argument("--seed", type=int, required=True)
    dry.set_defaults(func=cmd_dry_proof)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
