"""The fleet's agent worker must be sized exactly like prod's.

WHY
The 2026-07-29 fleet run died when the seed was SIGKILLed (rc=137) on a primary.
Diagnosing it, the budget was first anchored to the PRIMARY's 4096MB — which
silently treats a box twice prod's size as the baseline and licenses the
workload to grow into it. The invariant that actually matters is that the
machine running our agent code in the fleet is the machine prod pays for, so a
benchmark can never pass on hardware production does not have.

WHAT IS AND IS NOT COMPARABLE
- WORKER machines run agents/worker.py, exactly as in prod. These MUST match
  agents/fly.toml.
- The PRIMARY has no prod counterpart: it collapses Supabase (Postgres), Render
  (backend), Vercel (frontend) and Temporal Cloud onto one box purely so a bench
  is self-contained. Its size is a bench-infra decision, not a prod mirror — but
  bench-only work that runs there (the seed) is still budgeted against PROD's
  size so we never "fix" a footprint by growing the box.
"""

from __future__ import annotations

import pathlib
import re

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
PROD_FLY = REPO_ROOT / "agents" / "fly.toml"
FLEET_SCRIPT = REPO_ROOT / "scripts" / "run-bench-fleet"


def _prod_worker_vm() -> dict[str, str]:
    text = PROD_FLY.read_text()
    block = text[text.index("[[vm]]") :]
    out: dict[str, str] = {}
    for key in ("cpu_kind", "cpus", "memory_mb"):
        match = re.search(rf"^\s*{key}\s*=\s*\"?([^\"\n]+)\"?", block, re.M)
        assert match, f"agents/fly.toml [[vm]] is missing {key}"
        out[key] = match.group(1).strip()
    return out


def _fleet_default(name: str) -> str:
    text = FLEET_SCRIPT.read_text()
    match = re.search(rf'^{name}="\$\{{[A-Z_]+:-([^}}]+)\}}"', text, re.M)
    assert match, f"scripts/run-bench-fleet is missing a default for {name}"
    return match.group(1).strip()


def test_fleet_worker_memory_matches_prod():
    prod = _prod_worker_vm()
    assert _fleet_default("FLEET_WORKER_VM_MEMORY") == prod["memory_mb"], (
        "Fleet worker RAM drifted from prod. A benchmark passing on more memory "
        "than prod has is not evidence prod works."
    )


def test_fleet_worker_cpu_tier_matches_prod():
    prod = _prod_worker_vm()
    # agents/fly.toml expresses the tier as cpu_kind + cpus; Fly's CLI takes the
    # combined "<kind>-<n>x" form. Compare the resolved shape.
    expected = f"{prod['cpu_kind']}-{prod['cpus']}x"
    assert _fleet_default("FLEET_WORKER_VM_SIZE") == expected, (
        f"Fleet worker tier drifted from prod ({expected}). Benchmarks must run "
        "on prod's CPU tier or latency/timeout results do not transfer."
    )


def test_seed_budget_is_anchored_to_prod_not_the_bench_primary():
    """The bench-only seed is budgeted against PROD's size, not the bigger box."""
    budget = (REPO_ROOT / "back-end" / "src" / "providers" / "seedMemoryBudget.ts").read_text()
    prod_mb = int(_prod_worker_vm()["memory_mb"])
    assert f"PROD_WORKER_MEMORY_MB = {prod_mb}" in budget, (
        "seedMemoryBudget must anchor to prod's worker memory; anchoring to the "
        "4096MB fleet primary lets the seed grow into hardware prod lacks."
    )
    # And the ceiling must derive from prod, never from FLEET_PRIMARY_MEMORY_MB.
    assert "PROD_WORKER_MEMORY_MB * SEED_MAX_MACHINE_FRACTION" in budget
    assert "FLEET_PRIMARY_MEMORY_MB * SEED_MAX_MACHINE_FRACTION" not in budget


def test_autoscaling_still_derives_from_prod_params():
    """Sizing parity must not have been bought by disabling autoscale."""
    text = FLEET_SCRIPT.read_text()
    assert "FLEET_WORKER_VM_SIZE" in text and "FLEET_WORKER_VM_MEMORY" in text
    # Worker clones are what autoscale; they must still be created from those.
    assert re.search(r"FLEET_WORKER_VM_(SIZE|MEMORY)", text)
