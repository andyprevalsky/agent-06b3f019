"""Fly.io cost for /biz-review from Fly managed Prometheus + the Machines API (read-only).

Fly exposes no invoice API to this token. Started-compute seconds come from
Prometheus, which keeps destroyed Machines; sizes come from the same metrics and
prices from docs.fly.io/about/pricing (checked 2026-10-19). Volumes are billed
for listed volumes plus /data mounts seen on running instances.
"""
from __future__ import annotations

import json
import math
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

ORG = "personal"
VCPU_USD_PER_SECOND = {"shared": 8.465e-7, "performance": 1.2732e-5}
INCLUDED_RAM_GB_PER_VCPU = {"shared": 0.25, "performance": 2.0}
RAM_USD_PER_GB_SECOND = 2.316e-6
STORAGE_USD_PER_GB_SECOND = 0.15 / 2_592_000  # volumes and stopped rootfs, $0.15/GB per 30 days
STOPPED_ROOTFS_GB = 8
CHUNK_SECONDS = 86_400  # wider selectors are served at 5m resolution and break gap detection
GAP_SECONDS = 180

QUERIES = {
    "up": "sum by (app,instance,region)(duration_over_time(fly_instance_up[{r}], {g}s))",
    "cpus": 'count by (app,instance)(max_over_time(fly_instance_cpu{{mode="idle"}}[{r}]))',
    "baseline": "max by (app,instance)(max_over_time(fly_instance_cpu_baseline[{r}]))",
    "memory": "max by (app,instance)(max_over_time(fly_instance_memory_mem_total[{r}]))",
    "blocks": 'max by (app,instance)(max_over_time(fly_instance_filesystem_blocks{{mount="/data"}}[{r}]))',
    "block_size": 'max by (app,instance)(max_over_time(fly_instance_filesystem_block_size{{mount="/data"}}[{r}]))',
    "data_seconds": 'max by (app,instance)(duration_over_time(fly_instance_filesystem_blocks{{mount="/data"}}[{r}], {g}s))',
}


def _get(token: str, url: str):
    request = urllib.request.Request(url, headers={"Authorization": token, "User-Agent": "curl/8.5.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def _prom(token: str, query: str, at: int) -> dict:
    qs = urllib.parse.urlencode({"query": query, "time": at})
    body = _get(token, f"https://api.fly.io/prometheus/{ORG}/api/v1/query?{qs}")
    if body.get("status") != "success" or body.get("isPartial"):
        raise RuntimeError("Fly Prometheus returned a partial result")
    return {(m["metric"].get("app"), m["metric"].get("instance")): (m["metric"], float(m["value"][1]))
            for m in body["data"]["result"]}


def provisioned_gb(mem_total_bytes: float) -> float:
    """Guests see ~98.5% of provisioned RAM; Fly sizes in 256 MiB steps below 1 GiB, else 1 GiB."""
    mib = mem_total_bytes / 2**20 / 0.985
    step = 256 if mib < 1024 else 1024
    return math.ceil(mib / step) * step / 1024


def instance_usd_per_second(vcpus: float, baseline: float, gb: float) -> float:
    kind = "shared" if baseline / vcpus < 0.5 else "performance"
    extra_gb = max(0.0, gb - vcpus * INCLUDED_RAM_GB_PER_VCPU[kind])
    return vcpus * VCPU_USD_PER_SECOND[kind] + extra_gb * RAM_USD_PER_GB_SECOND


def _chunk(token: str, at: int) -> dict:
    r = f"{CHUNK_SECONDS}s"
    return {name: _prom(token, q.format(r=r, g=GAP_SECONDS), at) for name, q in QUERIES.items()}


def _ts(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def _listed_storage(token: str, start: float, end: float) -> tuple[float, float, set[str]]:
    apps = _get(token, f"https://api.machines.dev/v1/apps?org_slug={ORG}")["apps"]
    volume_gb_s = stopped_gb_s = 0.0
    attached: set[str] = set()
    for app in apps:
        for volume in _get(token, f"https://api.machines.dev/v1/apps/{app['name']}/volumes"):
            if volume["state"] != "created":
                continue
            if volume.get("attached_machine_id"):
                attached.add(volume["attached_machine_id"])
            volume_gb_s += volume["size_gb"] * max(0.0, end - max(start, _ts(volume["created_at"])))
        for machine in _get(token, f"https://api.machines.dev/v1/apps/{app['name']}/machines"):
            if machine["state"] in ("stopped", "suspended"):
                stopped_gb_s += STOPPED_ROOTFS_GB * max(0.0, end - max(start, _ts(machine["updated_at"])))
    return volume_gb_s, stopped_gb_s, attached


def fly_cost(env: dict, start: datetime, end: datetime) -> list[dict]:
    """Cost rows: compute per app, then storage."""
    token = env.get("FLY_API_TOKEN", "")
    if not token:
        return [{"name": "Fly.io", "status": "unavailable", "detail": "FLY_API_TOKEN missing"}]
    if not token.startswith("FlyV1 "):
        token = f"FlyV1 {token}"
    begin, finish = start.timestamp(), end.timestamp()
    stamps = list(range(int(begin) + CHUNK_SECONDS, int(finish) + 1, CHUNK_SECONDS))
    with ThreadPoolExecutor(max_workers=7) as pool:
        storage = pool.submit(_listed_storage, token, begin, finish)
        chunks = list(pool.map(lambda at: _chunk(token, at), stamps))
    volume_gb_s, stopped_gb_s, attached = storage.result()
    compute: dict[str, float] = defaultdict(float)
    instances: dict[str, set] = defaultdict(set)
    mounted_gb_s = 0.0
    for chunk in chunks:
        for key, (_labels, seconds) in chunk["up"].items():
            app, instance = key
            if key not in chunk["cpus"] or key not in chunk["memory"] or key not in chunk["baseline"]:
                continue
            rate = instance_usd_per_second(chunk["cpus"][key][1], chunk["baseline"][key][1],
                                           provisioned_gb(chunk["memory"][key][1]))
            compute[app] += rate * seconds
            instances[app].add(instance)
            if key in chunk["blocks"] and key in chunk["data_seconds"] and instance not in attached:
                block_size = chunk["block_size"].get(key, (None, 4096))[1]
                mounted_gb_s += math.ceil(chunk["blocks"][key][1] * block_size / 1e9) * chunk["data_seconds"][key][1]
    rows = [{"name": f"Fly.io · {app}", "status": "ready", "basis": "metered × list price", "usd": usd,
             "detail": f"{len(instances[app]):,} machines"}
            for app, usd in sorted(compute.items(), key=lambda kv: -kv[1]) if usd >= 0.01]
    rows.append({"name": "Fly.io · volumes & rootfs", "status": "ready", "basis": "metered × list price",
                 "usd": (volume_gb_s + mounted_gb_s + stopped_gb_s) * STORAGE_USD_PER_GB_SECOND,
                 "detail": "listed volumes + mounts on running machines + stopped rootfs"})
    return rows


def self_test() -> None:
    assert provisioned_gb(2 * 2**30 * 0.985) == 2.0
    assert provisioned_gb(250 * 2**20) == 0.25
    perf = instance_usd_per_second(1, 1.0, 2.0)
    assert abs(perf - 1.2732e-5) < 1e-12, "performance-1x 2GB includes its RAM"
    shared = instance_usd_per_second(1, 0.0625, 1.0)
    assert abs(shared - (8.465e-7 + 0.75 * 2.316e-6)) < 1e-12
