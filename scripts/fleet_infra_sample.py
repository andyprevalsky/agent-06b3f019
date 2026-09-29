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
import random
import sys
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


def eligible_pool(
    repo_root: Path, pool_file: Path | None, exclude_file: Path | None = None
) -> list[str]:
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
        pool = eligible_pool(repo, args.pool_file, args.exclude_file)
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
        pool = eligible_pool(repo, args.pool_file, args.exclude_file)
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
