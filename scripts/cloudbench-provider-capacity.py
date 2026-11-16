#!/usr/bin/env python3
"""Refuse benchmark concurrency above the measured provider rate-limit cap.

Benchmark guests share provider keys with production. For every *enforced*
provider in the reviewed registry (exhaustion is task-visible and has no
unlimited fallback) the cap is

    floor(limit * (1 - production_reserve_fraction) / per_bench_peak)

and the overall cap is the minimum across enforced providers that apply to the
fleet's browser provider. A row with `browser_provider` (Tilion: one shared
250-browser account) binds only fleets on that provider; every other row binds all
fleets. The browser provider is `--browser-provider`, else
CLOUDBENCH_BROWSER_PROVIDER, else BROWSER_PROVIDER in back-end/.env (the bench
env contract later requires it to equal production). When none is a known
provider, every row binds (fail closed). Informational
providers (exhaustion falls back and recovers) never refuse a run; they are
printed as notes once the requested width exceeds their own cap.

Per-bench peaks default to the global mixed-census measurement (run600c). A
reviewed `demand_profiles` entry records a lighter measured peak for one
catalog task group (e.g. polar-bench barely calls web search). It replaces
only the rows it measured, and only when EVERY `--task` belongs to that group
in agents/benchmarks/{tasks,polar_tasks}.json:

    --task polar-bu-001 --task polar-odysseys-…   → polar-bench profile peaks
    mixed, unknown, uncatalogued or no --task      → global peaks (today's cap)

A profile may only lower a row's peak, so a fleet that admits under a profile
contains only that group's tasks; any wider global width that also carries
other tasks is refused by those tasks' own (global) check.

Usage:
    cloudbench-provider-capacity.py check --benches N [--browser-provider P] [--task T ...]  # exit 0, or 78
    cloudbench-provider-capacity.py cap [--json] [--browser-provider P] [--task T ...]       # print the cap
    cloudbench-provider-capacity.py delegating --benches N [--task T ...]                    # exit 0, or 78

`delegating` is the separate app-wide delegating-guest ceiling that fleet
admission (scripts/run-bench-fleet admit_lane_capacity) applies to live REAL/SIM
primaries across devboxes: CLOUDBENCH_DELEGATING_PRIMARY_CEILING, default 70.
A launch whose own simultaneous REAL/SIM width exceeds it can never be admitted,
so cloud launchers refuse it up front instead of waiting out admission.

There is no bypass: raising the cap means recording new provider limits in
scripts/cloudbench-provider-limits.json in a reviewed change.
CLOUDBENCH_PROVIDER_LIMITS_FILE may select another registry, which is
validated identically to the canonical one and announced on stderr.
Standard library only; no provider or network calls.
"""
from __future__ import annotations

import argparse
from decimal import Decimal
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import re
import sys

SCHEMA = "cloudbench-provider-limits-v1"
CANONICAL_REGISTRY = Path(__file__).resolve().with_name("cloudbench-provider-limits.json")
CANONICAL_LABEL = "scripts/cloudbench-provider-limits.json"
REGISTRY_ENV = "CLOUDBENCH_PROVIDER_LIMITS_FILE"
BROWSER_PROVIDER_ENV = "CLOUDBENCH_BROWSER_PROVIDER"
BACKEND_ENV_FILE = Path(__file__).resolve().parents[1] / "back-end" / ".env"
TASK_CATALOGS = tuple(Path(__file__).resolve().parents[1] / "agents" / "benchmarks" / name
                      for name in ("tasks.json", "polar_tasks.json"))
MAX_CATALOG_BYTES = 32 * 1024 * 1024
BROWSER_PROVIDERS = ("tilion", "kernel", "steel", "browser-use")
MAX_ENV_BYTES = 1024 * 1024
EXIT_REFUSED = 78  # EX_CONFIG: provider configuration cannot serve this width.
# The same override and default as scripts/run-bench-fleet admit_lane_capacity.
DELEGATING_CEILING_ENV = "CLOUDBENCH_DELEGATING_PRIMARY_CEILING"
DEFAULT_DELEGATING_CEILING = 70
LANE_ENV = "CLOUDBENCH_LANE"
EXIT_INVALID = 2
MAX_REGISTRY_BYTES = 256 * 1024

_TOP_KEYS = {"schema", "production_reserve_fraction", "production_reserve_note",
             "measurement", "enforced", "informational"}
_MEASUREMENT_KEYS = {"id", "date", "concurrent_benches", "source"}
_PROVIDER_KEYS = {"id", "name", "limit", "limit_unit", "limit_qualifier", "credential_env",
                  "per_bench_peak", "per_bench_peak_unit", "limit_source", "demand_source"}
_ENFORCED_KEYS = _PROVIDER_KEYS | {"exhaustion"}
_INFORMATIONAL_KEYS = _PROVIDER_KEYS | {"fallback"}
_PROFILE_KEYS = {"id", "task_group", "date", "per_bench_peak", "demand_measurement", "demand_source"}


class RegistryError(ValueError):
    """The provider-limit registry is missing or malformed (fail closed)."""


def _text(value: object, field: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value.strip() or value != value.strip() or "\n" in value:
        raise RegistryError(f"provider limit registry: {field} must be a nonempty one-line string")
    return value


def _positive(value: object, field: str) -> Fraction:
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise RegistryError(f"provider limit registry: {field} must be a number")
    if isinstance(value, Decimal) and not value.is_finite():
        raise RegistryError(f"provider limit registry: {field} must be finite")
    exact = Fraction(value)
    if exact <= 0:
        raise RegistryError(f"provider limit registry: {field} must be positive")
    return exact


def _number_text(value: int | Decimal) -> str:
    """600 -> '600', 13330000 -> '13,330,000', 6.83 -> '6.83' (exact registry digits)."""
    if isinstance(value, int) or value == value.to_integral_value():
        return f"{int(value):,}"
    return format(value.normalize(), "f")


def _provider(row: object, field: str, keys: set[str], reserve: Fraction) -> dict:
    optional = {"browser_provider", "demand_measurement"} if keys == _ENFORCED_KEYS else set()
    scoped = isinstance(row, dict) and "browser_provider" in row and "browser_provider" in optional
    expected = keys | (optional & set(row)) if isinstance(row, dict) else keys
    if not isinstance(row, dict) or set(row) != expected:
        raise RegistryError(f"provider limit registry: {field} must have exactly {sorted(keys)}"
                            + (" (enforced rows may add browser_provider, demand_measurement)"
                               if keys == _ENFORCED_KEYS else ""))
    if scoped and row["browser_provider"] not in BROWSER_PROVIDERS:
        raise RegistryError(f"provider limit registry: {field}.browser_provider must be one of {list(BROWSER_PROVIDERS)}")
    if "demand_measurement" in row:
        _text(row["demand_measurement"], field + ".demand_measurement")
    provider_id = _text(row["id"], field + ".id")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,63}", provider_id):
        raise RegistryError(f"provider limit registry: {field}.id must be a lowercase slug")
    for key in ("name", "limit_unit", "per_bench_peak_unit", "limit_source", "demand_source"):
        _text(row[key], f"{field}.{key}")
    _text(row["limit_qualifier"], field + ".limit_qualifier", nullable=True)
    credential = _text(row["credential_env"], field + ".credential_env")
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*\*?", credential):
        raise RegistryError(f"provider limit registry: {field}.credential_env must name an env key")
    limit = _positive(row["limit"], field + ".limit")
    peak = _positive(row["per_bench_peak"], field + ".per_bench_peak")
    return dict(row, cap=_cap(limit, peak, reserve))


def _cap(limit: Fraction, peak: Fraction, reserve: Fraction) -> int:
    return math.floor(limit * (1 - reserve) / peak)


def _profile(row: object, field: str, providers: dict[str, dict]) -> dict:
    """One measured task-group demand profile; it may only lower a provider's peak."""
    if not isinstance(row, dict) or set(row) != _PROFILE_KEYS:
        raise RegistryError(f"provider limit registry: {field} must have exactly {sorted(_PROFILE_KEYS)}")
    profile_id = _text(row["id"], field + ".id")
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,63}", profile_id):
        raise RegistryError(f"provider limit registry: {field}.id must be a lowercase slug")
    for key in ("task_group", "demand_measurement", "demand_source"):
        _text(row[key], f"{field}.{key}")
    if not isinstance(row["date"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", row["date"]):
        raise RegistryError(f"provider limit registry: {field}.date must be YYYY-MM-DD")
    peaks = row["per_bench_peak"]
    if not isinstance(peaks, dict) or not peaks:
        raise RegistryError(f"provider limit registry: {field}.per_bench_peak must map provider ids to peaks")
    exact = {}
    for provider_id, value in peaks.items():
        if provider_id not in providers:
            raise RegistryError(f"provider limit registry: {field}.per_bench_peak names unknown provider {provider_id!r}")
        exact[provider_id] = _positive(value, f"{field}.per_bench_peak.{provider_id}")
        if exact[provider_id] > Fraction(providers[provider_id]["per_bench_peak"]):
            raise RegistryError(f"provider limit registry: {field}.per_bench_peak.{provider_id} may only lower "
                                "the provider's global per_bench_peak")
    return dict(row, peaks=exact)


def load_registry(path: Path | None = None) -> dict:
    """Read and validate one registry; the canonical file unless explicitly selected."""
    selected = path
    if selected is None:
        override = os.environ.get(REGISTRY_ENV)
        if override is not None:
            if not override or not Path(override).is_absolute():
                raise RegistryError(f"{REGISTRY_ENV} must be an absolute registry path")
            selected = Path(override)
    selected = selected or CANONICAL_REGISTRY
    try:
        if selected.is_symlink() or not selected.is_file():
            raise RegistryError(f"provider limit registry is not a regular file: {selected}")
        raw = selected.read_bytes()
    except OSError as error:
        raise RegistryError(f"provider limit registry unreadable: {selected}: {error.strerror}") from None
    if len(raw) > MAX_REGISTRY_BYTES:
        raise RegistryError("provider limit registry exceeds its size bound")
    try:
        value = json.loads(raw.decode("utf-8"), parse_float=Decimal, parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError) as error:
        raise RegistryError(f"provider limit registry is not valid JSON: {error}") from None
    if not isinstance(value, dict) or set(value) - {"demand_profiles"} != _TOP_KEYS or value["schema"] != SCHEMA:
        raise RegistryError(f"provider limit registry must be one {SCHEMA} object")
    _text(value["production_reserve_note"], "production_reserve_note")
    reserve_raw = value["production_reserve_fraction"]
    if isinstance(reserve_raw, bool) or not isinstance(reserve_raw, (int, Decimal)):
        raise RegistryError("provider limit registry: production_reserve_fraction must be a number")
    reserve = Fraction(reserve_raw)
    if not 0 <= reserve < 1:
        raise RegistryError("provider limit registry: production_reserve_fraction must be in [0, 1)")
    measurement = value["measurement"]
    if not isinstance(measurement, dict) or set(measurement) != _MEASUREMENT_KEYS:
        raise RegistryError(f"provider limit registry: measurement must have exactly {sorted(_MEASUREMENT_KEYS)}")
    _text(measurement["id"], "measurement.id")
    _text(measurement["source"], "measurement.source")
    if not isinstance(measurement["date"], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", measurement["date"]):
        raise RegistryError("provider limit registry: measurement.date must be YYYY-MM-DD")
    if isinstance(measurement["concurrent_benches"], bool) or not isinstance(measurement["concurrent_benches"], int) \
            or measurement["concurrent_benches"] < 1:
        raise RegistryError("provider limit registry: measurement.concurrent_benches must be a positive integer")
    enforced, informational = value["enforced"], value["informational"]
    if not isinstance(enforced, list) or not enforced or not isinstance(informational, list):
        raise RegistryError("provider limit registry: enforced must be a nonempty list and informational a list")
    rows = [_provider(row, f"enforced[{i}]", _ENFORCED_KEYS, reserve) for i, row in enumerate(enforced)]
    notes = [_provider(row, f"informational[{i}]", _INFORMATIONAL_KEYS, reserve) for i, row in enumerate(informational)]
    for i, row in enumerate(rows):
        _text(row["exhaustion"], f"enforced[{i}].exhaustion")
    for i, row in enumerate(notes):
        _text(row["fallback"], f"informational[{i}].fallback")
    ids = [row["id"] for row in rows + notes]
    if len(set(ids)) != len(ids):
        raise RegistryError("provider limit registry: provider ids must be unique")
    raw_profiles = value.get("demand_profiles", [])
    if not isinstance(raw_profiles, list):
        raise RegistryError("provider limit registry: demand_profiles must be a list")
    providers = {row["id"]: row for row in rows + notes}
    profiles = [_profile(row, f"demand_profiles[{i}]", providers) for i, row in enumerate(raw_profiles)]
    for key in ("id", "task_group"):
        if len({row[key] for row in profiles}) != len(profiles):
            raise RegistryError(f"provider limit registry: demand profile {key}s must be unique")
    return dict(path=selected, canonical=selected.resolve() == CANONICAL_REGISTRY, reserve=reserve,
                measurement=measurement, enforced=rows, informational=notes, profiles=profiles,
                cap=min(row["cap"] for row in rows))


def _catalog_entries(names: set[str], catalogs: tuple[Path, ...]):
    """Every readable catalog row whose name is in `names`."""
    for path in catalogs:
        try:
            if not path.is_file() or path.stat().st_size > MAX_CATALOG_BYTES:
                continue
            entries = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        for entry in entries if isinstance(entries, list) else ():
            if isinstance(entry, dict) and entry.get("name") in names:
                yield entry


def task_groups(names: set[str], catalogs: tuple[Path, ...] = TASK_CATALOGS) -> dict[str, str | None]:
    """Catalog group of each named task; absent names are unknown (global demand)."""
    groups: dict[str, str | None] = {}
    for entry in _catalog_entries(names, catalogs):
        name = entry["name"]
        group = entry.get("group") if isinstance(entry.get("group"), str) else None
        groups[name] = group if groups.get(name, group) == group else None  # conflicting rows: unknown
    return groups


def selection_profile(registry: dict, tasks: list[str] | None,
                      catalogs: tuple[Path, ...] = TASK_CATALOGS) -> dict | None:
    """The demand profile every selected task belongs to, else None (global peaks)."""
    if not tasks or not registry.get("profiles"):
        return None
    groups = task_groups(set(tasks), catalogs)
    found = {groups.get(name) for name in tasks}
    if len(found) != 1 or None in found:
        return None
    group = found.pop()
    return next((profile for profile in registry["profiles"] if profile["task_group"] == group), None)


def for_selection(registry: dict, tasks: list[str] | None, catalogs: tuple[Path, ...] = TASK_CATALOGS) -> dict:
    """Rows with the selection's measured profile peaks; unprofiled rows keep the global peak."""
    profile = selection_profile(registry, tasks, catalogs)
    if profile is None:
        return dict(registry, demand_profile=None)

    def measured(row: dict) -> dict:
        peak = profile["peaks"].get(row["id"])
        if peak is None:
            return row
        return dict(row, per_bench_peak=profile["per_bench_peak"][row["id"]], demand_source=profile["demand_source"],
                    demand_measurement=profile["demand_measurement"],
                    cap=_cap(Fraction(row["limit"]), peak, registry["reserve"]))
    rows = [measured(row) for row in registry["enforced"]]
    return dict(registry, enforced=rows, informational=[measured(row) for row in registry["informational"]],
                cap=min(row["cap"] for row in rows), demand_profile=profile)


def dotenv_value(path: Path, key: str) -> str | None:
    """Last-wins dotenv read of one key; None when the file or key is absent."""
    try:
        if path.is_symlink():
            path = path.resolve(strict=True)
        if not path.is_file() or path.stat().st_size > MAX_ENV_BYTES:
            return None
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
    found = None
    for line in lines:
        match = re.fullmatch(r"\s*(?:export\s+)?" + re.escape(key) + r"=(.*)", line)
        if match is None:
            continue
        value = match.group(1).strip()
        if value[:1] in {'"', "'"} and value.find(value[0], 1) > 0:
            value = value[1:value.find(value[0], 1)]
        else:
            value = value.split(" #", 1)[0].strip()
        found = value
    return found


def resolve_browser_provider(explicit: str | None = None) -> str | None:
    """The fleet's browser provider, or None (every row binds) when unknown."""
    for candidate in (explicit, os.environ.get(BROWSER_PROVIDER_ENV),
                      dotenv_value(BACKEND_ENV_FILE, "BROWSER_PROVIDER")):
        if candidate:
            value = candidate.strip().lower()
            return value if value in BROWSER_PROVIDERS else None
    return None


def for_browser_provider(registry: dict, browser_provider: str | None) -> dict:
    """Rows that bind this fleet: unscoped rows, plus rows scoped to its provider."""
    rows = [row for row in registry["enforced"]
            if browser_provider is None or row.get("browser_provider") in (None, browser_provider)]
    return dict(registry, enforced=rows, cap=min(row["cap"] for row in rows), browser_provider=browser_provider)


def _reject_constant(name: str) -> None:
    raise ValueError(f"non-finite constant {name}")


def _limit_text(row: dict) -> str:
    text = f"{_number_text(row['limit'])} {row['limit_unit']}"
    return text + (f", {row['limit_qualifier']}" if row["limit_qualifier"] else "")


def _provider_line(row: dict, measurement_id: str) -> str:
    return (f"{row['name']}: {_limit_text(row)} ({row['credential_env']}) → max {row['cap']} concurrent benches "
            f"(peak {_number_text(row['per_bench_peak'])} {row['per_bench_peak_unit']}, "
            f"{row.get('demand_measurement') or 'measured ' + measurement_id})")


def _percent(reserve: Fraction) -> str:
    value = reserve * 100
    return f"{value.numerator}%" if value.denominator == 1 else f"{float(value):g}%"


def refusal_message(registry: dict, benches: int) -> str | None:
    """The exact operator-facing refusal, or None when the width fits."""
    if benches <= registry["cap"]:
        return None
    limiting = sorted((row for row in registry["enforced"] if row["cap"] < benches),
                      key=lambda row: (row["cap"], row["id"]))
    measured = registry["measurement"]["id"]
    cap = registry["cap"]
    return "\n".join([
        f"❌ Benchmark concurrency is limited by provider rate limits: requested {benches} concurrent benches, maximum {cap}.",
        f"Limiting providers ({_percent(registry['reserve'])} of each limit reserved for production):",
        *(f"  - {_provider_line(row, measured)}" for row in limiting),
        "STOP: do not retry, split, or work around this limit. Halt and ask the user to either",
        f"  1. increase these provider rate limits (then record the new limits in {CANONICAL_LABEL}), or",
        f"  2. rerun with a lower concurrency ({cap} or fewer concurrent benches).",
    ])


def informational_notes(registry: dict, benches: int) -> list[str]:
    measured = registry["measurement"]["id"]
    return [f"ℹ️  provider note (not enforced): {_provider_line(row, measured)}; {row['fallback']}"
            for row in sorted(registry["informational"], key=lambda row: (row["cap"], row["id"]))
            if row["cap"] < benches]


def check(benches: int, *, stream=None, registry: dict | None = None,
          browser_provider: str | None = None, tasks: list[str] | None = None) -> int:
    """Return 0 when `benches` simultaneous benches fit, else EXIT_REFUSED after printing why.

    `tasks` (the launched selection) may select a measured demand profile; omitted keeps global peaks."""
    stream = stream or sys.stderr
    if isinstance(benches, bool) or not isinstance(benches, int) or benches < 0:
        raise ValueError("simultaneous bench count must be a nonnegative integer")
    registry = for_browser_provider(for_selection(registry or load_registry(), tasks),
                                    resolve_browser_provider(browser_provider))
    if not registry["canonical"]:
        print(f"⚠️  provider limits from {REGISTRY_ENV}={registry['path']} (validated; not the reviewed "
              f"{CANONICAL_LABEL})", file=stream, flush=True)
    profile = registry["demand_profile"]
    if profile is not None:
        print(f"🧮 provider demand profile {profile['id']}: every selected task is in catalog group "
              f"{profile['task_group']} ({profile['demand_measurement']})", file=stream, flush=True)
    message = refusal_message(registry, benches)
    if message is not None:
        print(message, file=stream, flush=True)
        return EXIT_REFUSED
    for note in informational_notes(registry, benches):
        print(note, file=stream, flush=True)
    return 0


def delegating_ceiling() -> int:
    """The app-wide live REAL/SIM primary ceiling fleet admission enforces."""
    raw = os.environ.get(DELEGATING_CEILING_ENV) or str(DEFAULT_DELEGATING_CEILING)
    if not re.fullmatch(r"[0-9]{1,6}", raw):
        raise RegistryError(f"{DELEGATING_CEILING_ENV} must be a non-negative integer")
    return int(raw)


def requested_delegating_benches(benches: int, tasks: list[str] | None,
                                 catalogs: tuple[Path, ...] = TASK_CATALOGS) -> int:
    """Simultaneous REAL/SIM primaries a launch of `benches` copies of `tasks` can request.

    Mirrors admit_lane_capacity's lanes: CLOUDBENCH_LANE=demo|infra requests none,
    and catalog `demo_cache: on` tasks run in the separate DEMO lane. Any other or
    unknown task makes the whole width count (which copies overlap is not known
    before launch), as mixed selections keep the global provider peaks."""
    lane = os.environ.get(LANE_ENV) or ""
    if lane in ("demo", "infra"):
        return 0
    if not lane and tasks:
        demo = {entry["name"] for entry in _catalog_entries(set(tasks), catalogs)
                if entry.get("demo_cache", entry.get("fast_cache")) == "on"}
        if set(tasks) <= demo:
            return 0
    return benches


def delegating_refusal_message(requested: int, ceiling: int) -> str | None:
    if requested <= ceiling:
        return None
    return "\n".join([
        f"❌ Delegating-guest ceiling: requested {requested} simultaneous REAL/SIM copies, maximum {ceiling} "
        f"({DELEGATING_CEILING_ENV}, default {DEFAULT_DELEGATING_CEILING}).",
        "Fleet admission counts every live REAL/SIM primary on the app (all devboxes) against this ceiling, so this "
        "launch can never be admitted: its copies would wait out admission and be recorded as INFRA.",
        f"Lower the simultaneous width to {ceiling} or fewer (fewer tasks or -k copies, or a rolling campaign with "
        f"--concurrency {ceiling} or less).",
        f"Raising {DELEGATING_CEILING_ENV} needs a measured backend/provider load at the wider width; "
        f"{DEFAULT_DELEGATING_CEILING} is the widest proven-safe width.",
    ])


def delegating_check(benches: int, *, stream=None, tasks: list[str] | None = None,
                     catalogs: tuple[Path, ...] = TASK_CATALOGS) -> int:
    """Return 0 when the launch's own REAL/SIM width fits the app ceiling, else EXIT_REFUSED after printing why."""
    stream = stream or sys.stderr
    if isinstance(benches, bool) or not isinstance(benches, int) or benches < 0:
        raise ValueError("simultaneous bench count must be a nonnegative integer")
    message = delegating_refusal_message(requested_delegating_benches(benches, tasks, catalogs), delegating_ceiling())
    if message is None:
        return 0
    print(message, file=stream, flush=True)
    return EXIT_REFUSED


def _table(registry: dict) -> dict:
    def row(item: dict) -> dict:
        return dict(id=item["id"], name=item["name"], limit=_limit_text(item), credential_env=item["credential_env"],
                    per_bench_peak=f"{_number_text(item['per_bench_peak'])} {item['per_bench_peak_unit']}",
                    max_concurrent_benches=item["cap"])
    profile = registry.get("demand_profile")
    return dict(max_concurrent_benches=registry["cap"], browser_provider=registry.get("browser_provider"),
                demand_profile=profile["id"] if profile else None,
                production_reserve=_percent(registry["reserve"]),
                measurement=registry["measurement"]["id"], registry=str(registry["path"]),
                enforced=[row(item) for item in registry["enforced"]],
                informational=[dict(row(item), fallback=item["fallback"]) for item in registry["informational"]])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    checking = commands.add_parser("check", help="refuse a simultaneous width above the provider cap")
    checking.add_argument("--benches", required=True, type=int, help="global simultaneous bench count")
    capping = commands.add_parser("cap", help="print the provider concurrency cap")
    capping.add_argument("--json", action="store_true", help="print every provider's cap as JSON")
    delegating = commands.add_parser("delegating", help="refuse a REAL/SIM width above the app delegating-guest ceiling")
    delegating.add_argument("--benches", required=True, type=int, help="global simultaneous bench count")
    delegating.add_argument("--task", action="append", dest="tasks", metavar="NAME",
                            help="a launched task (repeat); DEMO-lane tasks request no delegating primaries")
    for command in (checking, capping):
        command.add_argument("--browser-provider", choices=BROWSER_PROVIDERS,
                             help="fleet browser provider (default: CLOUDBENCH_BROWSER_PROVIDER, then back-end/.env)")
        command.add_argument("--task", action="append", dest="tasks", metavar="NAME",
                             help="a launched task (repeat); a measured demand profile applies only when every "
                                  "task is in its catalog group")
    args = parser.parse_args(argv)
    try:
        if args.command == "delegating":
            if args.benches < 0:
                parser.error("--benches must be a nonnegative integer")
            try:
                return delegating_check(args.benches, tasks=args.tasks)
            except RegistryError as error:
                print(f"❌ {error}; no cloud launch admitted", file=sys.stderr)
                return EXIT_INVALID
        if args.command == "check":
            if args.benches < 0:
                parser.error("--benches must be a nonnegative integer")
            return check(args.benches, browser_provider=args.browser_provider, tasks=args.tasks)
        registry = for_browser_provider(for_selection(load_registry(), args.tasks),
                                        resolve_browser_provider(args.browser_provider))
        print(json.dumps(_table(registry), indent=2) if args.json else registry["cap"])
        return 0
    except RegistryError as error:
        print(f"❌ {error}; benchmark concurrency cannot be admitted without a valid provider limit registry",
              file=sys.stderr)
        return EXIT_INVALID


if __name__ == "__main__":
    raise SystemExit(main())
