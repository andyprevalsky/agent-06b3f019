#!/usr/bin/env python
"""Build / refresh the derived planner-RAG index from trace-archive bundles.

Reads bundles (read-only) from the configured archive backend, extracts
(goal, successful plan) entries, and writes the encrypted derived index under
``planner-rag/`` — locally by default, and to R2 with ``--publish``.

    cd agents && source venv/bin/activate
    python scripts/build_planner_rag_index.py                 # incremental, local write only
    python scripts/build_planner_rag_index.py --publish       # also publish to R2
    python scripts/build_planner_rag_index.py --limit 500     # probe a slice
    python scripts/build_planner_rag_index.py --bundle-id <root_agent_id> [--bundle-id ...]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

AGENTS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENTS_ROOT))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(AGENTS_ROOT / ".env")

from helpers.trace_archive import list_archive_bundle_ids  # noqa: E402
from providers.planner_rag import store  # noqa: E402
from providers.planner_rag.corpus import PlanEntry, scan_bundles  # noqa: E402


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_existing(backend: str) -> tuple[list[PlanEntry], dict[str, str]]:
    index_doc = store.read_encrypted_json(store.INDEX_KEY, backend=backend)
    scan_doc = store.read_encrypted_json(store.SCAN_STATE_KEY, backend=backend)
    entries = [PlanEntry.from_dict(raw) for raw in (index_doc or {}).get("entries") or []]
    scan_state = dict((scan_doc or {}).get("bundles") or {})
    return entries, scan_state


def _write(entries: list[PlanEntry], scan_state: dict[str, str], *, backend: str, source_backend: str) -> str:
    entries_sorted = sorted(entries, key=lambda e: (e.created_at, e.root_agent_id))
    document = {
        "schema_version": 1,
        "generated_at": _now_iso(),
        "source_backend": source_backend,
        "entry_count": len(entries_sorted),
        "entries": [e.to_dict() for e in entries_sorted],
    }
    ref = store.write_encrypted_json(store.INDEX_KEY, document, backend=backend)
    store.write_encrypted_json(
        store.SCAN_STATE_KEY,
        {"schema_version": 1, "generated_at": _now_iso(), "bundles": scan_state},
        backend=backend,
    )
    return ref


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=0, help="Scan at most N pending bundles (0 = all)")
    parser.add_argument("--concurrency", type=int, default=int(os.environ.get("PLANNER_RAG_BUILD_CONCURRENCY", "48")))
    parser.add_argument("--publish", action="store_true", help="Also write the index to R2 (planner-rag/ prefix)")
    parser.add_argument(
        "--publish-only", action="store_true", help="Skip scanning; publish the local index + scan state to R2"
    )
    parser.add_argument("--rescan-all", action="store_true", help="Ignore scan state and re-probe every bundle")
    parser.add_argument("--bundle-id", action="append", default=[], help="Only scan these root agent ids")
    parser.add_argument("--json", action="store_true", help="Print a JSON summary")
    args = parser.parse_args()

    source_backend = store.storage_backend()
    read_backend = "r2" if source_backend == "r2" else "local"
    started = time.perf_counter()

    if args.publish_only:
        if source_backend != "r2":
            print("[planner-rag] --publish-only requires the r2 backend", file=sys.stderr)
            return 2
        entries, scan_state = _load_existing("local")
        ref = _write(entries, scan_state, backend="r2", source_backend=source_backend)
        print(f"[planner-rag] published {len(entries)} entries ({len(scan_state)} scanned bundles) -> {ref}")
        return 0

    existing_entries, scan_state = _load_existing(read_backend)
    if args.rescan_all:
        scan_state = {}
    print(f"[planner-rag] backend={source_backend} existing_entries={len(existing_entries)} scanned={len(scan_state)}")

    list_started = time.perf_counter()
    bundle_ids = args.bundle_id or list_archive_bundle_ids()
    list_elapsed = time.perf_counter() - list_started
    print(f"[planner-rag] listed {len(bundle_ids)} bundles in {list_elapsed:.1f}s")

    if args.bundle_id:
        for bundle_id in args.bundle_id:
            scan_state.pop(bundle_id, None)
    if args.limit:
        pending = [b for b in bundle_ids if b not in scan_state]
        bundle_ids = pending[: args.limit]

    def _progress(done: int, total: int, counts: dict[str, int]) -> None:
        elapsed = time.perf_counter() - scan_started
        rate = done / elapsed if elapsed > 0 else 0.0
        eta = (total - done) / rate if rate > 0 else 0.0
        print(
            f"[planner-rag] {done}/{total} ({rate:.1f}/s, eta {eta:.0f}s) ok={counts.get('ok', 0)} {counts}", flush=True
        )

    scan_started = time.perf_counter()
    new_entries, scan_state, counts = scan_bundles(
        bundle_ids, scan_state=scan_state, concurrency=args.concurrency, progress=_progress
    )
    merged = {e.root_agent_id: e for e in existing_entries}
    for entry in new_entries:
        merged[entry.root_agent_id] = entry
    entries = list(merged.values())

    local_ref = _write(entries, scan_state, backend="local", source_backend=source_backend)
    published_ref = None
    if args.publish:
        if source_backend != "r2":
            print("[planner-rag] --publish requested but backend is local; nothing published", file=sys.stderr)
        else:
            published_ref = _write(entries, scan_state, backend="r2", source_backend=source_backend)

    summary = {
        "backend": source_backend,
        "bundles_listed": len(bundle_ids),
        "scanned_now": sum(counts.values()),
        "reasons": counts,
        "new_entries": len(new_entries),
        "total_entries": len(entries),
        "local_ref": local_ref,
        "published_ref": published_ref,
        "elapsed_s": round(time.perf_counter() - started, 1),
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(f"[planner-rag] done: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
