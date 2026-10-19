"""Azure Foundry and Cerebras LLM spend for /biz-review (read-only).

Azure Foundry: real billed cost from the Cost Management Query API
(ActualCost, grouped by ResourceId, filtered to the Foundry resources named by
AZURE_FOUNDRY_ENDPOINT[_n]). The api-key data plane exposes no usage or cost
route, so this needs an AAD management token from either a service principal
(AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET) or a one-time
device-code login cached privately:

    python3 scripts/biz_review_llm.py azure-login

Cost Management data is daily (UTC dates), so a window is widened to whole
dates; the detail string says so.

Cerebras: api.cerebras.ai has no usage/billing route for an inference key.
The cloud.cerebras.ai console's GraphQL (ListOrganizationModelsUsages) reports
per-model token usage; it needs the console session, which is read through the
shared boxes.dev browser (same-origin fetch via CDP, no cookies are read).
Cost = tokens x Cerebras list price (agents/providers/rose/pricing.py:
qwen-3.8-27b $0.99 in / $1.49 out per million, official list 2026-09-25).

    python3 scripts/biz_review_llm.py [--start ISO --end ISO]
    python3 scripts/biz_review_llm.py self-test
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

AZ_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"  # public Azure CLI client
ARM = "https://management.azure.com"
ARM_SCOPE = "https://management.azure.com/.default offline_access"
TOKEN_CACHE = Path.home() / ".config" / "rose-biz-review" / "azure-token.json"
CEREBRAS_USD_PER_TOKEN = {"qwen-3.8-27b": (0.99e-6, 1.49e-6), "gpt-oss-120b": (0.35e-6, 0.75e-6)}
BROWSER_BASE = "http://127.0.0.1:8788/.sprite/api/browser"
CEREBRAS_ORIGIN = "https://cloud.cerebras.ai"


def _result(status: str, basis: str, usd: float, detail: str) -> dict:
    return {"status": status, "basis": basis, "usd": round(float(usd), 2), "detail": detail}


def _http(method: str, url: str, headers: dict | None = None, body: bytes | None = None, timeout: int = 60):
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read() or b"{}")
        except ValueError:
            return error.code, {}


# ---------------------------------------------------------------- Azure

def foundry_resource_names(env: dict) -> list[str]:
    names = []
    for suffix in [""] + [f"_{n}" for n in range(2, 10)]:
        endpoint = (env.get(f"AZURE_FOUNDRY_ENDPOINT{suffix}") or "").strip()
        if endpoint:
            host = urllib.parse.urlparse(endpoint).hostname or ""
            name = host.split(".")[0].lower()
            if name and name not in names:
                names.append(name)
    return names


def _form_post(url: str, fields: dict):
    return _http("POST", url, {"Content-Type": "application/x-www-form-urlencoded"},
                 urllib.parse.urlencode(fields).encode())


def _azure_token(env: dict) -> tuple[str | None, str]:
    tenant, client, secret = (env.get(k) for k in ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"))
    if tenant and client and secret:
        status, body = _form_post(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", {
            "grant_type": "client_credentials", "client_id": client, "client_secret": secret,
            "scope": "https://management.azure.com/.default"})
        return (body.get("access_token"), "service principal") if status == 200 else (None, f"SP token HTTP {status}")
    if TOKEN_CACHE.exists():
        cached = json.loads(TOKEN_CACHE.read_text())
        status, body = _form_post(f"https://login.microsoftonline.com/{cached.get('tenant', 'organizations')}/oauth2/v2.0/token", {
            "grant_type": "refresh_token", "client_id": AZ_CLI_CLIENT_ID,
            "refresh_token": cached["refresh_token"], "scope": ARM_SCOPE})
        if status == 200:
            cached["refresh_token"] = body.get("refresh_token", cached["refresh_token"])
            _write_private(TOKEN_CACHE, cached)
            return body["access_token"], "device-code login"
        return None, f"cached refresh token rejected (HTTP {status}); rerun azure-login"
    return None, "no AAD credential: run `python3 scripts/biz_review_llm.py azure-login` once"


def _write_private(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(data, handle)
    os.replace(tmp, path)


def azure_login(tenant: str = "organizations") -> None:
    status, code = _form_post(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode",
                              {"client_id": AZ_CLI_CLIENT_ID, "scope": ARM_SCOPE})
    if status != 200:
        raise SystemExit(f"device code request failed: HTTP {status} {code.get('error')}")
    print(code["message"], flush=True)
    deadline = time.time() + int(code.get("expires_in", 900))
    while time.time() < deadline:
        time.sleep(int(code.get("interval", 5)))
        status, body = _form_post(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", {
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "client_id": AZ_CLI_CLIENT_ID, "device_code": code["device_code"]})
        if status == 200:
            _write_private(TOKEN_CACHE, {"tenant": tenant, "refresh_token": body["refresh_token"]})
            print(f"saved refresh token to {TOKEN_CACHE} (0600)")
            return
        if body.get("error") not in ("authorization_pending", "slow_down"):
            raise SystemExit(f"login failed: {body.get('error')}")
    raise SystemExit("device code expired")


def _cost_window(start: datetime, end: datetime) -> tuple[str, str]:
    first = start.astimezone(timezone.utc).date()
    last = (end.astimezone(timezone.utc) - timedelta(microseconds=1)).date()
    return f"{first}T00:00:00Z", f"{last}T23:59:59Z"


def sum_cost_rows(payload: dict, names: list[str]) -> tuple[float, dict, str]:
    """Sum Cost Management rows whose ResourceId ends in one of the Foundry account names."""
    columns = [c["name"] for c in payload.get("properties", {}).get("columns", [])]
    cost_i = next(i for i, c in enumerate(columns) if c in ("Cost", "PreTaxCost", "CostUSD"))
    rid_i = columns.index("ResourceId")
    cur_i = columns.index("Currency") if "Currency" in columns else None
    per, currency = {}, "USD"
    for row in payload.get("properties", {}).get("rows", []):
        rid = str(row[rid_i]).lower()
        account = rid.rsplit("/accounts/", 1)[-1].split("/")[0] if "/accounts/" in rid else rid.rsplit("/", 1)[-1]
        if account in names:
            per[account] = per.get(account, 0.0) + float(row[cost_i])
            currency = row[cur_i] if cur_i is not None else currency
    return sum(per.values()), per, currency


def azure_cost(env: dict, start: datetime, end: datetime) -> dict:
    names = foundry_resource_names(env)
    if not names:
        return _result("unavailable", "no Foundry endpoints configured", 0, "")
    token, how = _azure_token(env)
    if not token:
        return _result("unavailable", "Azure Cost Management (needs AAD)", 0, how)
    auth = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    status, subs = _http("GET", f"{ARM}/subscriptions?api-version=2022-12-01", auth)
    if status != 200:
        return _result("unavailable", "Azure Cost Management", 0, f"list subscriptions HTTP {status}")
    frm, to = _cost_window(start, end)
    query = {"type": "ActualCost", "timeframe": "Custom", "timePeriod": {"from": frm, "to": to},
             "dataset": {"granularity": "None",
                         "aggregation": {"totalCost": {"name": "Cost", "function": "Sum"}},
                         "grouping": [{"type": "Dimension", "name": "ResourceId"}]}}
    total, per, currency, errors = 0.0, {}, "USD", []
    for sub in subs.get("value", []):
        url = f"{ARM}/subscriptions/{sub['subscriptionId']}/providers/Microsoft.CostManagement/query?api-version=2023-11-01"
        while url:
            status, payload = _http("POST", url, auth, json.dumps(query).encode(), timeout=120)
            if status == 429:
                time.sleep(20)
                continue
            if status != 200:
                errors.append(f"{sub.get('displayName')}: HTTP {status}")
                break
            part, part_per, currency = sum_cost_rows(payload, names)
            total += part
            for k, v in part_per.items():
                per[k] = per.get(k, 0.0) + v
            url = payload.get("properties", {}).get("nextLink")
    missing = [n for n in names if n not in per]
    detail = ", ".join(f"{k} ${v:.2f}" for k, v in sorted(per.items())) or "no matching cost rows"
    detail += f"; dates {frm[:10]}..{to[:10]} UTC (daily data); {currency}; auth {how}"
    if missing:
        detail += f"; no rows for {', '.join(missing)}"
    if errors:
        detail += "; errors: " + "; ".join(errors)
    return _result("ready" if not errors else "unavailable", "Azure Cost Management ActualCost", total, detail)


# ---------------------------------------------------------------- Cerebras

_CDP_EVAL_JS = r"""
const [wsUrl, expr] = process.argv.slice(-2);
const ws = new WebSocket(wsUrl);
const timer = setTimeout(() => { console.log(JSON.stringify({error: "cdp timeout"})); process.exit(0); }, 90000);
ws.onopen = () => ws.send(JSON.stringify({id: 1, method: "Runtime.evaluate",
  params: {expression: expr, awaitPromise: true, returnByValue: true}}));
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (m.id !== 1) return;
  clearTimeout(timer); console.log(JSON.stringify(m.result?.result?.value ?? {error: m.result?.exceptionDetails?.text || m.error})); ws.close(); };
ws.onerror = () => { console.log(JSON.stringify({error: "cdp websocket error"})); process.exit(0); };
"""

_GQL_ORGS = "query ListMyOrganizations { ListMyOrganizations { id name organizationType state } }"
_GQL_USAGE = """query ListOrganizationModelsUsages($organizationId: ID!, $modelIds: [ID!]!, $projectIds: [ID!]!,
  $startUnixTimestamp: Int!, $endUnixTimestamp: Int!, $interval: OrganizationUsageInterval!) {
  ListOrganizationModelsUsages(organizationId: $organizationId, modelIds: $modelIds, projectIds: $projectIds,
    startUnixTimestamp: $startUnixTimestamp, endUnixTimestamp: $endUnixTimestamp, interval: $interval) {
    modelId startUnixTimestamp endUnixTimestamp tokensUsed requestsUsed inputTokensUsed outputTokensUsed
    inputTokensCacheReadUsed } }"""


def _browser(env: dict):
    token = env.get("BOXES_BROWSER_TOKEN")
    if not token:
        config = Path.home() / ".devbox" / "daemon" / "config.json"
        token = json.loads(config.read_text()).get("heartbeatToken") if config.exists() else None
    return {"Authorization": f"Bearer {token}"} if token else None


def _cerebras_gql(env: dict, query: str, variables: dict) -> dict:
    headers = _browser(env)
    if not headers:
        return {"error": "no shared browser"}
    _, cdp = _http("GET", f"{BROWSER_BASE}/cdp", headers)
    endpoint = cdp.get("endpoint")
    if not endpoint:
        return {"error": "no CDP endpoint"}
    targets = json.loads(urllib.request.urlopen(f"{endpoint}/json/list", timeout=20).read())
    target = next((t for t in targets if t.get("type") == "page" and t.get("url", "").startswith(CEREBRAS_ORIGIN)), None)
    opened = None
    if not target:
        _, made = _http("POST", f"{BROWSER_BASE}/tabs", {**headers, "Content-Type": "application/json"},
                        json.dumps({"url": CEREBRAS_ORIGIN + "/"}).encode())
        opened = (made.get("tab") or made).get("targetId")
        time.sleep(8)
        targets = json.loads(urllib.request.urlopen(f"{endpoint}/json/list", timeout=20).read())
        target = next((t for t in targets if t.get("id") == opened), None)
    try:
        if not target:
            return {"error": "could not open cloud.cerebras.ai tab"}
        expr = ("fetch('/api/graphql',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},"
                f"body:JSON.stringify({json.dumps({'query': query, 'variables': variables})})}})"
                ".then(async r=>({status:r.status, body: await r.text()}))")
        out = subprocess.run(["node", "-e", _CDP_EVAL_JS, target["webSocketDebuggerUrl"], expr],
                             capture_output=True, text=True, timeout=120).stdout.strip()
        value = json.loads(out or "{}")
        if "error" in value:
            return value
        try:
            body = json.loads(value.get("body") or "{}")
        except ValueError:
            return {"error": f"console HTTP {value.get('status')} non-JSON (not signed in?)"}
        if value.get("status") != 200 or body.get("errors"):
            msg = (body.get("errors") or [{}])[0].get("message", "")
            return {"error": f"console HTTP {value.get('status')} {msg[:160]}"}
        return body.get("data") or {}
    finally:
        if opened:
            try:
                urllib.request.urlopen(f"{endpoint}/json/close/{opened}", timeout=10).read()
            except OSError:
                pass


def price_cerebras(rows: list[dict]) -> tuple[float, dict]:
    per = {}
    for row in rows:
        model = row.get("modelId")
        rate_in, rate_out = CEREBRAS_USD_PER_TOKEN.get(model, CEREBRAS_USD_PER_TOKEN["qwen-3.8-27b"])
        agg = per.setdefault(model, {"input": 0, "output": 0, "cache_read": 0, "requests": 0, "usd": 0.0})
        tin, tout = int(row.get("inputTokensUsed") or 0), int(row.get("outputTokensUsed") or 0)
        agg["input"] += tin
        agg["output"] += tout
        agg["cache_read"] += int(row.get("inputTokensCacheReadUsed") or 0)
        agg["requests"] += int(row.get("requestsUsed") or 0)
        agg["usd"] += tin * rate_in + tout * rate_out
    return sum(a["usd"] for a in per.values()), per


def cerebras_cost(env: dict, start: datetime, end: datetime) -> dict:
    basis = "Cerebras console token usage x list price"
    orgs = _cerebras_gql(env, _GQL_ORGS, {})
    if "error" in orgs:
        return _result("unavailable", basis, 0,
                       f"{orgs['error']}; sign in at {CEREBRAS_ORIGIN} in the boxes.dev Browser pane")
    org_list = orgs.get("ListMyOrganizations") or []
    if not org_list:
        return _result("unavailable", basis, 0, "signed in but no organizations visible")
    total, detail = 0.0, []
    for org in org_list:
        data = _cerebras_gql(env, _GQL_USAGE, {
            "organizationId": org["id"], "modelIds": list(CEREBRAS_USD_PER_TOKEN), "projectIds": [],
            "startUnixTimestamp": int(start.timestamp()), "endUnixTimestamp": int(end.timestamp()),
            "interval": "DAY"})
        if "error" in data:
            return _result("unavailable", basis, 0, f"usage query for {org.get('name')}: {data['error']}")
        usd, per = price_cerebras(data.get("ListOrganizationModelsUsages") or [])
        total += usd
        for model, a in per.items():
            detail.append(f"{org.get('name')}/{model}: {a['requests']} req, {a['input']:,} in "
                          f"({a['cache_read']:,} cached), {a['output']:,} out = ${a['usd']:.2f}")
    note = "cached input priced at the full input rate; daily buckets"
    return _result("ready", basis, total, "; ".join(detail + [note]) if detail else f"no usage; {note}")


# ---------------------------------------------------------------- CLI / tests

def self_test() -> None:
    env = {"AZURE_FOUNDRY_ENDPOINT": "https://a-4989-resource.openai.azure.com",
           "AZURE_FOUNDRY_ENDPOINT_2": "https://rose-foundry-southcentralus.openai.azure.com",
           "AZURE_FOUNDRY_ENDPOINT_3": "https://rose-foundry-westus.openai.azure.com/",
           "AZURE_FOUNDRY_ENDPOINT_4": "https://rose-foundry-southcentralus.openai.azure.com/"}
    names = foundry_resource_names(env)
    assert names == ["a-4989-resource", "rose-foundry-southcentralus", "rose-foundry-westus"], names
    payload = {"properties": {"columns": [{"name": "Cost"}, {"name": "ResourceId"}, {"name": "Currency"}], "rows": [
        [12.5, "/subscriptions/s/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/rose-foundry-westus", "USD"],
        [2.5, "/subscriptions/s/resourcegroups/rg/providers/microsoft.cognitiveservices/accounts/A-4989-RESOURCE", "USD"],
        [99.0, "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/other", "USD"]]}}
    total, per, currency = sum_cost_rows(payload, names)
    assert total == 15.0 and per == {"rose-foundry-westus": 12.5, "a-4989-resource": 2.5} and currency == "USD"
    s = datetime(2026, 10, 12, 19, tzinfo=timezone.utc)
    e = datetime(2026, 10, 19, 19, tzinfo=timezone.utc)
    assert _cost_window(s, e) == ("2026-10-12T00:00:00Z", "2026-10-19T23:59:59Z")
    assert _cost_window(s, datetime(2026, 10, 19, tzinfo=timezone.utc))[1] == "2026-10-18T23:59:59Z"
    usd, per = price_cerebras([{"modelId": "qwen-3.8-27b", "inputTokensUsed": 1_000_000, "outputTokensUsed": 1_000_000,
                                "requestsUsed": 3}, {"modelId": "qwen-3.8-27b", "inputTokensUsed": 0,
                                                     "outputTokensUsed": 2_000_000}])
    assert abs(usd - (0.99 + 1.49 * 3)) < 1e-9 and per["qwen-3.8-27b"]["requests"] == 3
    r = _result("ready", "b", 1.234, "d")
    assert r == {"status": "ready", "basis": "b", "usd": 1.23, "detail": "d"}
    print("biz_review_llm self-test OK")


def _load_env() -> dict:
    env = {}
    root = Path(__file__).resolve().parent.parent
    for path in (root / "back-end" / ".env", root / "agents" / ".env"):
        if path.exists():
            for line in path.read_text().splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    env.setdefault(key.removeprefix("export ").strip(), value.strip().strip('"').strip("'"))
    env.update({k: v for k, v in os.environ.items() if k.startswith(("AZURE_", "CEREBRAS_", "BOXES_"))})
    return env


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["self-test"]:
        self_test()
    elif args[:1] == ["azure-login"]:
        azure_login(args[1] if len(args) > 1 else "organizations")
    else:
        end = _parse(args[args.index("--end") + 1]) if "--end" in args else datetime.now(timezone.utc)
        start = _parse(args[args.index("--start") + 1]) if "--start" in args else end - timedelta(days=7)
        env = _load_env()
        print(json.dumps({"window": [start.isoformat(), end.isoformat()],
                          "azure_foundry": azure_cost(env, start, end),
                          "cerebras": cerebras_cost(env, start, end)}, indent=2))
