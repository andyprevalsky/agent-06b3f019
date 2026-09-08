#!/usr/bin/env python3
"""Sample catalog task names for $0 fleet infra probes.

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
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from cloudbench_catalog import CatalogError, load_unified_catalog  # noqa: E402


def catalog_path(repo_root: Path) -> Path:
    return repo_root / "agents" / "benchmarks" / "tasks.json"


def load_pool(repo_root: Path) -> list[str]:
    tasks = load_unified_catalog(catalog_path(repo_root))
    names = [str(t["name"]) for t in tasks if isinstance(t, dict) and t.get("name")]
    if not names:
        raise CatalogError("unified catalog produced an empty name pool")
    return names


def sample_slice(pool: list[str], *, width: int, seed: int, slice_index: int) -> list[str]:
    if width < 1:
        raise ValueError("width must be a positive integer")
    if width > len(pool):
        raise ValueError(f"width {width} exceeds catalog pool size {len(pool)}")
    rng = random.Random(int(seed) ^ (int(slice_index) + 1))
    return rng.sample(pool, width)


def cmd_sample(args: argparse.Namespace) -> int:
    repo = Path(args.repo).resolve()
    try:
        pool = load_pool(repo)
        names = sample_slice(pool, width=args.width, seed=args.seed, slice_index=args.slice)
    except (CatalogError, ValueError) as exc:
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
        pool = load_pool(repo)
    except CatalogError as exc:
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

    slices: list[dict[str, object]] = []
    for i in range(args.runs):
        names = sample_slice(pool, width=args.width, seed=args.seed, slice_index=i)
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
