# Tilion Cloud REST API reference

Base URL: `https://back.tilion.dev`

Every request below is a plain HTTPS call; anything the service can do is reachable through these routes.

## Contents

0. Best practices
1. Overview and quickstart
2. Authentication
3. Rate limits and quotas
4. Billing and usage
5. Errors
6. Health
7. Sessions
8. Driving a session over HTTP
9. Saved logins
10. Playwright and raw CDP
11. Live view and VNC
12. Fetch and jobs
13. Extract
14. Scrape and crawl
15. Search
16. Inspect and solve
17. Agent tasks
18. Templates
19. Skills
20. Workflows
21. Plans
22. Credentials, connect links, verifications and approvals
23. Session sidecar
24. MCP server

## Conventions

- Every `/v1` route takes `Authorization: Bearer <api key>` unless the entry says otherwise. WebSocket routes and viewer pages take a short-lived token minted for one session instead, so the key never rides in a URL.
- Session ids look like `sess_` followed by 32 hex characters. Tab ids are 32 hex characters.
- Times (`created_at`, `last_active`, `expires_at`, `closed_at`, `retained_until`) are Unix seconds as floats.
- Every response carries an `X-Request-ID` header. Quote it when you contact support.
- Error bodies are `{"detail": "message"}`, `{"detail": {"error": "slug", "message": "..."}}` or, for a body that failed validation, `{"detail": [{"type", "loc", "msg", "input"}]}` with status 422.
- In the examples below the API key is written as `ph_live_...` and short-lived tokens as `<token>`.

# Best practices

Read this before choosing a route. The rules below are repeated next to the routes they affect.

## Use `POST /v1/fetch` for stealth reads, not raw CDP

For any page that may be protected (anti-bot, challenge, geo wall, login wall), read it with `POST /v1/fetch` (or `POST /v1/extract` for markdown). Do not drive the navigation yourself over raw CDP or Playwright `page.goto()`.

Why:

- `fetch` detects walls and challenges, solves CAPTCHAs, and escalates through stronger exit tiers (datacenter, ISP, residential, mobile) until the page is delivered. It reports what it did in `self_healed`, `recovery`, `detected` and `premium_required`. A raw CDP `Page.navigate` gets none of that: a blocked page is just a blocked page.
- `fetch` returns a typed outcome (`status`, `content_ok`, `error`) so an agent can branch without guessing from HTML.
- A vanilla CDP client sends `Runtime.enable` and other automation tells that protected sites fingerprint. The REST routes drive the browser through a hardened path.
- `fetch` and `navigate` keep the session's cookies and persona coherent across the retry ladder; a hand-rolled retry over CDP does not.

Use raw CDP or Playwright only for your own applications or unprotected sites where you need the full Playwright API. Even then, set `cdp_observe: true` (the default) so navigations are watched for challenges.

## Other rules

- One session, many pages. A session is a browser with cookies and a stable persona; reuse it across calls. Do not create a session per page. Release it with `DELETE /v1/session/{id}` in a `finally` block; it bills by the minute until it ends.
- One driver per session. Do not mix REST drive calls with an attached CDP or Playwright client on the same session; REST calls wait for the client and can end in `error: "deadline"`.
- One job per session. A second `fetch` on a session with a running job is refused with 409 `session_busy`. Parallel reads need parallel sessions.
- Protected pages go async. A challenged page can spend the whole 55 second synchronous budget on exit escalation. For pages you know are protected, send `async_mode: true` or `on_deadline: "continue"` and poll `GET /v1/job/{job_id}`.
- Trust `content_ok`, not `status`, when deciding whether a fetch delivered real content.
- Check `GET /v1/usage` and `GET /v1/credits` before a large batch; `remaining` and `premium_required` tell you whether residential unlock is available to you.
- `POST /v1/solve` is for a page you are driving by hand with `navigate` and `act`. A `fetch` that came back `blocked` has already tried the solvers.
- Send `Idempotency-Key` on every `POST /v1/session` retry so a lost reply never leaves you paying for two browsers.
- Use `POST /v1/session/{id}/elements` to get a selector before `act`; never guess selectors.

# 1. Overview and quickstart

What the API gives you:

- A stealth browser per session. `POST /v1/session` boots a real Chrome in the cloud, hardened against bot detection, with its own exit IP and a coherent device identity. You drive it over REST, over CDP, or over Playwright, and you can watch it live.
- Self-healing page reads. `POST /v1/fetch` opens a URL in the session and returns the page with a typed outcome. When a page is blocked it retries through stronger unlock tiers and tells you what it did (`self_healed`, `recovery`) and what it could not do (`premium_required`). This is the route to use for any protected page; raw CDP navigation gets no unblocking.
- Search. `POST /v1/search` runs a web search through a chain of engines and returns ranked results with the engine that answered.
- Extraction. `POST /v1/extract` and `POST /v1/scrape` turn a page into clean Markdown, plain text, links and metadata.
- Automation. `POST /v1/session/{id}/act` drives clicks, typing and keys on the live page, `POST /v1/agent` runs named tasks (login, paginate, download), `POST /v1/template` runs workflow templates, and `POST /v1/workflow` runs a plain-English goal or replays a recording.
- Accounts. `GET /v1/usage` and `GET /v1/credits` show where you stand against the plan and the wallet.

One session is one browser. It keeps cookies and logins between calls, so sign in once and reuse it; do not create a session per page. Release it with `DELETE /v1/session/{id}` in a `finally` block, because a session is billed by the minute while it exists.

## Quickstart

Set your key once:

```bash
export TILION_API_KEY="ph_live_..."
```

Create a session. The `Idempotency-Key` header is optional; with it a retry after a lost reply returns the same session instead of starting a second one.

```bash
curl -X POST https://back.tilion.dev/v1/session \
  -H "Authorization: Bearer $TILION_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: quickstart-1" \
  -d '{}'
```

```json
{
  "session_id": "sess_6ac44536ab704d77b335f09ca281ada1",
  "state": "ready",
  "mode": "ephemeral",
  "region": null,
  "owner": "acme",
  "created_at": 1792420162.081036,
  "last_active": 1792420162.0894966,
  "idle_timeout": 300.0,
  "ttl": 3600.0,
  "expires_at": 1792420462.0894966,
  "connect_url": "wss://back.tilion.dev/v1/session/sess_6ac44536ab704d77b335f09ca281ada1/cdp?token=<token>",
  "connect_expires_in": 1800.0,
  "playwright_url": "wss://back.tilion.dev/v1/session/sess_6ac44536ab704d77b335f09ca281ada1/playwright?token=<token>",
  "exit_id": null,
  "persona": "tenant-e348aa33fc1f00377fb8b75b",
  "full_browser": false,
  "geo_applied": null,
  "geo_unsupported": null
}
```

The status is 201. A retry with the same `Idempotency-Key` answers 201 with the same `session_id` and a fresh `connect_url`; no second browser is started.

Open a page in the session's tab:

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_6ac44536ab704d77b335f09ca281ada1/navigate \
  -H "Authorization: Bearer $TILION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/"}'
```

```json
{
  "session_id": "sess_6ac44536ab704d77b335f09ca281ada1",
  "final_url": "https://example.com/",
  "title": "Example Domain",
  "status": "ok",
  "http_status": 200,
  "error": null,
  "failure_type": null,
  "cause": null,
  "self_healed": false,
  "recovery": null,
  "detected": null,
  "held": null,
  "requested_url": "https://example.com/",
  "redirected": false
}
```

Fetch a page and get its text back in one call:

```bash
curl -X POST https://back.tilion.dev/v1/fetch \
  -H "Authorization: Bearer $TILION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"session_id": "sess_6ac44536ab704d77b335f09ca281ada1", "url": "https://example.com/"}'
```

```json
{
  "session_id": "sess_6ac44536ab704d77b335f09ca281ada1",
  "final_url": "https://example.com/",
  "status": "ok",
  "http_status": 200,
  "job_id": "sess_6ac44536ab704d77b335f09ca281ada1.37c653d22892473ebab5ed247224dd4a",
  "job": null,
  "captcha": "none",
  "title": "Example Domain",
  "text": "This domain is for use in documentation examples without needing permission. ...",
  "html_len": 1974,
  "html": null,
  "self_healed": false,
  "recovery": null,
  "held": null,
  "detected": null,
  "content_ok": true,
  "status_reconciled": null,
  "requested_url": "https://example.com/",
  "redirected": false,
  "error": null,
  "failure_type": null,
  "cause": null,
  "reason": null,
  "origin": null,
  "premium_required": null,
  "readiness": null,
  "selector_found": null,
  "settle": null
}
```

Extract an article as Markdown plus page metadata. `formats` picks what comes back; `max_chars` cuts the Markdown at a block boundary and reports `truncated`.

```bash
curl -X POST https://back.tilion.dev/v1/extract \
  -H "Authorization: Bearer $TILION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "sess_6ac44536ab704d77b335f09ca281ada1",
    "url": "https://en.wikipedia.org/wiki/Web_scraping",
    "formats": ["markdown", "metadata"],
    "max_chars": 1200
  }'
```

```json
{
  "job_id": null,
  "data": null,
  "extract_tokens": null,
  "session_id": "sess_6ac44536ab704d77b335f09ca281ada1",
  "final_url": "https://en.wikipedia.org/wiki/Web_scraping",
  "status": "ok",
  "blocked_reason": null,
  "self_healed": false,
  "premium_required": null,
  "title": "Web scraping - Wikipedia",
  "markdown": "# Web scraping\n\nFrom Wikipedia, the free encyclopedia\n\n...",
  "markdown_len": 963,
  "tokens_estimate": 240,
  "text": null,
  "html": null,
  "links": null,
  "metadata": {
    "title": "Web scraping - Wikipedia",
    "description": null,
    "canonical": "https://en.wikipedia.org/wiki/Web_scraping",
    "lang": "en",
    "og_title": "Web scraping - Wikipedia",
    "og_description": null,
    "og_image": null,
    "og_site_name": null,
    "published_time": null,
    "modified_time": null,
    "author": null,
    "word_count": 4353,
    "reading_time_min": 22
  },
  "truncated": true
}
```

Search the web. No session is needed; the API runs the search on its own browser pool.

```bash
curl -X POST https://back.tilion.dev/v1/search \
  -H "Authorization: Bearer $TILION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "chrome devtools protocol", "count": 3}'
```

```json
{
  "query": "chrome devtools protocol",
  "engine": "duckduckgo",
  "count": 3,
  "offset": 0,
  "total_found": 10,
  "has_more": true,
  "results": [
    {
      "title": "Chrome DevTools Protocol",
      "url": "https://chromedevtools.github.io/devtools-protocol/",
      "snippet": "Chrome DevTools Protocol The Chrome DevTools Protocol (CDP) is a JSON-based protocol that connects debug and automation targets ...",
      "rank": 1,
      "engine": "duckduckgo",
      "domain": "chromedevtools.github.io",
      "published": null
    }
  ],
  "status": "ok",
  "reason": null,
  "engines_tried": [{"engine": "duckduckgo", "status": "ok", "reason": null, "took_ms": 1122}],
  "fallback_from": null,
  "cached": false,
  "took_ms": 1238,
  "suggestion": null,
  "operators": [],
  "knowledge_graph": null,
  "people_also_ask": [],
  "related_searches": [],
  "answer_box": null,
  "region": null,
  "exit": null
}
```

Release the session:

```bash
curl -i -X DELETE https://back.tilion.dev/v1/session/sess_6ac44536ab704d77b335f09ca281ada1 \
  -H "Authorization: Bearer $TILION_API_KEY"
```

The answer is `204 No Content` with `Location: /v1/session/sess_6ac44536ab704d77b335f09ca281ada1/status`. A second DELETE answers 204 again. Reading the session afterwards answers 410 with its terminal record; see Errors.

# 2. Authentication

## Bearer API keys

Every `/v1` route takes an API key in the `Authorization` header:

```
Authorization: Bearer ph_live_...
```

Keys are issued in the dashboard under API keys. A key is shown once at creation and stored hashed; when you create one you can give it a name, a spend limit in credits, an expiry (a number of days, or `7d`, `30d`, `90d`, `1y`) and a spend reset period (`daily`, `weekly`, `monthly`, `never`). Revoke a leaked key from the same page. Keep keys server side: a key is full control of your browser sessions and your credits.

A request without the header answers 401:

```json
{"detail": "Missing API key (Authorization: Bearer ph_...)"}
```

A request with a bad, revoked or expired key answers 401 as well. Both carry `WWW-Authenticate: Bearer`:

```json
{"detail": "Invalid API key"}
```

Two other answers come from the key itself rather than the request:

- 402 with a plain `detail` string when the key has spent its own credit limit. Raise the limit in the dashboard or use another key.
- 503 `{"detail": "auth backend unavailable, please retry"}` with `Retry-After: 2` when the key could not be checked. Retry; do not rotate the key.

## Scopes

Each key carries scopes, and every route checks the scope its method needs:

| Scope | What it allows |
|---|---|
| `sessions:read` | GET, HEAD and OPTIONS routes: reading sessions, tabs, usage, credits, lists. |
| `sessions:write` | Every other method: creating sessions, every page read and drive call, every billable route. Includes `sessions:read`. Two GET routes also need it because they hand over control: `GET /v1/session/{id}/connect` (a raw CDP URL) and the sidecar HTTP passthrough. |
| `cdp` | Full control of a session, read and write. This is the scope the MCP OAuth flow issues; it also satisfies `/connect` and the MCP server. |
| `admin` | Everything. |

Dashboard-issued keys carry `sessions:read` and `sessions:write`. A key that lacks the scope a route needs answers 403 with a plain string, `this API key lacks the 'sessions:write' scope`. The hosted MCP server needs `sessions:write` or `cdp` and answers 403 with `{"error": "..."}`.

## Request ids

Every response carries an `X-Request-ID` header with a 16-character id, including 401 and 404 answers, 429 refusals, 500s, and the empty 204 and 405 answers. Quote it when you contact support. Inbound `X-Request-ID` values are not echoed; the API assigns its own.

## Idempotency

`POST /v1/session` accepts an `Idempotency-Key` header. The key is scoped to your account:

- A second create with the same key answers 201 with the same session, as long as that session is alive: same `session_id`, same `created_at`, a fresh `connect_url`.
- If the first create is still running, the second waits for it and then returns the same session.
- The key is remembered for an hour after the create finishes. If the session has ended by the time you retry, the key is released and the retry creates a new session.
- 409 `{"detail": {"error": "idempotency_key_in_use", "message": "..."}}` when a create under this key could not be settled in time. Retry shortly.

Use it whenever you retry a create after a timeout, so a retry can never leave you paying for two browsers.

# 3. Rate limits and quotas

Three independent limits apply and you hit whichever comes first: request throttles per API key, live-session concurrency per account, and the monthly plan allowance. `GET /v1/usage` reports all three for your key, so read it rather than guessing.

## Request throttles

Throttles are counted per API key across every server. Each 429 says which limit was hit, how big it is and when to retry.

| Bucket | What it counts | Your limit | 429 `error` |
|---|---|---|---|
| drive | Every call that drives or reads a session's browser: navigate, fetch, extract, inspect, scrape, crawl, search, task, solve, act, screenshot, elements, tabs, files, context, rotate-ip, agent, template, and the noVNC page. | `rate_limits.drive_per_minute` in `GET /v1/usage`. It scales with your concurrency cap (4 calls per minute per concurrent session allowed, with a floor every key gets). | `rate_limited` |
| session-create | `POST /v1/session`, and attempts on `POST /v1/credits/redeem`. | `rate_limits.session_creates_per_minute`. | `rate_limited` |
| inspect | Concurrent `POST /v1/inspect` captures. | `rate_limits.concurrent_inspects`: 3, whatever the plan. | `too_many_concurrent_inspects` |
| auth failures | Requests that fail authentication, per client address. | 10 failures in a minute, then that address is refused for about a minute. Requests with a valid key from the same address are not affected. | plain string |

A `rate_limited` answer carries these fields in `detail`: `error`, `message`, `limit`, `window_seconds` (60), `scope` (`api_key`) and `retry_after_seconds`, with the headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining: 0` and `X-RateLimit-Reset` (a Unix timestamp).

The inspect cap, as returned when a fourth capture is started:

```
HTTP/1.1 429
Retry-After: 5
X-RateLimit-Limit: 3
X-RateLimit-Remaining: 0
```

```json
{
  "detail": {
    "error": "too_many_concurrent_inspects",
    "message": "too many concurrent inspect captures: 3 at a time for this API key, counted across all workers; retry in 5 s",
    "limit": 3,
    "scope": "api_key",
    "retry_after_seconds": 5
  }
}
```

The auth throttle answers 429 with `{"detail": "invalid API key; too many failed attempts from this address, retry later"}` and a `Retry-After` header.

## Concurrency

Concurrency counts live sessions across your whole account, not requests, and the cap is `concurrency_limit` in `GET /v1/usage`. A create past the cap answers 429 with `detail` fields `error: "concurrency_limit"`, `message`, `limit`, `tier` and `upgrade_url`. The usual cause is sessions that were never released: list them with `GET /v1/sessions`, keep `idle_timeout` short, and release in a `finally` block.

Tabs are capped per session as well. `GET /v1/session/{id}/tabs` reports `max` (15); opening one more answers 429 `{"detail": {"error": "tab_limit", "limit": 15}}`.

## Plans and the monthly allowance

| Plan | Concurrent sessions | Browser hours per month | Premium egress included | Longest session | Past the allowance |
|---|---|---|---|---|---|
| Free | 10 | 10 | 1 GB | 30 min | hard stop |
| Developer | 25 | 250 | 2 GB | 2 h | metered overage |
| Team | 250 | 2500 | 25 GB | 12 h | metered overage |
| Pro (earlier plan) | 50 | 500 | 10 GB (and 10,000 actions, 15,000 solves) | 6 h | metered overage |
| Scale (earlier plan) | 200 | 5000 | 35 GB (and 100,000 actions, 50,000 solves) | 12 h | metered overage |
| Enterprise | 250 and up | unlimited | negotiated | unlimited | metered |

Browser hours, concurrency and premium egress (traffic through residential, ISP and mobile exits) are the metered axes on the current plans; actions and CAPTCHA solves are uncapped there and billed in credits. Self-healing is on every plan; the paid-exit traffic it spends is premium egress. A plan past its allowance without overage (Free) is refused with 402 `quota_exceeded`; paid plans continue and the excess is invoiced.

`null` in `limits` or `remaining` means unlimited on your plan. `ttl` on a create is clamped to the plan's longest session; asking for more answers 422 `ttl_exceeds_plan` with `max_ttl`.

## Body size and deadlines

- A request body over 4 MB answers 413 `{"detail": "request body too large"}`.
- Every synchronous `/v1` call has a server-side deadline of about 57 seconds. Past it the API answers 504 `{"error": "deadline_exceeded", "detail": "...", "deadline_s": 57}` with `retry_with: "async_mode"`, the session intact. Fetch, extract, inspect, solve and agent take `async_mode: true` to run as a job you poll on `GET /v1/job/{id}`; fetch also takes `on_deadline: "continue"`.
- An inspect capture is capped at 180 seconds plus a fixed overhead for the page load and the report.

# 4. Billing and usage

Two meters run side by side. The plan meters the month (browser hours, concurrency, premium egress, and on the earlier plans actions and solves); the credit wallet is debited per call. Credits are an abstract unit: the cost table in `GET /v1/credits` is the price list.

## GET /v1/usage

Month-to-date usage against the plan, the key's throttles, and premium egress by exit type. Read `remaining` here rather than waiting for a 402.

Auth: Bearer API key. No body.

```bash
curl https://back.tilion.dev/v1/usage -H "Authorization: Bearer $TILION_API_KEY"
```

```json
{
  "owner": "acme",
  "tier": "team",
  "month": "2026-10",
  "usage": {"actions": 4115, "egress_bytes": 12699763818, "browser_seconds": 446141, "sessions": 8273, "captcha_solves": 12},
  "limits": {"actions": null, "egress_bytes": 26843545600, "browser_seconds": 9000000, "sessions": null, "captcha_solves": null},
  "remaining": {"actions": null, "egress_bytes": 14143781782, "browser_seconds": 8553859, "sessions": null, "captcha_solves": null},
  "browser_hours": {"used": 123.928, "included": 2500.0, "remaining": 2376.072},
  "concurrency_limit": 250,
  "rate_limits": {
    "drive_per_minute": 1000,
    "session_creates_per_minute": 1000000,
    "concurrent_inspects": 3,
    "scope": "api_key",
    "shared_across_workers": true
  },
  "premium_egress": true,
  "self_healing": true,
  "overage_allowed": true,
  "premium_egress_usage": {
    "included_gb": 25.0,
    "used_gb": 3.9238,
    "remaining_gb": 21.0762,
    "by_type": {
      "dc": {"used_gb": 0.0, "overage_gb": 0.0},
      "isp": {"used_gb": 0.0016, "overage_gb": 0.0},
      "res": {"used_gb": 3.9222, "overage_gb": 0.0},
      "mobile": {"used_gb": 0.0, "overage_gb": 0.0}
    },
    "overage_usd": 0.0,
    "prices_usd_per_gb": {
      "res": [{"up_to_gb": 5, "usd_per_gb": 5.5}, {"up_to_gb": 20, "usd_per_gb": 4.5}, {"up_to_gb": 1000, "usd_per_gb": 3.5}, {"up_to_gb": null, "usd_per_gb": 2.0}],
      "mobile": [{"up_to_gb": 4, "usd_per_gb": 7.0}, {"up_to_gb": 14, "usd_per_gb": 6.17}, {"up_to_gb": 714, "usd_per_gb": 4.5}, {"up_to_gb": null, "usd_per_gb": 3.0}],
      "dc": [{"up_to_gb": 50, "usd_per_gb": 0.48}, {"up_to_gb": 181, "usd_per_gb": 0.44}, {"up_to_gb": 1100, "usd_per_gb": 0.36}, {"up_to_gb": null, "usd_per_gb": 0.32}],
      "isp": [{"up_to_gb": 5, "usd_per_gb": 5.5}, {"up_to_gb": 20, "usd_per_gb": 4.5}, {"up_to_gb": 1000, "usd_per_gb": 3.5}, {"up_to_gb": null, "usd_per_gb": 2.0}]
    }
  },
  "enforced": true
}
```

| Field | Type | Meaning |
|---|---|---|
| `owner` | string | Your account id. |
| `tier` | string | Your plan: `free`, `developer`, `team`, `pro`, `scale` or `enterprise`. |
| `month` | string | The billing month, `YYYY-MM`. |
| `usage` | object | Month to date: `actions` (billable calls that delivered), `egress_bytes` (page, file and screenshot bytes delivered to you), `browser_seconds` (time sessions were alive), `sessions` (sessions counted this month), `captcha_solves`. |
| `limits` | object | The plan's included amount on each axis; `null` is unlimited. |
| `remaining` | object | `limits` minus `usage`, floored at 0; `null` where the limit is `null`. |
| `browser_hours` | object | `browser_seconds` in hours: `used`, `included`, `remaining`. |
| `concurrency_limit` | integer | Live sessions you may hold at once, the higher of the plan's cap and a cap granted to this key. |
| `rate_limits` | object or null | The throttles that answer 429: `drive_per_minute`, `session_creates_per_minute`, `concurrent_inspects`, `scope` (`api_key`), `shared_across_workers` (true when the count is global). `null` when throttling is off. |
| `premium_egress` | boolean | Whether the plan may use residential, ISP and mobile exits. |
| `self_healing` | boolean | Whether blocked reads escalate through stronger exits. |
| `overage_allowed` | boolean | Whether usage past the allowance is metered (true) or refused (false). |
| `premium_egress_usage` | object | Proxy traffic this month: `included_gb`, `used_gb`, `remaining_gb`; `by_type` for `dc`, `isp`, `res` and `mobile` with `used_gb` and `overage_gb`; `overage_usd` run up so far; `prices_usd_per_gb`, the graduated bands per type (`up_to_gb: null` is the last band). |
| `enforced` | boolean | Whether the plan limits are enforced. |

## GET /v1/credits

The prepaid balance and the price list that every billable call is charged against.

```bash
curl https://back.tilion.dev/v1/credits -H "Authorization: Bearer $TILION_API_KEY"
```

```json
{
  "owner": "acme",
  "balance": 12480.5,
  "enforced": true,
  "browser_hours_remaining": 208.008,
  "cost": {
    "action": 1.0,
    "captcha": 20.0,
    "egress_mb": 1.0,
    "session": 2.0,
    "browser_minute": 1.0,
    "browser_hour": 60.0,
    "plan_call": 2.0,
    "workflow_step": 2.0
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `owner` | string | Your account id. |
| `balance` | number | Credits in the wallet. A burst of concurrent calls can drive it slightly below zero; the next call is then refused until you top up. |
| `enforced` | boolean | Whether an empty wallet refuses billable calls. |
| `browser_hours_remaining` | number or null | `balance` divided by the hourly browser rate; null when browser time is not priced. |
| `cost.action` | number | One billable call (fetch, navigate, extract, search, act, and so on). |
| `cost.captcha` | number | One CAPTCHA or challenge solve, wherever it happens. |
| `cost.egress_mb` | number | One MB of page, file, screenshot or CDP traffic delivered to you through a datacenter exit. |
| `cost.session` | number | Starting a session. |
| `cost.browser_minute`, `cost.browser_hour` | number | Each minute a session is alive, debited once a minute, whether or not you call anything. |
| `cost.plan_call` | number | One `POST /v1/plan`, or the planning step of a prompt-driven `POST /v1/workflow`. |
| `cost.workflow_step` | number | Each step a workflow runs. |

## POST /v1/credits/redeem

Redeem a promo code into the wallet. Single use per account.

Request: `{"code": "..."}` (`promo` is accepted as an alias). Codes are matched case-insensitively.

```bash
curl -X POST https://back.tilion.dev/v1/credits/redeem \
  -H "Authorization: Bearer $TILION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code": "YOUR-CODE"}'
```

A valid code answers 200 with `ok: true`, `granted` (the credits added) and `balance` (the new balance); the new balance applies to the very next call.

Errors:

| Status | `error` | When |
|---|---|---|
| 400 | `unknown_code` | No such code, or it has expired. |
| 409 | `already_redeemed` | This account already used the code; `balance` is included. |
| 429 | `rate_limited` | Too many redeem attempts; the session-create bucket throttles guessing. |

## What each route costs

Charges settle after the work, so a call that is refused or fails before it does anything is not billed; a fetch that delivers is. The table uses the prices above.

| Route | Credits |
|---|---|
| `POST /v1/session` | 2 at create, then 1 per minute while the session lives. A create that fails costs nothing. |
| `POST /v1/session/{id}/navigate`, `/act`, `/elements`, `/context` (GET and POST), `/rotate-ip`, `POST /v1/session/{id}/tabs` | 1 |
| `POST /v1/fetch`, `GET /v1/job/{id}` for a fetch job | 1 when the page is delivered, plus the page's MB at the datacenter rate, or at the premium rate when a residential, ISP or mobile exit served it. Nothing for a blocked or failed fetch. |
| `POST /v1/extract` | 1, plus 5 when you ask for structured `data` with `schema` or `prompt` (that pass runs a model). |
| `POST /v1/scrape` | 1 plus 1 per MB of page. |
| `POST /v1/crawl` | 1 per page delivered, at least 1. |
| `POST /v1/inspect` | 1 plus 1 per MB the capture moved. |
| `POST /v1/search`, `POST /v1/task` | 1 |
| `POST /v1/session/{id}/screenshot`, `POST /v1/session/{id}/files/fetch` | 1 plus 1 per MB of the image or file. |
| `POST /v1/agent`, `POST /v1/template` | 1 per run. |
| `POST /v1/solve`, and automatic solving during a session | 20 per challenge solved; nothing when there was nothing to solve. |
| `POST /v1/plan` | 2 |
| `POST /v1/workflow` | 2 per step, plus 2 for the plan when you send a `prompt`. A recording replay bills steps only. |
| Raw CDP and Playwright connect, and the noVNC window | 1 per MB relayed to you through a datacenter exit; the premium rate on a residential session. |

Traffic through a residential, ISP or mobile exit is billed per MB at the premium rate instead of the datacenter rate, and counted against the plan's included premium egress.

## Premium egress

Every byte a session moves through a paid exit (residential, ISP or mobile, chosen with `residential: true`, `proxy_type`, `stealth: "max"` or a `geo` target on create, or spent by self-healing on a blocked page) is metered by exit type and reported in `premium_egress_usage`. The plan's included GB is shared by all types; past it, each GB is invoiced at the graduated prices in `prices_usd_per_gb` on a plan with overage, and refused on a plan without it. Datacenter sessions keep working either way.

Refusals you can get:

| Status | `error` | When |
|---|---|---|
| 402 | `residential_egress_paid` | A plan without premium egress and an empty wallet asked for a residential session. `upgrade_url` and `redeem_url` are included. |
| 402 | `premium_egress_exhausted` | The month's included proxy traffic is used up on a plan without overage. |
| 402 | `insufficient_credits` | The wallet cannot cover the next charge. `balance` and `redeem_url` are included. |
| 402 | `quota_exceeded` | The monthly allowance is used up on a plan without overage. `reason`, `tier`, `upgrade_url` and `checkout` are included. |
| 403 | `account_suspended` | The account was suspended; contact support. |

## `premium_required`

`POST /v1/fetch` and `POST /v1/extract` do not fail when a page can only be reached through a paid exit you cannot use. They answer 200 with the outcome they could reach (`status` `challenged`, `hard_blocked` or similar) and set `premium_required` to a sentence saying what would unlock it: that this month's included premium egress is used up and the plan needs an upgrade, or that the wallet needs more credits for residential unlock and CAPTCHA solving. It is `null` on every other answer.

## Plans

Developer and Team are the self-serve paid plans, billed by card through the dashboard; Free needs no card. Checkout and the billing portal are dashboard actions. Both paid plans allow overage: browser time, premium egress by exit type, and on the earlier plans actions and solves, are metered past the included amounts and invoiced; credits in the wallet are spent on overage first. Pro and Scale remain for customers already subscribed. Enterprise lifts every cap.

# 5. Errors

## The envelope

Errors are JSON. `detail` is the field to read, and it takes three shapes:

- A string, on most 401, 403, 404, 409 and 501 answers:

```json
{"detail": "No such session"}
```

- An object, on every answer a program should branch on. It always has `error` (a stable slug) and usually `message`; some add `retryable`, and context such as `limit`, `balance`, `tier`, `upgrade_url`, `retry_after_seconds`, `max_ttl`, `job_id`:

```json
{"detail": {"error": "stealth_always_on", "message": "sessions are stealth-hardened by construction; stealth cannot be disabled"}}
```

- A list, on 422 validation failures, one entry per problem with `type`, `loc`, `msg` and `input`:

```json
{"detail": [{"type": "missing", "loc": ["body", "url"], "msg": "Field required", "input": {"session_id": "sess_00000000000000000000000000000000"}}]}
```

Four answers come from outside the route and use a top-level shape instead: 500 `{"status": "error", "detail": "internal error"}`, the 504 `{"error": "deadline_exceeded", ...}` and `{"error": "browser_timeout", ...}` answers, 413 `{"detail": "request body too large"}`, and the MCP endpoint's `{"error": "..."}`. A tolerant reader takes `detail.error` when `detail` is an object, `detail` when it is a string, joins `loc` and `msg` when it is a list, and falls back to a top-level `error`.

A wrong value answers the 422 list shape with the reason in `msg`; for example `POST /v1/session` with `{"region": "zz"}` answers `Value error, unknown region 'zz'; see GET /v1/regions`.

## Status codes

| Status | When | Retry |
|---|---|---|
| 400 | A request the route understands but refuses: a blocked or non-public URL, a bad selector, a bad promo code, `stealth: false`, a malformed path. | No, fix the request. |
| 401 | Missing, invalid, revoked or expired API key. `WWW-Authenticate: Bearer`. | No. |
| 402 | Out of credits, over the monthly allowance, a key over its spend limit, or a paid feature on a plan without it. | No, top up or upgrade. |
| 403 | The key lacks a scope, the account is suspended, a view or VNC token is wrong, or a feature is not enabled for the key. | No. |
| 404 | No such session, tab, job or saved login for this key, or the session's record has aged out. | No, except on DELETE where 404 means already gone. |
| 405 | `GET /mcp/`. The MCP transport takes POST and DELETE only. | No. |
| 406 | `POST /mcp/` without an `Accept` header that lists both `application/json` and `text/event-stream`. | No. |
| 409 | A conflict with the session's state: a region or proxy type that cannot be served, the last tab, no tab, no page loaded, a fetch already running on the session, an idempotency key still in flight, a code already redeemed. | Usually no; `session_busy` and `idempotency_key_in_use` after a moment. |
| 410 | The session has ended. `detail` is its terminal record. | No, create a new session. |
| 413 | Request body over 4 MB, or a download over its cap. | No. |
| 422 | The body failed validation, or a value is outside your plan (`ttl_exceeds_plan`, `session_ttl_cannot_hold_job`), or a task or template was given bad params. | No, fix the request. |
| 429 | A throttle, the concurrency cap, the tab cap, the inspect cap, or an auth block. `Retry-After` is set. | Yes, after `Retry-After`. |
| 500 | An unhandled failure. The body says only `internal error`; the cause is logged against `X-Request-ID`. | Once. |
| 501 | A feature that is not available: structured extraction, verifications, connect links. | No. |
| 502 | A browser operation failed: a session could not be launched, a page could not be rendered or captured, a file could not be downloaded, a sidecar did not answer. | Yes, with backoff. |
| 503 | No capacity, the requested exit or full browser is unavailable, the auth or session backend is unreachable. `Retry-After` is set where retrying helps. | Yes, after `Retry-After`. |
| 504 | A deadline: the synchronous deadline, a fetch past its budget (`deadline`), an inspect or file fetch past its cap, a page that stopped answering the browser (`browser_timeout`). The session is kept. | Yes, or run it as a job. |

Retry 429, 502, 503 and 504 with exponential backoff and jitter, honouring `Retry-After`; send an `Idempotency-Key` when the retry is a session create. Do not retry other 4xx.

## Error slugs by route family

The `error` values the API answers with, grouped by where you meet them. A slug appears with the status it carries.

Authentication and account, any route: 401 (plain string), 403 `account_suspended`, 403 scope refusal (plain string), 402 `insufficient_credits`, 402 `quota_exceeded`, 402 key spend limit (plain string), 429 `rate_limited`, 400 `bad_path`.

Session create, `POST /v1/session`: 400 `stealth_always_on`, 400 `stealth_max_needs_premium_egress`, 402 `residential_egress_paid`, 402 `premium_egress_exhausted`, 409 `idempotency_key_in_use`, 409 `region_unavailable` (with `available`), 409 `proxy_type_unavailable`, 422 `ttl_exceeds_plan` (with `max_ttl`), 429 `concurrency_limit` (with `limit`, `tier`, `upgrade_url`), 502 `session_launch_failed`, 503 `capacity_unavailable` (`Retry-After: 5`), 503 `residential_vendor_unavailable` (`Retry-After: 60`), 503 `residential_egress_unavailable`, 503 `full_browser_unavailable`.

Session reads and release, `GET /v1/session/{id}`, `/status`, `DELETE`: 404 (plain string), 410 terminal record, 410 `browser_crashed` (`retryable: false`), 410 plain string when the session's server is unreachable, 503 plain string when a release could not be confirmed.

Page reads, `POST /v1/fetch`, `GET /v1/job/{id}`: 404 plain string for an unknown job, 409 `session_busy` (with the running `job_id`), 410 `session_closed_during_fetch` (with `reason`, `origin`, `cause`), 422 `session_ttl_cannot_hold_job`, 504 with `error: "deadline"` in the fetch body itself.

Extract, scrape, crawl, inspect: 501 `structured_extraction_unavailable`, 502 `extract_failed`, 502 `scrape_failed` (`retryable: true`), 502 `inspect_failed`, 504 `inspect_timeout`, 429 `too_many_concurrent_inspects`.

Search, `POST /v1/search`: 422 `invalid_region`, 422 `unsupported_region`, 422 `region_with_session`, 429 `concurrency_limit`, 502 `session_launch_failed`, 502 `region_unavailable`, 503 `region_routing_unavailable`.

Tabs, elements, act, screenshot, navigate: 404 `element_not_found`, 400 `bad_selector`, 409 `no_page_loaded`, 409 `last_tab`, 404 plain `No such tab`, 429 `tab_limit`, 502 `tab_navigation_failed`.

Files and downloads, `POST /v1/session/{id}/files/fetch`: 409 `no_tab`, 413 plain string, 502 `file_fetch_failed` (`retryable: true`), 502 `download_failed`, 504 `file_fetch_timeout`.

Saved logins, `POST /v1/session/{id}/save-auth`, `/v1/auth/*`: 400 `incomplete_cookie_set`, 400 plain string when there is nothing to save, 404 plain string for an unknown domain.

Agent and templates, `POST /v1/agent`, `POST /v1/template`: 422 `invalid_agent_params`, 422 `invalid_template_params` (with `issues`), 400 plain string for an unknown task or template.

Sidecar, `/v1/session/{id}/sidecar*`: 403 `sidecar_not_enabled`, 409 `sidecar_unavailable`, 422 `sidecar_start_failed`, 502 `sidecar_unreachable`.

Credits, `POST /v1/credits/redeem`: 400 `unknown_code`, 409 `already_redeemed`.

Deadlines, any route: 504 `deadline_exceeded`, 504 `browser_timeout` (with `cdp_method` and `retry_with`).

## When a session has ended

A session ends when you release it, when it idles past `idle_timeout`, when it reaches `ttl`, when its browser crashes, or when the service ends it. Its record is kept for an hour after that, and during that hour:

- `GET /v1/session/{id}` and every drive call answer 410 with the record in `detail`.
- `GET /v1/session/{id}/status` answers 200 with the same record.
- `DELETE /v1/session/{id}` answers 204 with `Location: /v1/session/{id}/status`.
- After the hour, all of them answer 404 `No such session`.

The record:

```json
{
  "detail": {
    "session_id": "sess_6ac44536ab704d77b335f09ca281ada1",
    "owner": "acme",
    "state": "closed",
    "mode": "ephemeral",
    "region": null,
    "reason": "closed",
    "origin": "customer",
    "cause": null,
    "created_at": 1792420162.081036,
    "last_active": 1792420172.3192174,
    "idle_timeout": 300.0,
    "ttl": 3600.0,
    "closed_at": 1792420172.3192456,
    "cleanup": "done",
    "cleaned_at": 1792420172.5016863,
    "cleanup_finished_at": 1792420172.501687,
    "retained_until": 1792423772.3192456
  }
}
```

| Field | Meaning |
|---|---|
| `state` | `closed` (released, crashed or ended by the service) or `expired` (idle or ttl). |
| `reason` | `closed`, `idle_expired`, `ttl_expired`, or `data_plane:<why>` when the service ended it. |
| `origin` | Who ended it: `customer` (you), `expired` (idle or ttl), `data_plane` (the service, see `cause`), `host` (the machine it ran on). |
| `cause` | The failure that ended it when the service decided, else null. |
| `closed_at`, `cleanup`, `cleaned_at`, `cleanup_finished_at` | When it ended and whether teardown is `pending`, `done` or `failed`. |
| `retained_until` | When the record ages out and the id turns 404. |

Two 410s carry a different `detail`: `{"error": "browser_crashed", "retryable": false, "message": "..."}` when the browser crashed before the record was written, and `{"error": "session_closed_during_fetch", "message": "...", "reason": ..., "origin": ..., "cause": ...}` on a fetch whose session ended under it. A WebSocket on an ended session is refused on the handshake with the same 410 or 404; a bad token is refused with 403; an open socket whose browser crashes is closed with code 4410.

# 6. Health

Three unauthenticated probes, all answering JSON with `X-Request-ID`, none rate limited.

### GET /health

200 when this server can serve requests, 503 `{"status": "unhealthy"}` when it cannot.

```json
{"status": "ok", "loop_lag_s": 0.0, "loop_lag_max_5m_s": 0.003, "loop_stalls": 0}
```

### GET /livez

200 as long as the process is up and answering.

```json
{"status": "alive"}
```

### GET /readyz

200 `{"ready": true}` only when the billing store is reachable; 503 `{"ready": false, "reason": "..."}` otherwise. `/health` stays 200 through a short billing-store outage (balances are served from the last known value and settled afterwards), so use `/readyz` when you want to drain traffic from a server that cannot bill.

# 7. Sessions

A session is one isolated Chrome, dedicated to you until it ends. It keeps cookies, storage and logins between calls. It ends when you delete it, when it has been idle for `idle_timeout` seconds, or when it reaches its absolute `ttl`. Drive calls and CDP or Playwright activity reset the idle clock; reading the session does not.

Billing: a session is billed 2 credits at create and 1 credit per minute while it exists. Every drive call (navigate, act, elements, screenshot, opening a tab, file download, rotate-ip, a context restore that navigates) is one action, 1 credit. Screenshots, file downloads and the live streams also bill the bytes they return at 1 credit per MB. Reads (`GET /v1/session/{id}`, `/status`, `/sessions`, `/tabs`, `GET /context`, `/connect`, `/regions`, the token mints) are free.

## POST /v1/session

Boot a browser and return it ready, with a CDP connect URL and a Playwright URL you can use at once. Send an empty body for the defaults; every field is optional.

Auth: Bearer API key. Optional header `Idempotency-Key`: a retry with the same key returns the same session instead of starting a second one (the key is remembered for about an hour; a retry while the first create is still running answers 409 `idempotency_key_in_use`).

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | `"ephemeral"` or `"persistent"` | `ephemeral` | Session mode. Both honour `ttl` and `idle_timeout`. |
| `region` | string | nearest | A `code` from `GET /v1/regions` (`us`, `de`, `sg`). Unknown codes answer 422. |
| `persona` | string, max 64 | rotated | Pin the device identity (screen, cores, GPU, fonts). Omit it and the session gets one of your account's personas; the one used is returned as `persona`. |
| `ttl` | number, 5 to 43200 | 3600 | Absolute lifetime in seconds. Above the plan's maximum answers 422 `ttl_exceeds_plan` with `max_ttl`. |
| `idle_timeout` | number, 1 to 3600 | 300 | Seconds without a drive or CDP call before the session ends. |
| `residential` | boolean | fleet default (direct) | `true` routes the session through a residential exit (paid plans; metered as premium egress). `false` forces direct datacenter egress. Strict boolean: `"yes"` or `1` answers 422. |
| `proxy_type` | `"residential"` or `"mobile"` | none | Pin the paid exit type. Implies `residential: true`. A type not served right now answers 409 `proxy_type_unavailable`. |
| `geo` | object `{zip, city, state, country}` | none | Place a residential exit near a US ZIP (5 digits), a city (lowercase, no spaces), a state (2 letter) or a country (2 letter). Ignored on a direct session. The response says what landed in `geo_applied` and `geo_unsupported`. |
| `exit_region` | string like `us-east-1` | none | Narrow the exit choice to one region. |
| `exit_id` | string `eipalloc-...` | none | Start on one specific exit, for example the `exit_id` a previous session returned. |
| `proxy_rotation` | `per_session`, `per_request`, `manual` | `per_session` | Sessions keep one coherent exit; the value is accepted for compatibility and served as `per_session`. Use `POST /v1/session/{id}/rotate-ip` to change the exit. |
| `stealth` | `true` or `"max"` | `true` | Sessions are always stealth hardened; `false` answers 400 `stealth_always_on`. `"max"` starts on residential egress with a sticky exit from the first request (paid). `"max"` with `residential: false` answers 400 `stealth_max_needs_premium_egress`. |
| `block_ads` | `false`, `true`, `"basic"`, `"strict"`, `"off"` | `false` | Ad and tracker blocking. `true` or `basic` is the host blocklist; `strict` is the full filter engine, disables the HTTP cache and is detectable, so do not use it on an anti-bot target. |
| `full_browser` | boolean | `false` | Boot a headful Chrome with a visible desktop, watchable over VNC (`/vnc-token`). The response's `full_browser` tells you whether it was honoured. |
| `kiosk` | boolean | `false` | Same as `full_browser`. |
| `start_url` | URL, max 2048 | none | Navigate here before the session is returned. A URL that cannot be opened fails the create with 502. |
| `warm` | list of up to 3 URLs | none | Origins to pre-warm (DNS, TLS, cache) while your client is still connecting. |
| `warm_up` | boolean | `false` | Pre-warm the render path before returning. |
| `cdp_observe` | boolean | `true` | Watch each CDP or Playwright navigation for walls and challenges and hold the next command until the page settles (0.5 to 3 s per navigation). `false` skips it: faster test automation on your own apps, no automatic challenge solving on CDP-driven navigations. |

```bash
curl -X POST https://back.tilion.dev/v1/session \
  -H "Authorization: Bearer ph_live_..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-create-1" \
  -d '{}'
```

Response (201):

```json
{
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "state": "ready",
  "mode": "ephemeral",
  "region": null,
  "owner": "acme",
  "created_at": 1792420179.1767488,
  "last_active": 1792420179.1897585,
  "idle_timeout": 300.0,
  "ttl": 3600.0,
  "expires_at": 1792420479.1897585,
  "connect_url": "wss://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/cdp?token=<token>",
  "connect_expires_in": 1800.0,
  "playwright_url": "wss://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/playwright?token=<token>",
  "exit_id": null,
  "persona": "tenant-018658e41dd54701e9bf45c6",
  "full_browser": false,
  "geo_applied": null,
  "geo_unsupported": null
}
```

Response fields:

| Field | Type | Meaning |
|---|---|---|
| `session_id` | string | Use it in every session route. |
| `state` | string | `ready` is drivable. `remote` can appear briefly in the list while a session created elsewhere is being registered. Ended sessions report `closed` or `expired` in their terminal record. |
| `mode` | string | `ephemeral` or `persistent`. |
| `region` | string or null | The region you asked for; null when you let the API choose. |
| `owner` | string | Your account. |
| `created_at`, `last_active` | float | Unix seconds. `last_active` moves on every drive or CDP call. |
| `idle_timeout`, `ttl` | float | The values in force, after defaults and the plan cap. |
| `expires_at` | float | When the session ends if nothing else happens: the sooner of `last_active + idle_timeout` and `created_at + ttl`. |
| `connect_url` | string or null | Raw CDP endpoint with a 1800 second token. Only on create and `/connect`; null on reads. |
| `connect_expires_in` | number or null | Seconds the token in `connect_url` and `playwright_url` stays valid: 1800. |
| `playwright_url` | string or null | Native Playwright endpoint for `chromium.connect(...)`, same token. |
| `exit_id` | string or null | The exit the session started on, when one was chosen for it. Pass it as `exit_id` on a later create to reuse it. |
| `persona` | string or null | The device identity the session runs as (returned on the first create of a session; null on an idempotent replay and on reads). |
| `full_browser` | boolean | Whether the session has a visible desktop (VNC). |
| `geo_applied` | boolean or null | Null without `geo`; `true` when the exit was placed as asked; `false` when the exit provider refused the target and the session fell back to the country exit. |
| `geo_unsupported` | list or null | The `geo` fields that could not be honoured, for example `["city", "zip"]`. |

Errors:

| Status | `error` or message | When |
|---|---|---|
| 400 | `stealth_always_on` | `stealth: false`. |
| 400 | `stealth_max_needs_premium_egress` | `stealth: "max"` together with `residential: false`. |
| 401 | `Missing API key` or `Invalid API key` | No or bad bearer. |
| 402 | `insufficient_credits` (`required`, `balance`) | The wallet cannot cover the session charge plus one minute. |
| 402 | `quota_exceeded` (`reason`, `tier`) | The plan's monthly allowance is used up and the plan has no overage. |
| 402 | `residential_egress_paid` | `residential: true` on a plan without premium egress. |
| 409 | `region_unavailable` (`available`), `proxy_type_unavailable`, `idempotency_key_in_use` | No exit in that region; the exit type is not served now; a create with that key is still running. |
| 422 | validation list | Unknown `region`, `ttl` outside 5 to 43200, `idle_timeout` outside 1 to 3600, non-boolean `residential`, bad `geo`. |
| 422 | `ttl_exceeds_plan` (`max_ttl`) | `ttl` above the plan's maximum session length. |
| 429 | `concurrency_limit` (`limit`, `tier`) or a creates-per-minute throttle | Too many live sessions, or too many creates. |
| 502 | `session_launch_failed` | The browser could not start; retry. |
| 502 | `Data Plane start URL navigation failed` | `start_url` could not be opened; the session was released. |
| 503 | `capacity_unavailable` (`Retry-After: 5`) | No capacity in the region right now. |
| 503 | `residential_egress_unavailable`, `residential_vendor_unavailable` (`Retry-After: 60`), `full_browser_unavailable` | The requested exit type or the visible desktop cannot be provided; only the vendor case is worth a retry. |

Examples as returned:

```json
{"detail": [{"type": "value_error", "loc": ["body", "region"], "msg": "Value error, unknown region 'zz'; see GET /v1/regions", "input": "zz", "ctx": {"error": {}}}]}
{"detail": {"error": "stealth_always_on", "message": "sessions are stealth-hardened by construction; stealth cannot be disabled"}}
```

Notes: the browser is already running when the response arrives; the first drive call on a fresh session takes a few hundred milliseconds more than later ones. Release every session in a `finally` block; it bills by the minute until it ends.

## GET /v1/session/{session_id}

Read a session without touching its idle clock. `connect_url`, `connect_expires_in` and `playwright_url` are always null here; mint them with `/connect`.

```bash
curl https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4 \
  -H "Authorization: Bearer ph_live_..."
```

Response (200):

```json
{
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "state": "ready",
  "mode": "ephemeral",
  "region": null,
  "owner": "acme",
  "created_at": 1792420179.1767488,
  "last_active": 1792420197.5259109,
  "idle_timeout": 300.0,
  "ttl": 3600.0,
  "expires_at": 1792420497.5259109,
  "connect_url": null,
  "connect_expires_in": null,
  "playwright_url": null,
  "exit_id": null,
  "persona": null,
  "full_browser": false,
  "geo_applied": null,
  "geo_unsupported": null
}
```

Errors: 404 `No such session` for an id that never existed, is not yours, or whose record has aged out (about an hour after it ended); 410 with the terminal record while the ended session is still remembered; 410 `browser_crashed` (`retryable: false`) when the browser died, in which case the session is released for you.

## GET /v1/session/{session_id}/status

Lifecycle state of a session, live or ended, without extending its idle deadline. For a live session the body is the same as `GET /v1/session/{id}`. For an ended one it is the terminal record with status 200 rather than 410, which makes it the route to poll from a monitor.

Response for an ended session (200):

```json
{
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "owner": "acme",
  "state": "closed",
  "mode": "ephemeral",
  "region": null,
  "reason": "closed",
  "origin": "customer",
  "cause": null,
  "created_at": 1792420179.1767488,
  "last_active": 1792420909.7551606,
  "idle_timeout": 300.0,
  "ttl": 3600.0,
  "closed_at": 1792420909.7551966,
  "cleanup": "done",
  "cleaned_at": 1792420910.0134642,
  "cleanup_finished_at": 1792420910.0134647,
  "retained_until": 1792424509.7551966
}
```

Terminal record fields: `state` is `closed` or `expired`; `reason` is `closed`, `idle_expired`, `ttl_expired` or a service reason; `origin` is `customer`, `expired`, `data_plane` or `host` (who ended it); `cause` names the failure that ended it when the service did, else null; `cleanup` is `pending`, `done` or `failed`; `retained_until` is when the record disappears (one hour after close) and the id starts answering 404.

Errors: 404 `No such session`.

## GET /v1/sessions

Every live session on your account, across all regions. `connect_url` is null on every entry. In the list `last_active` is null and `expires_at` is the absolute `ttl` deadline; read one session for its idle deadline.

Response (200):

```json
[
  {
    "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
    "state": "ready",
    "mode": "ephemeral",
    "region": null,
    "owner": "acme",
    "created_at": 1792420179.1767488,
    "last_active": null,
    "idle_timeout": 300.0,
    "ttl": 3600.0,
    "expires_at": 1792423779.1767488,
    "connect_url": null,
    "connect_expires_in": null,
    "playwright_url": null,
    "exit_id": null,
    "persona": null,
    "full_browser": false,
    "geo_applied": null,
    "geo_unsupported": null
  }
]
```

An empty account answers `[]`. Use it to find sessions you forgot to release; an unexpected 429 `concurrency_limit` on create is almost always that.

## DELETE /v1/session/{session_id}

End the session and destroy its browser. 204 with no body once the session is removed from your account; the browser is torn down right after. The `Location` header points at `/status`, where the terminal record is readable for an hour.

```bash
curl -X DELETE https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4 \
  -H "Authorization: Bearer ph_live_..."
```

Response: `HTTP 204`, header `location: /v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/status`.

What the id answers afterwards:

- `GET /v1/session/{id}` answers 410 with the terminal record as `detail`.
- `GET /v1/session/{id}/status` answers 200 with the terminal record.
- `DELETE` again answers 204 (safe to repeat).
- `GET /v1/session/{id}/connect`, `POST .../view-token`, `POST .../navigate` and every other session route answer 410 with the same record.
- A CDP or Playwright connect with a token minted before the delete is refused at the handshake.

Errors: 404 `No such session` for an id that never existed or is not yours; 503 `session worker unavailable; retry cleanup` when the session's host could not be reached, in which case the browser is not confirmed gone and you should retry.

## GET /v1/regions

The region codes `POST /v1/session` accepts. The response header `X-Tillion-Region-Registry-Version` identifies the region table.

```json
[
  {"code": "us", "name": "United States", "country": "us", "timezone": "America/New_York"},
  {"code": "de", "name": "Germany", "country": "de", "timezone": "Europe/Berlin"},
  {"code": "sg", "name": "Singapore", "country": "sg", "timezone": "Asia/Singapore"}
]
```

The region decides the exit's country and the browser's timezone and locale. Only regions where a session can really be placed are listed.

## GET /v1/session/{session_id}/connect

Mint a fresh CDP connect URL and Playwright URL for a live session. Call it when the URLs from create have expired (1800 seconds) or when another process needs to attach.

```json
{
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "connect_url": "wss://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/cdp?token=<token>",
  "playwright_url": "wss://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/playwright?token=<token>",
  "expires_in": 1800.0,
  "protocol": "raw_cdp"
}
```

The expiry field is `expires_in` here and `connect_expires_in` on create. Errors: 403 when the key lacks the `sessions:write` (or `cdp`) scope; 404 and 410 as for GET; 409 `session browser not ready` right after a create that is still booting; 410 `browser_crashed`; 503 when connect URLs cannot be minted.

# 8. Driving a session over HTTP

These routes drive the session's current tab without a CDP client. They are serialised per session: a second call waits for the first. Each is one action (1 credit) and counts under the drive throttle. The tab they act on is the one the live view shows; `navigate` and `tabs` can name another tab.

Use one driver per session: while a CDP or Playwright client is attached, REST drive calls wait for the browser and can end with `status: "error"`, `error: "deadline"`. Disconnect the client first, or do everything from the client.

## POST /v1/session/{session_id}/navigate

Open a URL in a tab that stays open, so later `act`, `elements`, `screenshot` calls and the live view work on it. The page is checked for walls and challenges; when the landing is blocked or off target the API tries to recover inside this session before answering. Recovery here stays on the session's own exit; `POST /v1/fetch` is the route that may escalate to stronger exits, so use `fetch` for a protected page and `navigate` for an interactive flow on a page you can already reach.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | string, max 4096, required | | `http` or `https` only. Private, loopback and link-local addresses answer 400. |
| `tab_id` | string | newest tab | The tab to drive, from `GET /v1/session/{id}/tabs`. Unknown ids answer 404 `No such tab`. |
| `expect_url` | regular expression, max 512 | none | The landed URL must match it; otherwise the result is `redirected_off_target` with `error: "expect_url_mismatch"`. An invalid expression answers 422. Without it, a deep link that is sent back to its entry page is reported off target with `error: "collapsed_to_entry"`. |

`expect_text`, `no_results_url`, `wait_ms`, `settle_ms` and `wait_for_selector` belong to `POST /v1/fetch`; sent here they are ignored.

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/navigate \
  -H "Authorization: Bearer ph_live_..." -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/"}'
```

Response (200):

```json
{
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "final_url": "https://example.com/",
  "title": "Example Domain",
  "status": "ok",
  "http_status": 200,
  "error": null,
  "failure_type": null,
  "cause": null,
  "self_healed": false,
  "recovery": null,
  "detected": null,
  "held": null,
  "requested_url": "https://example.com/",
  "redirected": false
}
```

Response fields:

| Field | Type | Meaning |
|---|---|---|
| `final_url`, `title` | string | Where the tab is now, and its title (empty string or null when the page has none). |
| `status` | string | `ok`: the page you asked for is open. `redirected_off_target`: a page opened, but not the one asked for (`error` says why). `empty`: the origin answered 404 or 410 (`error` `not_found` or `gone`). `blocked`: a wall or challenge refused the page and recovery did not clear it. `error`: the navigation itself failed (`error` names it, for example `navigation_failed` or `deadline`). `no_results`: the site answered a search with no results and sent the visitor on. |
| `http_status` | integer or null | The origin's status for the main document. |
| `error` | string or null | A slug when `status` is not `ok`: `expect_url_mismatch`, `collapsed_to_entry` (with `redirected_off_target`); `not_found`, `gone` (with `empty`); `time_exhausted` (with `blocked`: recovery ran out of budget); `navigation_failed`, `deadline` (with `error`). |
| `failure_type`, `cause` | string or null | The failure class and what failed, when something did (for example `TimeoutError`, `page_unusable`, `observation_failed`). |
| `self_healed` | boolean | True when the page was blocked at first and cleared by recovery. |
| `recovery` | object or null | What was tried: `attempts`, `actions[]` with `action`, `result`, `reason`, `elapsed_ms`, and `ladder` with `outcome`, `attempts`, per-try `rung`, `result`, `elapsed_ms`, `reason`, and `budget` (`kind`, `total_s`, `elapsed_s`, `spent` by phase). Null when nothing needed recovering. |
| `detected` | object or null | The wall found on the first page: `family` (vendor), `category`, `mechanism`. Null on a healthy page. |
| `held` | object or null | Set when the origin served an error page with text that was not delivered: `http_status`, `text_chars`, `recovery`, `reason`. |
| `requested_url`, `redirected` | string, boolean | What you asked for, and whether the browser ended somewhere else. |

An off-target landing (`expect_url` did not match):

```json
{
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "final_url": "https://example.com/",
  "title": "Example Domain",
  "status": "redirected_off_target",
  "http_status": 200,
  "error": "expect_url_mismatch",
  "failure_type": null,
  "cause": null,
  "self_healed": false,
  "recovery": {
    "driver": "data_plane",
    "attempts": 0,
    "actions": [],
    "ladder": {
      "outcome": "exhausted",
      "attempts": 1,
      "rungs": [
        {"rung": "eip", "result": "still_bounced", "elapsed_ms": 5419},
        {"rung": "isp", "result": "unavailable", "elapsed_ms": 0, "reason": "navigate_keeps_the_callers_session"},
        {"rung": "residential", "result": "unavailable", "elapsed_ms": 0, "reason": "navigate_keeps_the_callers_session"}
      ],
      "exhausted_reason": "no_tier",
      "budget": {"kind": "sync", "total_s": 55.0, "elapsed_s": 5.6, "spent": {"heal": 0.15, "chain": 5.42}}
    }
  },
  "detected": null,
  "held": null,
  "requested_url": "https://example.com/",
  "redirected": false
}
```

The `isp` and `residential` rungs read `unavailable` with `navigate_keeps_the_callers_session`: a navigate never moves your session to another exit, because the tab, cookies and live view have to stay yours. `POST /v1/fetch` is the route that may climb to stronger exits.

A page the origin does not have (`recovery` trimmed):

```json
{
  "final_url": "https://example.com/this-page-does-not-exist",
  "title": null,
  "status": "empty",
  "http_status": 404,
  "error": "not_found",
  "cause": "page_unusable",
  "detected": {"family": "cloudflare", "category": "client_error", "mechanism": "client_error", "source": "data_plane"},
  "requested_url": "https://example.com/this-page-does-not-exist",
  "redirected": false
}
```

A redirect that collapsed to an entry page (`https://httpbin.org/cookies/set/sessionid/abc123` lands on `/cookies`): 200, `status: "redirected_off_target"`, `error: "collapsed_to_entry"`, `redirected: true`, `final_url: "https://httpbin.org/cookies"`. The page is open and usable (the cookie was set); the status tells you the URL moved.

Errors:

| Status | Body | When |
|---|---|---|
| 400 | `unsafe url: host '...' resolves to non-public address ...` | Private, loopback or link-local target; also `unsafe url: host 'localhost' is blocked`. |
| 402 | `insufficient_credits`, `quota_exceeded` | Out of credits or allowance. |
| 404 | `No such tab` | Unknown `tab_id`. |
| 404 / 410 | session answers | Unknown or ended session. |
| 409 | `session not ready (state=...)` | The browser is still booting or closing. |
| 422 | validation list | Missing `url`, `url` over 4096, invalid `expect_url` (`expect_url is not a valid regular expression: ...`). |
| 429 | drive throttle | Over the drive calls per minute limit. |
| 502 | `Data Plane tab read failed` | The tab list could not be read while checking `tab_id`. |

Notes: a plain page answers in about half a second. A navigation that needs recovery runs up to 55 seconds (`budget.total_s`) and then answers `status: "error"`, `error: "deadline"`, `failure_type: "TimeoutError"`.

## POST /v1/session/{session_id}/act

A human-style input on the current page: click, type, fill, press a key, scroll, set the clipboard, or wait for an element. Use `POST .../elements` first to get a selector that resolves to one element.

Request:

| Field | Type | Meaning |
|---|---|---|
| `action` | `click`, `type`, `fill`, `press`, `scroll`, `set_clipboard`, `wait_for` (required) | What to do. Anything else answers 422. |
| `selector` | CSS selector, max 2048 | The target for `click`, `fill`, `type` (optional for `type`), `wait_for`. |
| `by_text` | string, max 512 | `click` the clickable element whose visible text matches (buttons, links, inputs). |
| `text` | string, max 20000 | The value for `fill`, `type` and `set_clipboard`. Never logged or echoed. |
| `secret` | boolean | On `fill`: the value is a password, token or one-time code. A password input is treated this way without the flag. |
| `key` | string, max 64 | For `press`: `Enter`, `Tab`, `Escape`, `ArrowDown`, `Control+V`, and so on. |
| `dy` | integer, -200000 to 200000 | For `scroll`: pixels down (negative scrolls up). Default 800. |

`fill` replaces the field's value; `type` types into the selector, or into the focused element when no selector is given. `wait_for` waits for the selector to appear (about 10 seconds, then 404). `set_clipboard` puts text on the session's clipboard so a person on the live view can paste it.

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/act \
  -H "Authorization: Bearer ph_live_..." -H "Content-Type: application/json" \
  -d '{"action": "fill", "selector": "input[name=custname]", "text": "Ada Lovelace"}'
```

Response (200):

```json
{"ok": true, "action": "fill", "error": null}
```

Other actions:

| Request body | Response |
|---|---|
| `{"action": "fill", "selector": "input[name=custtel]", "text": "555-0100", "secret": true}` | `{"ok": true, "action": "fill", "error": null}` |
| `{"action": "type", "selector": "input[name=custemail]", "text": "ada@example.com"}` | `{"ok": true, "action": "type", "error": null}` |
| `{"action": "press", "key": "Tab"}` | `{"ok": true, "action": "press", "error": null}` |
| `{"action": "scroll", "dy": 300}` | `{"ok": true, "action": "scroll", "error": null}` |
| `{"action": "set_clipboard", "text": "paste me"}` | `{"ok": true, "action": "set_clipboard", "error": null}` |
| `{"action": "wait_for", "selector": "textarea[name=comments]"}` | `{"ok": true, "action": "wait_for", "error": null}` |

Response fields: `ok` (boolean), `action` (echo), `error` (null, or a slug when `ok` is false with status 200, for example `incomplete_observation` when the page could not be observed after the action).

Errors (the session stays alive on all of them):

| Status | `error` | When |
|---|---|---|
| 400 | `click_requires_selector_or_by_text` | `click` with neither. |
| 400 | `fill_requires_selector`, `press_requires_key`, `wait_for_requires_selector` | Missing argument. |
| 400 | `clipboard_write_unavailable` | The page does not allow clipboard writes (a browser error page, a page without a secure origin). |
| 404 | `element_not_found` | The selector matched nothing (also `wait_for` after its wait). |
| 404 | `no_clickable_element_matching_text` | `by_text` matched no clickable element. Labels are not clickable targets. |
| 409 | `no_page_loaded` | No page has been opened in the session yet. |
| 422 | validation list | Unknown `action`, `text` over 20000, `dy` out of range. |

As returned:

```json
{"detail": {"ok": false, "action": "click", "error": "element_not_found"}}
{"detail": {"ok": false, "action": "click", "error": "click_requires_selector_or_by_text"}}
{"detail": {"ok": false, "action": "fill", "error": "fill_requires_selector"}}
{"detail": [{"type": "literal_error", "loc": ["body", "action"], "msg": "Input should be 'click', 'type', 'fill', 'press', 'scroll', 'set_clipboard' or 'wait_for'", "input": "hover", "ctx": {"expected": "'click', 'type', 'fill', 'press', 'scroll', 'set_clipboard' or 'wait_for'"}}]}
```

Notes: after an action the page is given up to 3 seconds to settle before the response, so the next `elements`, `screenshot` or `fetch` sees the result of the action. The first action after a navigate can take longer while the page is observed; later actions on the same page are sub-second. One action per call, 1 credit each.

## POST /v1/session/{session_id}/elements

List the actionable elements on the current tab, each with a selector that resolves back to that one element. This is the discovery step before `act`. Input values are never returned, only their length.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `selector` | CSS selector, max 2048 | interactive elements | Restrict to elements matching it (`input`, `form a`, `#login button`). |
| `text` | string, max 512 | none | Keep elements whose accessible name contains it. |
| `visible_only` | boolean | `true` | Skip hidden elements. |
| `limit` | integer, 1 to 300 | 60 | Rows to return. `matched` tells you how many passed the filters. |

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/elements \
  -H "Authorization: Bearer ph_live_..." -H "Content-Type: application/json" \
  -d '{"limit": 8}'
```

Response on a form page (200; long selectors shortened):

```json
{
  "ok": true,
  "count": 8,
  "matched": 13,
  "elements": [
    {"selector": "html>body:nth-child(2)>form:nth-child(1)>p:nth-child(1)>label:nth-child(1)>input:nth-child(1)", "tag": "input", "input_name": "custname"},
    {"selector": "html>body:nth-child(2)>form:nth-child(1)>p:nth-child(2)>label:nth-child(1)>input:nth-child(1)", "tag": "input", "type": "tel", "input_name": "custtel"},
    {"selector": "html>body:nth-child(2)>form:nth-child(1)>p:nth-child(3)>label:nth-child(1)>input:nth-child(1)", "tag": "input", "type": "email", "input_name": "custemail"},
    {"selector": "...fieldset:nth-child(4)>p:nth-child(2)>label:nth-child(1)>input:nth-child(1)", "tag": "input", "type": "radio", "input_name": "size", "value_len": 5},
    {"selector": "...fieldset:nth-child(5)>p:nth-child(2)>label:nth-child(1)>input:nth-child(1)", "tag": "input", "type": "checkbox", "input_name": "topping", "value_len": 5}
  ],
  "truncated": true
}
```

On `https://example.com/` with an empty body:

```json
{"ok": true, "count": 1, "matched": 1, "elements": [{"selector": "html>body:nth-child(2)>a:nth-child(9)", "tag": "a", "name": "Learn more", "href": "https://iana.org/help/example-domains"}], "truncated": false}
```

Response fields: `ok`; `count` (rows returned); `matched` (rows that passed the filters); `elements[]` with `selector`, `tag`, and when present `name` (accessible name), `href`, `type`, `input_name`, `value_len`; `truncated` (true when `matched` exceeds `count`: narrow with `selector` or `text` rather than raising `limit`). A selector that matches nothing answers 200 with `count: 0`.

Errors: 400 `bad_selector` for a selector the browser cannot parse; 404 `element_not_found`; 409 `session has no open tab`; 502 `Data Plane element read failed` when the page could not be read. 1 credit per call.

## POST /v1/session/{session_id}/screenshot

Capture the current tab as an image, base64 in JSON.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `full_page` | boolean | `false` | Whole scrollable page instead of the viewport. |
| `format` | `jpeg` or `png` | `jpeg` | JPEG is far smaller. |
| `quality` | integer, 1 to 100 | 70 | JPEG quality. |
| `selector` | CSS selector, max 2048 | none | Clip the capture to one element. |

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/screenshot \
  -H "Authorization: Bearer ph_live_..." -H "Content-Type: application/json" \
  -d '{"format": "jpeg", "quality": 60}'
```

Response (200; the image is cut here):

```json
{
  "ok": true,
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "format": "jpeg",
  "full_page": false,
  "image_base64": "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAA...",
  "data_url": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyU...",
  "size_b64": 53612
}
```

Response fields: `ok`, `session_id`, `format`, `full_page`, `image_base64` (the image), `data_url` (the same with a `data:` prefix, ready for an `<img>` or a vision model), `size_b64` (characters of base64; the PNG or JPEG is about three quarters of that in bytes).

Errors: 400 `bad_selector` (`detail: "screenshot element unavailable"`) when the element cannot be captured; treat an element clip as best effort and fall back to the viewport; 404 `element_not_found` for a selector that matches nothing; 502 `Data Plane screenshot failed`. Billing: 1 action plus the base64 size in MB as egress.

## GET /v1/session/{session_id}/tabs

Every open tab, oldest first. Free; counts under the drive throttle.

```json
{
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "count": 1,
  "max": 15,
  "tabs": [
    {"tab_id": "AA1E0E90A01706F37CFCB865E1432EFB", "index": 0, "url": "https://example.com/", "title": "Example Domain"}
  ]
}
```

`max` is the per-session tab limit (15). `index` is the position in this list; `tab_id` is what `navigate` and `DELETE .../tabs/{tab_id}` take.

## POST /v1/session/{session_id}/tabs

Open a tab, optionally at a URL, and return it. 201 on success.

Request: `url` (optional, max 4096, http(s), same address rules as navigate).

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/tabs \
  -H "Authorization: Bearer ph_live_..." -H "Content-Type: application/json" \
  -d '{"url": "https://example.org/"}'
```

Response (201):

```json
{"tab_id": "21FEA677628AF1C2FFD0F465AEA076C5", "index": 1, "url": "https://example.org/", "title": "Example Domain"}
```

With an empty body: `{"tab_id": "84C437990B422ACB5A9893AB52832AB5", "index": 2, "url": "about:blank", "title": ""}`.

A navigate aimed at the new tab, `{"url": "https://example.com/", "tab_id": "21FEA677628AF1C2FFD0F465AEA076C5"}`, drives that tab and leaves the first where it was.

Errors: 400 for a blocked `url`; 429 `tab_limit` (`limit: 15`) at the cap; 502 `tab_navigation_failed` (`message`) when the URL could not be opened, in which case the tab is closed again and nothing is charged; 502 `Data Plane tab creation failed`. Each tab is a real renderer in a fixed-size browser, which is why the cap exists. 1 credit per tab opened.

## DELETE /v1/session/{session_id}/tabs/{tab_id}

Close one tab. 204 with no body.

Errors: 404 `No such tab` for an unknown or already closed id; 409 `last_tab` when it is the only tab, because a session with no tab cannot be driven; delete the session instead.

## GET /v1/session/{session_id}/context

Export the current tab's auth state (cookies, localStorage, sessionStorage) as JSON you store yourself. Hand it back with `POST .../context` on a later session to skip a login.

Response after visiting `https://httpbin.org/cookies/set/sessionid/abc123` (200):

```json
{
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "context": {
    "url": "https://httpbin.org/cookies",
    "cookies": [
      {"name": "sessionid", "value": "abc123", "path": "/", "secure": false, "httpOnly": false, "url": "http://httpbin.org/", "sourcePort": 443, "sourceScheme": "Secure", "priority": "Medium"}
    ],
    "localStorage": {},
    "sessionStorage": {}
  },
  "cookies": 1
}
```

The blob contains real cookie values: store it encrypted. Errors: 409 `no_tab` when the session has no open page; 502 `Data Plane context read failed`.

## POST /v1/session/{session_id}/context

Restore an exported context into a live session, then optionally navigate. Cookies are applied before the navigation, so the very first request is already authenticated.

Request:

| Field | Type | Meaning |
|---|---|---|
| `context` | object | The `context` object from GET, or a subset (`{"cookies": [...]}` is the common case). |
| `url` | string, max 4096 | Navigate here after restoring. When omitted, `context.url` names the origin the state belongs to; one of the two is required. |

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/context \
  -H "Authorization: Bearer ph_live_..." -H "Content-Type: application/json" \
  -d '{"context": {"cookies": [{"name": "sessionid", "value": "abc123", "path": "/", "url": "http://httpbin.org/"}]}, "url": "https://httpbin.org/cookies"}'
```

Response (200):

```json
{"session_id": "sess_3d245e56b86d4bc8ae32095b644117d4", "applied": {"cookies": 1, "localStorage": 0, "sessionStorage": 0}, "final_url": "https://httpbin.org/cookies"}
```

`applied` counts what really landed, so a zero tells you the origin refused the state rather than reporting success. Errors: 400 `context requires an HTTP(S) origin` when neither `url` nor `context.url` is an http(s) URL; 502 when the navigation failed, with the reason as the body. A restore with `url` is one action (1 credit); without it the call is free.

## POST /v1/session/{session_id}/files/fetch

Download a file through the session's browser and return its bytes. The request is made by the page itself, with the session's cookies and TLS identity, so files behind a login work.

Request: `url` (required, max 4096); `max_bytes` (optional, at least 1) to accept less than the 32 MiB cap.

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/files/fetch \
  -H "Authorization: Bearer ph_live_..." -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/"}'
```

Response (200; base64 cut):

```json
{
  "session_id": "sess_3d245e56b86d4bc8ae32095b644117d4",
  "filename": "download",
  "content_type": "text/html; charset=utf-8",
  "size": 577,
  "final_url": "https://example.com/",
  "content_base64": "PCFkb2N0eXBlIGh0bWw+PGh0bWwgbGFuZz1lbj48aGVhZD48bWV0YSBjaGFyc2V0PXV0Zi04PjxsaW5rIHJlbD1pY29uIGhy..."
}
```

`filename` comes from the final URL's last path segment (`download` when there is none), `size` is the byte count, `content_base64` the file.

Errors:

| Status | `error` | When |
|---|---|---|
| 413 | `too_large` (`size`, `limit`) | Over `max_bytes` or the 32 MiB cap: `{"detail": {"error": "too_large", "status": null, "network_error": null, "size": 101, "limit": 100}}` for `max_bytes: 100`. |
| 404 and other 4xx | `http_404` and so on (`status`) | The origin's own 4xx is passed through: `{"detail": {"error": "http_404", "status": 404, "network_error": null, "size": null, "limit": 33554432}}`. |
| 400 | `file_fetch_blocked`, or `unsafe url: ...` | The download was refused, or the target is a private address. |
| 409 | `unsupported_subresource_challenge` | A challenge stands in front of the file. |
| 504 | `file_fetch_timeout` (`retryable: true`) | The browser request exceeded its deadline; try a smaller file. |
| 502 | `file_fetch_failed` (`cause`, `message`, `retryable: true`) | Anything else. |

Billing: 1 action plus the file size in MB as egress.

## POST /v1/session/{session_id}/rotate-ip

Move the session to a fresh exit IP without changing the browser, cookies or tabs. Sessions keep one exit by default; call this when a site starts refusing, or between logical tasks. No body.

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/rotate-ip \
  -H "Authorization: Bearer ph_live_..."
```

Response (200):

```json
{"session_id": "sess_3d245e56b86d4bc8ae32095b644117d4", "rotated": true, "region": "us-east-1", "fresh_allocation": false}
```

`region` is where the new exit sits. `fresh_allocation` is true when a brand-new address was allocated for the session, false when it moved to another address from the pool. On a residential session the session gets a new residential exit and `fresh_allocation` is true.

Errors: 409 with a reason slug when no rotation is possible right now (`ip_rotation_unavailable`, `exit_ladder_exhausted`, `residential_rotation_unavailable`); 402 and 429 like every drive call. Expect 5 to 6 seconds; a CDP client stays connected across the rotation. 1 credit.

# 9. Saved logins

Log in once, save the site's cookies under your account, and every later session of yours starts already logged in on that site. Cookie values are encrypted at rest and never returned by the API; `GET /v1/auth` lists domains only. Logins are scoped to the registrable domain (`linkedin.com`, not `www.linkedin.com`).

## POST /v1/session/{session_id}/save-auth

Save the session's cookies for one site. The session's current page must be on that site.

Request: `domain` (for example `httpbin.org`) or `url` (a URL on the site); one of them is required.

```bash
curl -X POST https://back.tilion.dev/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/save-auth \
  -H "Authorization: Bearer ph_live_..." -H "Content-Type: application/json" \
  -d '{"domain": "httpbin.org"}'
```

Response (200):

```json
{"ok": true, "domain": "httpbin.org", "cookies_saved": 1, "entry_id": "ea8e02bf7c7e4677b3f65445e7db133e"}
```

Errors: 400 `domain (or url) is required`; 400 `auth domain does not match current page` when the session is on another site; 400 `no scoped auth cookies to save` when the page set no cookies for that domain; 502 `Data Plane auth save failed`.

## GET /v1/auth

The sites your account has saved logins for.

```json
{"connected": [{"domain": "httpbin.org", "updated_at": "2026-10-19T14:39:02.324765+00:00"}]}
```

With nothing saved: `{"connected": []}`.

## POST /v1/auth/import

Bring your own cookies: paste a session cookie from a browser where you are already logged in, and your sessions start authenticated on that site.

Request:

| Field | Type | Meaning |
|---|---|---|
| `domain` | string, required | The site. |
| `cookies` | list of up to 100 `{name, value, domain?, path?, expires?, httpOnly?, secure?, sameSite?}` | Full cookie objects. `domain` defaults to `.` plus the registrable domain, `path` to `/`. |
| `token` | string | Shorthand for one session cookie instead of `cookies`. |
| `cookie_name` | string | Name for `token` (default `li_at`). |

```bash
curl -X POST https://back.tilion.dev/v1/auth/import \
  -H "Authorization: Bearer ph_live_..." -H "Content-Type: application/json" \
  -d '{"domain": "example.net", "cookies": [{"name": "session", "value": "s3cret", "domain": ".example.net", "path": "/", "httpOnly": true, "secure": true}]}'
```

Response (200): `{"ok": true, "domain": "example.net", "cookies_saved": 1}`. The shorthand `{"domain": "example.org", "token": "abc123", "cookie_name": "sid"}` answers `{"ok": true, "domain": "example.org", "cookies_saved": 1}`.

Errors: 400 `domain is required`; 400 `provide cookies:[...] or token:'<value>'`; 400 `incomplete_cookie_set` (`have`, `need`) for a LinkedIn import with `li_at` but no `JSESSIONID`; 400 `too many cookies (max 100)`; 400 `no usable cookies in the request`. A 200 with `ok: false` and `cookies_saved: 0` means none of the cookies belonged to that domain.

```json
{"detail": {"error": "incomplete_cookie_set", "message": "LinkedIn needs BOTH li_at and JSESSIONID (the CSRF token must match JSESSIONID). ...", "have": ["li_at"], "need": ["li_at", "JSESSIONID"]}}
```

## DELETE /v1/auth/{domain}

Forget a saved login everywhere, including any copy that automatic unblocking could have reused.

Response (200): `{"ok": true, "domain": "httpbin.org", "data_plane_grants_retired": 1}`. The last field, present only when it is non-zero, counts stored grants that were retired as well. A second delete answers 404 `no saved login for httpbin.org`.

# 10. Playwright and raw CDP

Every session is a Chrome you can attach to with any Chrome DevTools Protocol client: Playwright, Puppeteer, chromedp, or a raw WebSocket. Attaching gives you the whole browser (every tab, every cookie, script evaluation), which is why it is a token-scoped URL rather than the API key.

When to use it: your own applications, test automation, or unprotected sites where you want the full Playwright API. When not to use it: reading protected pages. A `page.goto()` over CDP does not get wall detection, CAPTCHA solving or exit escalation; `POST /v1/fetch` does. For stealth reads, call `fetch` on the session and, if you need to, attach over CDP afterwards to work with the page it opened.

## The URLs and the token

`POST /v1/session` returns two URLs; `GET /v1/session/{id}/connect` mints fresh ones for a live session.

- `connect_url`: `wss://back.tilion.dev/v1/session/{id}/cdp?token=...`, a browser-level CDP endpoint on port 443. For `connectOverCDP`, Puppeteer `browserWSEndpoint`, chromedp, or your own socket.
- `playwright_url`: `wss://back.tilion.dev/v1/session/{id}/playwright?token=...`, a native Playwright server endpoint for `chromium.connect(...)`.

The token is the same in both, is bound to this one session and your account, and lasts `connect_expires_in` seconds (1800). It is not single use. A bad or expired token is refused at the WebSocket handshake with HTTP 403 and the body `{"detail": {"error": "invalid_token", "message": "missing, expired or invalid token for this session; mint a new one"}}`; a handshake for an ended session is refused the same way with the session's 410 or 404 answer. Mint a new URL with `/connect` whenever a process might have waited more than half an hour.

How long the browser lives is the session's business, not the token's: `idle_timeout` (300 s by default) measured from the last drive or CDP activity, and `ttl` (3600 s by default, 43200 s at most). Playwright activity resets the idle clock. `browser.close()` in a CDP client only disconnects that client; the session keeps running and billing until `DELETE /v1/session/{id}` or its deadline.

One client at a time. A second CDP socket while one is attached is accepted and closed at once with code 4409 and reason `another client is attached to this session`; the same code is used when a native Playwright connect finds the browser busy. REST drive calls on a session with an attached client wait for the browser. Disconnect the client, then drive over REST, or do everything from the client.

## Python: connect_over_cdp

```python
import os, requests
from playwright.sync_api import sync_playwright

KEY = os.environ["TILION_API_KEY"]
H = {"Authorization": f"Bearer {KEY}"}
s = requests.post("https://back.tilion.dev/v1/session", json={}, headers=H).json()
sid, connect_url = s["session_id"], s["connect_url"]     # connect_expires_in: 1800

try:
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(connect_url, timeout=60000)
        context = browser.contexts[0]                      # the session's own context: its cookies, storage, saved logins
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://example.com/", wait_until="domcontentloaded")
        print(page.title())                                # Example Domain
        browser.close()                                    # disconnects this client only
finally:
    requests.delete(f"https://back.tilion.dev/v1/session/{sid}", headers=H)
```

Default context or a new one. A fresh session has exactly one context with one page. `browser.contexts[0]` is the session: the cookies `/save-auth` and `/context` work with, the persona, the exit, the page the live view shows. `browser.new_context()` gives a second context with an empty cookie jar and storage, isolated from the first but in the same browser and on the same exit; it costs a renderer. Use the default context unless you need isolation inside one session.

## Python: native Playwright connect

`playwright_url` is a Playwright server endpoint, so `chromium.connect` works too. It reports no existing context (`contexts=0`), so create one; it lives in the same browser.

```python
browser = p.chromium.connect(playwright_url, timeout=60000)
context = browser.contexts[0] if browser.contexts else browser.new_context()
page = context.pages[0] if context.pages else context.new_page()
page.goto("https://example.com/", wait_until="domcontentloaded")
```

The native endpoint matches a gateway to your client's Playwright version; a version it does not have is refused with close code 1008 and a reason naming the supported range.

## Node: connectOverCDP

With `playwright-core` (no local browser needed):

```js
const { chromium } = require('playwright-core');

(async () => {
  const connectUrl = process.env.TILION_CONNECT_URL;          // from POST /v1/session or GET /v1/session/{id}/connect
  const browser = await chromium.connectOverCDP(connectUrl, { timeout: 60000 });
  const context = browser.contexts()[0];                       // the session's own context
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });
  console.log(await page.title());                             // Example Domain
  await browser.close();                                       // the session stays alive
})();
```

## Raw CDP for other clients

`connect_url` is an ordinary CDP browser endpoint. One frame in, one out:

```json
{"id": 1, "method": "Browser.getVersion"}
{"id":1,"result":{"protocolVersion":"1.3","product":"Chrome/153.0.8010.36","revision":"@507c6ee3e2f3b2ca0e660547e5b9ea4820c67f4c","userAgent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36","jsVersion":"15.3.76.10"}}
```

Puppeteer attaches with `puppeteer.connect({ browserWSEndpoint: connectUrl })` and chromedp with the URL as the remote allocator. Two things the socket enforces: a `Page.navigate` or `Target.createTarget` to a private, loopback or link-local address is refused (the command gets an error reply), and a vanilla client's `Runtime.enable` is an automation tell; if that matters for your target, use a stealth-configured client or drive the session over REST. CDP traffic is billed as the session's egress.

Troubleshooting:

- `connect_url` is null on create: raw CDP is not enabled for your key. Retrying will not change it.
- Handshake refused with HTTP 403 `invalid_token`: the token expired (1800 s) or belongs to another session. Mint one with `/connect`.
- Handshake refused with HTTP 410 or 404: the session ended or never existed. Create a new one.
- Socket accepted then closed with 4409: another client holds the session.
- Socket closed with 4410 `the session's browser crashed`: create a new session.
- Socket closed with 1011: the session has no live browser.
- `page.goto()` lands on a challenge or block page: that is expected over raw CDP. Read the page with `POST /v1/fetch` instead, or call `POST /v1/solve` on the session.

# 11. Live view and VNC

Every session can be watched, and driven, in a browser. Mint a short-lived view token, then open the viewer page or one of the streams with it. The token is bound to one session and your account, so it is safe to hand to a front end; the API key never appears in a URL.

## POST /v1/session/{session_id}/view-token

Response (200):

```json
{"token": "<token>", "expires_in": 1800, "live_view_url": "/v1/session/sess_3d245e56b86d4bc8ae32095b644117d4/live-view?token=<token>"}
```

The token lasts 1800 seconds and is reusable until then. `live_view_url` is a path: prefix `https://back.tilion.dev`. The same token opens the WebSocket streams: `wss://back.tilion.dev/v1/session/{id}/live?token=<token>` and `wss://back.tilion.dev/v1/session/{id}/webrtc?token=<token>`. Errors: 404 or 410 for an unknown or ended session; 503 `view tokens are not available on this deployment`.

## GET /v1/session/{session_id}/live-view

A ready-made interactive viewer page (`text/html`). Auth: `?token=` from `/view-token` (no Bearer). Without a token: 401 `missing view token; mint one with POST /v1/session/{id}/view-token`. With a bad token: 403 `invalid or expired view token`. Those two answers come before any session lookup, so the status never reveals whether an id exists; an ended session with a valid token answers 410.

## WS /v1/session/{session_id}/live

JPEG screencast of the page, interactive. URL: `wss://back.tilion.dev/v1/session/{session_id}/live?token=<token>` with the token from `/view-token`. The stream is a viewer: it does not hold the browser, so REST drive calls and `fetch` proceed normally while it is attached.

What a client receives: text frames, each one base64 of a JPEG of the current page at the viewport size, delivered continuously at about 2 frames per second; consecutive frames can be byte-identical on a static page, so de-duplicate client side if you are storing them. Frames carry no timestamp; stamp them on receipt. The stream ends when the session ends.

What a client sends, as JSON text frames:

- `{"t": "a"}` after rendering a frame. Once you have sent one ack, frames are paced to your acks, so a slow viewer gets the newest frame instead of a growing backlog. A client that never acks gets every frame.
- Mouse: `{"t": "m", "type": "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel", "x": 120, "y": 80, "button": "left", "clickCount": 1, "dx": 0, "dy": 120}` (page coordinates; `button` and `clickCount` for press and release; `dx`, `dy` for wheel).
- Keyboard: `{"t": "k", "type": "keyDown" | "keyUp" | "char", "key": "a", "code": "KeyA", "text": "a", "keyCode": 65}`.

Input lands on the tab you are watching as real user input. A viewer on a read-only link gets frames and its input is ignored. A bad token is refused at the handshake with HTTP 403 and `{"detail": {"error": "invalid_token", "message": "missing, expired or invalid token for this session; mint a new one"}}`; an ended session is refused with its 410. The bytes streamed are billed as egress.

## WS /v1/session/{session_id}/webrtc

A smooth video of the session over WebRTC, for viewers that can take it; the JPEG `/live` socket is the fallback. Auth: `?token=`. The first message after the handshake:

```json
{"type": "ice", "iceServers": [{"urls": "stun:stun.l.google.com:19302"}, {"urls": ["turn:turn.tilion.dev:3478?transport=udp", "turn:turn.tilion.dev:3478?transport=tcp", "turns:turn.tilion.dev:443?transport=tcp"], "username": "...", "credential": "..."}], "relayOnly": false}
```

Build an `RTCPeerConnection` with those `iceServers` (the TURN credential is short-lived and minted per connection), send `{"type": "offer", "sdp": "..."}` and receive `{"type": "answer", "sdp": "..."}`; the video track then flows peer to peer, and input rides this socket with the same `{"t": "m" ...}` and `{"t": "k" ...}` events as `/live`. When HD streaming is not available for this session right now the socket closes with code 1013 right after the handshake: keep the `/live` view you already have. Video bytes are billed as egress.

## POST /v1/session/{session_id}/vnc-token

For a `full_browser: true` session: a token and URL to watch and drive the whole Chrome window (noVNC), not just the page.

Response (200):

```json
{
  "token": "<token>",
  "expires_in": 1800,
  "vnc_view_url": "/v1/session/sess_3d245e2a0c1c499c9955f185b6acf251/vnc/vnc_lite.html?token=<token>&path=v1%2Fsession%2Fsess_3d245e2a0c1c499c9955f185b6acf251%2Fvnc-ws%3Ftoken%3D<token>&scale=true&reconnect=true"
}
```

Open `https://back.tilion.dev` plus `vnc_view_url` in a browser or an iframe; it loads the viewer and connects it to the window. Errors: 404 `full-browser (noVNC) view is not enabled on this deployment`; 404 or 410 for the session; 503 when the token cannot be minted.

## GET /v1/session/{session_id}/vnc/{path}

The noVNC viewer and its assets, served for one session. Auth: `?token=` from `/vnc-token` on the first load, which also sets a cookie scoped to this path so the viewer's own module imports work; without either, 403 `invalid or missing view token`. Directories are not listed. Assets are billed as egress.

## WS /v1/session/{session_id}/vnc-ws

The VNC transport the viewer uses; binary frames (RFB). Auth: `?token=` from `/vnc-token`. A connected viewer holds the browser the way a CDP client does, so REST drive calls wait while someone is driving the window. Bytes are billed as egress.

# 12. Fetch and jobs

The routes in this and the following sections turn a URL into content: a rendered page as text (`/v1/fetch`), as clean markdown with optional plain text, links and metadata (`/v1/extract`), a one-shot page or site read with no session to manage (`/v1/scrape`, `/v1/crawl`), search-engine results as JSON (`/v1/search`), a network capture of what a page loads (`/v1/inspect`), and a way to clear a challenge that is blocking a page (`/v1/solve`). Long reads run as jobs and are polled on `GET /v1/job/{job_id}`.

## POST /v1/fetch

Load a page in the session's browser and return its text. Use it when you want the page as a person sees it, with blocks and challenges handled for you; use `/v1/extract` instead when the content is headed for a model.

This is the stealth read path. Prefer it over `page.goto()` on a raw CDP or Playwright connection whenever the target may be protected: only `fetch` (and `extract`) detect walls, solve challenges and escalate across exit tiers.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | string | required | A ready session you own. |
| `url` | string | required | Public http or https URL, up to 4096 characters. Private and loopback addresses are refused. |
| `expect_url` | string (regular expression) | null | The URL the delivered page must land on. A page that lands elsewhere is reported as `redirected_off_target` with `error: "expect_url_mismatch"`, and recovery keeps trying. |
| `expect_text` | string (regular expression) | null | Text the delivered page must contain (a price, a heading). A page without it is not accepted and recovery moves on. |
| `no_results_url` | string (regular expression) | null | A landing URL that means the site answered "no results". Such a page is delivered as is with `status: "no_results"` and recovery stops. |
| `warm_entry` | boolean | false | Open the site's entry pages first, then the URL with the last of them as referrer. Costs those extra page loads. |
| `visitor` | boolean | false | Leave human-like input on each page opened (pointer movement, scrolls, dwell). About 3 seconds per page. |
| `render` | boolean | true | Accepted for compatibility. Pages are always rendered. |
| `include_html` | boolean | false | Also return the rendered DOM in `html`. |
| `async_mode` | boolean | false | Return at once with `status: "pending"` and a `job_id`; poll `GET /v1/job/{job_id}`. |
| `on_deadline` | `"error"` or `"continue"` | `"error"` | What happens when the page has not been delivered at the response limit (55 seconds). `error` answers 504 and stops the work. `continue` answers 202 with the job to poll and keeps working for up to 900 seconds. |
| `wait_ms` | integer, 0 to 60000 | 15000 | Ceiling in milliseconds for the readiness waits (DOM settle, selector, navigation). Not a delay: the page is read as soon as it is ready. |
| `settle_ms` | integer, 0 to 30000 | null | Read the page once the DOM has stopped changing for this long. Bounded by `wait_ms`. |
| `wait_for_selector` | string, up to 256 characters | null | CSS selector to wait for, bounded by `wait_ms`. The page is read either way; `selector_found` says whether it appeared. |

A plain request:

```json
{"session_id": "sess_6ac4459ad3e24b8289fc20911d76374f", "url": "https://en.wikipedia.org/wiki/Web_scraping"}
```

Response:

| Field | Type | Meaning |
|---|---|---|
| `session_id` | string | The session that served the page. |
| `status` | string | `ok` (text delivered), `empty` (a document with no readable text, or the origin's own 404 or 410), `blocked` (a challenge or refusal that recovery could not clear), `error` (the request itself failed), `pending` (an async job, or a `continue` fetch handed over at the limit), `no_results` (the site's own "nothing found" page, delivered), `redirected_off_target` (landed on a shallower page or one that fails `expect_url`; text withheld). |
| `content_ok` | boolean | True only when a real document with text came back on a 2xx. Trust this over `status`. |
| `final_url` | string | Where the navigation landed. |
| `requested_url` | string | What you asked for. |
| `redirected` | boolean | The landed host or path differs from the one asked for. A query string change or a `www` prefix does not count. |
| `http_status` | integer or null | Status of the main document. |
| `title` | string or null | Page title. |
| `text` | string | The page text. Empty when the page was not delivered; failure messages never land here. |
| `html` | string or null | The rendered DOM, only with `include_html: true`. |
| `html_len` | integer | Size of the rendered DOM in bytes, always present. |
| `captcha` | string | `none`, or the challenge family seen. |
| `self_healed` | boolean | A block was detected and cleared before delivery. |
| `recovery` | object or null | What was tried when the page did not come straight through. See below. |
| `held` | object or null | The origin served a page with an error status (a 403 with text) and it was not delivered: `{http_status, had_text, text_chars, recovery: "tried" or "not_possible", reason}`. |
| `detected` | object or null | What was found wrong with the first page: `{family, category, mechanism, source}`. Null for a healthy page. |
| `error` | string or null | Why the fetch did not deliver, as a slug (`time_exhausted`, `not_found`, `deadline`, `expect_url_mismatch`, ...). Null on `ok`. |
| `failure_type` | string or null | What failed when the request itself broke (`TimeoutError`, ...). |
| `cause` | string or null | A closing cause code (`wait_exhausted`, ...). |
| `reason`, `origin` | string or null | Set on a job cancelled because its session ended: the session's end reason and who ended it. |
| `premium_required` | string or null | A residential unlock could have reached the page but the plan or the credit balance does not allow it. |
| `status_reconciled` | string or null | Set when a `blocked` verdict was flipped to `ok` because real content was present. |
| `readiness` | string or null | Why the drive stopped waiting, when reported. |
| `selector_found` | boolean or null | With `wait_for_selector`: true when it appeared, false when the wait ran out. Null without one. |
| `settle` | object or null | What the read waited on: `{settled, waited_ms, requests, pending, busy, reason, dom}`. `reason` is `network`, `dom`, `selector`, `timeout` or `unsupported`. Null when the page was not settled before the read (no settle requested, or nothing delivered). |
| `job_id` | string | Always set: the job that ran the fetch. The sync answer and `GET /v1/job/{job_id}` describe the same work. |
| `job` | object or null | Only on a 202: `{poll, may_run_s, ends_by}`. |

The Wikipedia page (text cut):

```json
{
 "session_id": "sess_6ac4459ad3e24b8289fc20911d76374f",
 "final_url": "https://en.wikipedia.org/wiki/Web_scraping",
 "status": "ok",
 "http_status": 200,
 "job_id": "sess_6ac4459ad3e24b8289fc20911d76374f.72289fc4d5c34f72a1fd9e7f054187d5",
 "job": null,
 "captcha": "none",
 "title": "Web scraping - Wikipedia",
 "text": "Jump to content\nMain menu\nSearch\nDonate\nCreate account\nLog in\nContents hide\n(Top)\nHistory\nTechniques\n...",
 "html_len": 316526,
 "html": null,
 "self_healed": false,
 "recovery": null,
 "held": null,
 "detected": null,
 "content_ok": true,
 "status_reconciled": null,
 "requested_url": "https://en.wikipedia.org/wiki/Web_scraping",
 "redirected": false,
 "error": null,
 "failure_type": null,
 "cause": null,
 "reason": null,
 "origin": null,
 "premium_required": null,
 "readiness": null,
 "selector_found": null,
 "settle": null
}
```

A settled read of a news front page, with a selector and the DOM returned. The request was `{"session_id": "...", "url": "https://www.bbc.com/news", "settle_ms": 500, "wait_ms": 8000, "wait_for_selector": "h1", "include_html": true}` (trimmed to the fields that differ from the plain example):

```json
{
 "final_url": "https://www.bbc.com/news",
 "status": "ok",
 "http_status": 200,
 "title": "BBC News - Breaking news, video and the latest top stories from the U.S. and around the world",
 "text": "Skip to content\nWatch Live\nSubscribe\nSign In\nHome\nNews\nSport\n...",
 "html_len": 351266,
 "html": "<html lang=\"en-GB\"><head><meta charset=\"utf-8\" data-next-head=\"\">...",
 "content_ok": true,
 "selector_found": true,
 "settle": {
  "settled": true,
  "waited_ms": 1096,
  "requests": 67,
  "pending": [],
  "busy": [],
  "reason": "network",
  "dom": true
 }
}
```

A blocked page, with the recovery report. The fetch spent its response budget on two more exits and gave up, answering 200 with `status: "blocked"`. `settle` is null because no page was delivered:

```json
{
 "session_id": "sess_6ac4459ad3e24b8289fc20911d76374f",
 "final_url": "https://apnews.com/",
 "status": "blocked",
 "http_status": 403,
 "job_id": "sess_6ac4459ad3e24b8289fc20911d76374f.d51720ad0f2b4059b1b0ec6338f95099",
 "captcha": "none",
 "title": null,
 "text": "",
 "html_len": 0,
 "self_healed": false,
 "recovery": {
  "driver": "data_plane",
  "attempts": 0,
  "actions": [],
  "ladder": {
   "outcome": "exhausted",
   "attempts": 2,
   "rungs": [
    {"rung": "residential", "result": "budget", "elapsed_ms": 22962},
    {"rung": "isp", "result": "budget", "elapsed_ms": 23236}
   ],
   "exhausted_reason": "budget",
   "budget": {
    "kind": "sync",
    "total_s": 55.0,
    "elapsed_s": 42.3,
    "spent": {"heal": 19.04, "chain": 46.2}
   }
  }
 },
 "held": {
  "http_status": 403,
  "had_text": true,
  "text_chars": 258,
  "recovery": "not_possible",
  "reason": "time_exhausted"
 },
 "detected": {
  "family": "cloudflare",
  "category": "challenge",
  "mechanism": "challenge_page",
  "source": "data_plane"
 },
 "content_ok": false,
 "requested_url": "https://apnews.com/",
 "redirected": false,
 "error": "time_exhausted",
 "failure_type": null,
 "cause": "wait_exhausted",
 "premium_required": null,
 "selector_found": null,
 "settle": null
}
```

Reading `recovery`: `attempts` and `actions` at the top level are the in-page heals on your own session. `ladder` is the escalation across exits: `outcome` is `delivered`, `exhausted` or `no_results`; `attempts` counts the tries that ran; each entry in `rungs` names the tier (`direct`, `residential`, `isp`, `mobile`, ...), its `result`, how long it took and, when it is a plain slug, a `reason`; `delivered_by` names the tier that delivered the page, `exhausted_reason` why the ladder stopped, and `answered_by` the tier whose page was the site's own answer. `budget` is the clock the fetch ran on: `kind` is `sync` (55 s) or `async` (900 s), `elapsed_s` what was used, and `spent` where the seconds went by phase (`heal`, `chain`, `warm_entry`, `persist`, `report`). A `budget` result on a rung means the tier was started but the clock ran out before it answered; on a 900 second job clock the same page gets many more tries.

Async mode and polling. `{"session_id": "...", "url": "https://en.wikipedia.org/wiki/HTTP", "async_mode": true}` answers at once:

```json
{
 "session_id": "sess_6ac4459ad3e24b8289fc20911d76374f",
 "final_url": "https://en.wikipedia.org/wiki/HTTP",
 "status": "pending",
 "http_status": null,
 "job_id": "sess_6ac4459ad3e24b8289fc20911d76374f.95eb7d80eb3c47b69faa7a3befd7f3eb",
 "job": null,
 "captcha": "none",
 "title": null,
 "text": "",
 "html_len": 0,
 "content_ok": false,
 "redirected": false
}
```

(The other fields are present with their null or default values.) A second fetch on the same session while that job runs is refused:

```
HTTP 409
{
 "detail": {
  "error": "session_busy",
  "job_id": "sess_6ac4459ad3e24b8289fc20911d76374f.95eb7d80eb3c47b69faa7a3befd7f3eb",
  "kind": "fetch",
  "message": "session sess_6ac4459ad3e24b8289fc20911d76374f already has a running job ...; poll GET /v1/job/... or wait for it to end before another fetch"
 }
}
```

`on_deadline: "continue"`. On a page that delivers in time the answer is a normal 200. When the page has not delivered at 55 seconds the route answers 202 instead, with `status: "pending"`, the `job_id`, and `job: {"poll": "/v1/job/<job_id>", "may_run_s": <seconds the job may still run>, "ends_by": <unix seconds>}`; the work continues on the 900 second job clock and the page is read from `GET /v1/job/{job_id}`. On a session whose `ttl` cannot hold a 900 second job the request is refused:

```
HTTP 422
{
 "detail": {
  "error": "session_ttl_cannot_hold_job",
  "job_s": 900,
  "ttl_left_s": 599,
  "message": "on_deadline 'continue' runs the fetch as a job of up to 900 s, but this session's ttl ends in 599 s; create the session with a longer ttl, or use on_deadline 'error' or async_mode"
 }
}
```

Redirects. `requested_url` is what you asked for and `final_url` is where the page landed. `https://wikipedia.org/` lands on `https://www.wikipedia.org/` with `redirected: false`, because a `www` prefix is not counted as a move; a change of host or path is.

Errors:

| Status | `error` or message | When |
|---|---|---|
| 400 | `unsafe url: ...` | The URL is not public http or https (private or loopback address, bad scheme). |
| 402 | `insufficient_credits`, `quota_exceeded` | No credit for one action, or the monthly plan allowance is used up. |
| 404 | `No such session` | The session id does not exist or is not yours. |
| 409 | `session not ready (state=...)`, `session browser is not alive` | The session is still starting or closing, or its browser is gone. |
| 409 | `session_busy` | A job is still running on this session. |
| 410 | the session's terminal record | The session was released or expired. |
| 410 | `session_closed_during_fetch` | The session ended while the fetch ran: `{error, message, reason, origin, cause}`. |
| 422 | validation error, `session_ttl_cannot_hold_job` | Bad field (an invalid regular expression in `expect_url`, `expect_text` or `no_results_url` is a 422 too), or `continue` on a session whose `ttl` cannot hold the job. |
| 429 | rate limit | The per-key drive window was exceeded (`Retry-After` is set). |
| 504 | `deadline` | `on_deadline: "error"` (the default) and the page did not deliver by 55 seconds. The body is a fetch response with `status: "error"`, `error: "deadline"`, `failure_type: "TimeoutError"`, `cause: "wait_exhausted"`; the work is cancelled and nothing is billed. |

Notes:

- Timing: the response limit is 55 seconds; a job runs up to 900 seconds. Plain pages return in 0.5 to 3 seconds. A challenged page spends most of the limit on alternative exits, so a page you know is protected is better run with `async_mode: true` or `on_deadline: "continue"`.
- One job per session at a time. Parallel fetches need parallel sessions.
- A finished job stays pollable for at least 20 minutes after it ends, even after the session is released.
- Billing: 1 credit per delivered page (`status: "ok"`) plus 1 credit per MB of page HTML. A `blocked`, `empty` or `error` fetch is not charged the action. A page served through a residential, ISP or mobile exit is billed as premium egress per MB instead of plain egress. A CAPTCHA solved on the way costs 20 credits. Session time is billed per minute separately.
- The page stays open in the session's current tab after a successful fetch, so a following `/act`, screenshot or extract works on it and the live view shows it.

## GET /v1/job/{job_id}

Poll any job: a fetch (`async_mode`, or a `continue` handed over at the limit), an extract, an inspect, a solve, an agent task or a template. The job id is the one the starting call returned.

Auth: Bearer API key. No body.

Response:

| Field | Type | Meaning |
|---|---|---|
| `session_id` | string | The session the job ran on. |
| `job_id` | string | The id polled. |
| `kind` | string | `fetch`, `extract`, `inspect`, `solve`, `agent` or `template`. Decides the shape of `result`. |
| `status` | string | `pending` (still running), `done`, `error`, or `cancelled` (the session ended under it). |
| `result` | object or null | Null while pending. For `done`, the route's own response body (a fetch response, an extract response, an inspect report). For `error`, `{"error": "<message>"}` and, for a fetch, the fetch fields with `status: "error"`. For `cancelled`, `{status: "cancelled", error: "session_closed", reason, origin, cause}`. |

While pending:

```json
{
 "session_id": "sess_6ac4459ad3e24b8289fc20911d76374f",
 "job_id": "sess_6ac4459ad3e24b8289fc20911d76374f.95eb7d80eb3c47b69faa7a3befd7f3eb",
 "kind": "fetch",
 "status": "pending",
 "result": null
}
```

Done (text cut):

```json
{
 "session_id": "sess_6ac4459ad3e24b8289fc20911d76374f",
 "job_id": "sess_6ac4459ad3e24b8289fc20911d76374f.95eb7d80eb3c47b69faa7a3befd7f3eb",
 "kind": "fetch",
 "status": "done",
 "result": {
  "final_url": "https://en.wikipedia.org/wiki/HTTP",
  "status": "ok",
  "http_status": 200,
  "title": "HTTP - Wikipedia",
  "text": "Jump to content\nMain menu\nSearch\n...",
  "html_len": 727436,
  "html": null,
  "content_ok": true,
  "self_healed": false,
  "recovery": null,
  "held": null,
  "detected": null,
  "error": null,
  "failure_type": null,
  "cause": null,
  "selector_found": null,
  "settle": null,
  "requested_url": "https://en.wikipedia.org/wiki/HTTP",
  "redirected": false
 }
}
```

An inspect job that ran out of time:

```json
{
 "session_id": "sess_6ac445c25d9d4d6eafac24308f4060e7",
 "job_id": "sess_6ac445c25d9d4d6eafac24308f4060e7.9d527b9c9d6647658a3bd83a3003d6f8",
 "kind": "inspect",
 "status": "error",
 "result": {"error": "504: {'error': 'inspect_timeout', 'detail': 'capture did not finish within 48 s'}"}
}
```

Errors: 404 `no such job` for an unknown id, an id that belongs to another account, or a record that has expired.

Notes:

- Poll every 1 to 2 seconds with backoff. A job that has ended can be polled for at least 20 minutes afterwards; the session may already be gone by then and the poll still answers.
- `GET /v1/fetch/job/{job_id}` also works for fetch jobs and answers the bare fetch response instead of the envelope. Prefer `/v1/job/{job_id}`, which covers every kind.

# 13. Extract

## POST /v1/extract

Load a page in the session's browser and return its main content as clean markdown (navigation, consent banners, share bars, related rails, footers and hidden elements removed, links absolute, code blocks with their language), with optional plain text, links, metadata and the rendered HTML. Use it when the content is going into a model context. Like `fetch`, it is a stealth read path: protected pages are escalated through residential unlock and challenge solving, which a raw CDP navigation never gets.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | string | required | A ready session you own. |
| `url` | string | required | Public http or https URL, up to 4096 characters. |
| `wait_ms` | integer, 0 to 60000 | 8000 | Ceiling for the page to finish loading before it is read. A page that is ready sooner is read sooner. Raise it for a heavy single-page app. |
| `formats` | array of `markdown`, `text`, `html`, `links`, `metadata` | null (markdown only) | What to return. With no `formats` the response is the markdown contract alone. With `formats`, `markdown` is returned only if listed. |
| `links` | `inline`, `footnote`, `none` | `inline` | How hyperlinks render in the markdown. `footnote` writes `[label][n]` references; `none` drops the URLs. |
| `max_chars` | integer, 100 to 10000000 | null | Cut the markdown and the text at a block boundary at this length; `truncated: true` reports a cut. |
| `include_images` | boolean | true | `false` drops every image from the markdown. |
| `schema` | object (JSON Schema) | null | Structured extraction into this shape. Not currently available: answers 501 `structured_extraction_unavailable`. |
| `prompt` | string, up to 2000 characters | null | Structured extraction by instruction. Not currently available: answers 501 `structured_extraction_unavailable`. |
| `async_mode` | boolean | false | Return at once with `status: "pending"` and a `job_id`; poll `GET /v1/job/{job_id}`. |

A plain request:

```json
{"session_id": "sess_6ac4459ad3e24b8289fc20911d76374f", "url": "https://en.wikipedia.org/wiki/Web_scraping"}
```

Response:

| Field | Type | Meaning |
|---|---|---|
| `session_id` | string | The session used. |
| `final_url` | string | Where the navigation landed. |
| `status` | string | `ok`, or a typed outcome: `source_empty` (the page produced no readable text: an unhydrated app shell or an image-only challenge), `challenged` (an anti-bot interstitial that was not cleared), `hard_blocked` (a block page or a 403 without a sign-in surface), `requires_login` (a sign-in wall or a 401), `rate_limited` (429 or a "too many requests" page). `pending` on an async start. |
| `blocked_reason` | string or null | A one-line reason, set when `status` is not `ok`. |
| `self_healed` | boolean | The content was reached only after a residential unlock. |
| `premium_required` | string or null | A blocked source could have been reached by residential unlock but the plan or the credit balance does not allow it. |
| `title` | string or null | Page title. |
| `markdown` | string | The main content as markdown. Empty when `status` is not `ok`, or when `formats` was given without `markdown`. |
| `markdown_len` | integer | Length of the returned markdown. |
| `tokens_estimate` | integer | A rough token count of the returned markdown (about a quarter of its length). |
| `text` | string or null | Plain text (link labels without URLs, no image or heading syntax). Only with `text` in `formats`. |
| `html` | string or null | The rendered page HTML. Only with `html` in `formats`. |
| `links` | array of strings or null | Absolute URLs of the page's links. Only with `links` in `formats`. |
| `metadata` | object or null | `{title, description, canonical, lang, og_title, og_description, og_image, og_site_name, published_time, modified_time, author, word_count, reading_time_min}`. Only with `metadata` in `formats`. |
| `truncated` | boolean | A `max_chars` cut was applied. |
| `data` | object or null | The structured result when `schema` or `prompt` was given and a model is available. |
| `extract_tokens` | integer or null | Model tokens spent on `data`; 0 when a cached answer was served. |
| `job_id` | string or null | Set on an async start. |

The Wikipedia page (markdown cut):

```json
{
 "job_id": null,
 "data": null,
 "extract_tokens": null,
 "session_id": "sess_6ac4459ad3e24b8289fc20911d76374f",
 "final_url": "https://en.wikipedia.org/wiki/Web_scraping",
 "status": "ok",
 "blocked_reason": null,
 "self_healed": false,
 "premium_required": null,
 "title": "Web scraping - Wikipedia",
 "markdown": "# Web scraping\n\nFrom Wikipedia, the free encyclopedia\n\nFor broader coverage of this topic, see [Data scraping](https://en.wikipedia.org/wiki/Data_scraping).\n\n...",
 "markdown_len": 48547,
 "tokens_estimate": 12136,
 "text": null,
 "html": null,
 "links": null,
 "metadata": null,
 "truncated": false
}
```

A news front page with every format, footnote links, no images and a 3000 character cut. The request was `{"session_id": "...", "url": "https://www.bbc.com/news", "formats": ["markdown", "text", "links", "metadata"], "links": "footnote", "max_chars": 3000, "include_images": false}` (markdown, text and the links list cut):

```json
{
 "session_id": "sess_6ac4459ad3e24b8289fc20911d76374f",
 "final_url": "https://www.bbc.com/news",
 "status": "ok",
 "blocked_reason": null,
 "self_healed": false,
 "premium_required": null,
 "title": "BBC News - Breaking news, video and the latest top stories from the U.S. and around the world",
 "markdown": "[LIVE][1]\n\n## ...",
 "markdown_len": 2897,
 "tokens_estimate": 724,
 "text": "LIVE\n\n...",
 "html": null,
 "links": [
  "https://www.bbc.com/watch-live-news/",
  "https://www.bbc.com/",
  "https://www.bbc.com/news",
  "https://www.bbc.com/sport",
  "..."
 ],
 "metadata": {
  "title": "BBC News - Breaking news, video and the latest top stories from the U.S. and around the world",
  "description": "Visit BBC News for the latest news, breaking news, video, audio and analysis. ...",
  "canonical": "https://www.bbc.com/news",
  "lang": "en-GB",
  "og_title": "BBC News - Breaking news, video and the latest top stories from the U.S. and around the world",
  "og_description": "Visit BBC News for the latest news, breaking news, video, audio and analysis. ...",
  "og_image": null,
  "og_site_name": null,
  "published_time": null,
  "modified_time": null,
  "author": null,
  "word_count": 1375,
  "reading_time_min": 7
 },
 "truncated": true
}
```

Async extract and its poll. `{"session_id": "...", "url": "https://example.com/", "async_mode": true}` answers with `status: "pending"` and a `job_id`. The poll on `GET /v1/job/{job_id}` reports `kind: "extract"` and, once done, the extract fields in `result`.

Residential unlock escalation. When the page comes back `challenged`, `hard_blocked`, `rate_limited` or `requires_login`, the read is retried through residential egress with server-side CAPTCHA solving before you see the typed status. If that reaches the content, the response is `ok` with `self_healed: true`. If your plan has no premium egress left, or the balance cannot cover a solve, the typed status is returned with `premium_required` set to a sentence that says which of the two it was. A `source_empty` page is not escalated: it is a hydration problem, so raise `wait_ms` instead.

Errors:

| Status | `error` or message | When |
|---|---|---|
| 400 | `unsafe url: ...` | The URL is not public http or https. |
| 402 | `insufficient_credits`, `quota_exceeded` | No credit for one action, or the plan allowance is used up. |
| 404 | `No such session` | Unknown or foreign session id. |
| 409 | `session not ready`, `session browser is not alive` | The session cannot be driven. |
| 410 | terminal record | The session was released or expired. |
| 422 | validation error | Bad field; an empty `formats` list is refused. |
| 429 | rate limit | The per-key drive window was exceeded. |
| 501 | `structured_extraction_unavailable` | `schema` or `prompt` was given. The refusal comes before the page is loaded, so nothing is billed. |
| 504 | `extract exceeded 43s ... the page never stopped loading (infinite scroll / streaming feed). Retry with a smaller wait_ms, or target a URL that settles.` | The page did not settle inside the synchronous ceiling of 43 seconds. Run such pages with `async_mode: true`. |

Notes:

- Timing: a plain page returns in 1 to 3 seconds. The synchronous ceiling is 43 seconds for the navigation and the read together; `wait_ms` above that has no effect on a synchronous call. As a job the ceiling is `wait_ms` plus a margin for the read.
- The tab the extract opened stays open on the session, so a following `/act` or `/elements` acts on the page you just read.
- Billing: 1 credit per successful extract plus 1 credit per MB of markdown; nothing for a typed non-`ok` outcome. When the residential escalation delivered the page, its bytes are billed as premium egress and the solve as 20 credits. Billing is on the full markdown even when `max_chars` cuts what is returned.

# 14. Scrape and crawl

## POST /v1/scrape

Read one page and return it, with no session to create, drive or release. The page is read on a browser session of its own that is destroyed with the request.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Public http or https URL, up to 4096 characters. |
| `formats` | array of `markdown`, `html`, `text`, `links`, `metadata` | `["markdown"]` | What to return. Must not be empty. |
| `links` | `inline`, `footnote`, `none` | `inline` | How hyperlinks render in the markdown. |
| `max_chars` | integer, 100 to 10000000 | null | Cut markdown and text at a block boundary; `truncated` reports a cut. |
| `include_images` | boolean | true | `false` drops images from the markdown. |
| `wait_ms` | integer, 0 to 60000 | 8000 | Ceiling for the page to finish loading before it is read. |
| `schema`, `prompt` | object, string | null | Structured extraction; not currently available (501). |
| `residential`, `region` | boolean, string | null | Accepted; the page is read from a session chosen for the site. |

Request:

```json
{"url": "https://example.com", "formats": ["markdown", "text", "links", "metadata"]}
```

Response:

| Field | Type | Meaning |
|---|---|---|
| `url` | string | Where the page landed (the same value as `final_url`, kept for older callers). |
| `final_url` | string | Where the page landed. |
| `requested_url` | string | The URL you sent. `requested_url != final_url` is a redirect. |
| `title` | string or null | Page title. |
| `status` | string | `ok` or one of the extract outcomes (`source_empty`, `challenged`, `hard_blocked`, `requires_login`, `rate_limited`). |
| `blocked_reason` | string | Present when `status` is not `ok`. |
| `self_healed` | boolean | Present when known; true when the page was reached after a heal. |
| `markdown`, `text`, `html`, `links`, `metadata` | per `formats` | As on `/v1/extract`. |
| `truncated` | boolean | Present when `max_chars` was given. |
| `data` | object | Present with `schema` or `prompt`, where enabled. |

The answer (text fields cut):

```json
{
 "url": "https://example.com/",
 "final_url": "https://example.com/",
 "title": "Example Domain",
 "status": "ok",
 "requested_url": "https://example.com",
 "self_healed": false,
 "markdown": "This domain is for use in documentation examples without needing permission. ...",
 "text": "This domain is for use in documentation examples without needing permission. ...",
 "links": [
  "https://iana.org/help/example-domains"
 ],
 "metadata": {
  "title": "Example Domain",
  "description": null,
  "canonical": null,
  "lang": "en",
  "og_title": null,
  "og_description": null,
  "og_image": null,
  "og_site_name": null,
  "published_time": null,
  "modified_time": null,
  "author": null,
  "word_count": 133,
  "reading_time_min": 1
 }
}
```

Redirect detection: compare `requested_url` and `final_url` yourself; scrape has no `redirected` flag.

Errors:

| Status | `error` or message | When |
|---|---|---|
| 400 | `unsafe url: ...` | The URL is not public http or https. |
| 402 | `insufficient_credits`, `quota_exceeded` | No credit, or the plan allowance is used up. |
| 422 | validation error | Bad field, or an empty `formats` list. |
| 429 | rate limit, `concurrency_limit` | The per-key drive window, or no room for the session the scrape creates. |
| 502 | `scrape_failed` | The render raised; the body carries `retryable: true`. |
| 504 | `deadline_exceeded` | The call ran past the 57 second limit. |

Notes:

- Timing: 1 to 2 seconds for a plain page, more for a heavy one. The whole call must finish inside 57 seconds; there is no `async_mode`.
- Billing: the session charge (2) plus 1 action plus egress per MB of markdown plus the session's browser time, prorated. A non-`ok` page is still charged the session.

## POST /v1/crawl

Walk a site from a starting URL and return every page reached, in one call on one session of its own.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Where to start. Public http or https. |
| `max_pages` | integer, 1 to 100 | 10 | Stop after this many delivered pages. |
| `depth` | integer, 1 to 5 | 2 | How many link hops from the start page to follow. |
| `include_patterns` | array of up to 20 strings | `[]` | When set, a link is followed only if its URL contains one of them (plain substring match). |
| `exclude_patterns` | array of up to 20 strings | `[]` | A link whose URL contains one of them is skipped. |
| `formats` | array of `markdown`, `html`, `text` | `["markdown"]` | What each page carries. Must not be empty. |
| `residential`, `region` | boolean, string | null | Accepted. |

Rules: only links on the same origin are followed (same scheme and host; a different subdomain is another site). Fragments are dropped, `/index.html` and a trailing slash are folded into the same page, and each page contributes up to 300 links, breadth first. A page that fails to load or comes back blocked is skipped and does not count towards `max_pages`. Pages are read one at a time.

Response:

| Field | Type | Meaning |
|---|---|---|
| `url` | string | The start URL as sent. |
| `count` | integer | Number of pages returned. |
| `pages` | array | One entry per delivered page: `{url, final_url, title, status: "ok"}` plus `markdown`, `text` (plain text) and `html` as asked for in `formats`. |

`{"url": "https://www.iana.org/help/example-domains", "max_pages": 3}` (markdown cut):

```json
{
 "url": "https://www.iana.org/help/example-domains",
 "count": 3,
 "pages": [
  {
   "url": "https://www.iana.org/help/example-domains",
   "final_url": "https://www.iana.org/help/example-domains",
   "title": "Example Domains",
   "status": "ok",
   "markdown": "# Example Domains\n\nA number of domains such as `example.com` and `example.org` are maint..."
  },
  {
   "url": "https://www.iana.org/",
   "final_url": "https://www.iana.org/",
   "title": "Internet Assigned Numbers Authority",
   "status": "ok",
   "markdown": "## [Domain Names](https://www.iana.org/domains)\n\nManagement of the DNS Root Zone (assign..."
  },
  {
   "url": "https://www.iana.org/domains",
   "final_url": "https://www.iana.org/domains",
   "title": "Domain Name Services",
   "status": "ok",
   "markdown": "# Domain Name Services\n\nWe operate and maintain a number of key aspects of the DNS, incl..."
  }
 ]
}
```

A crawl of `https://example.com` with `max_pages: 3` returns `count: 1`, because its only link points at `iana.org`, which is another origin.

Errors: as `/v1/scrape` (400 unsafe url, 402, 422 on a bad field or empty `formats`, 429, 504 `deadline_exceeded` past 57 seconds).

Notes:

- Timing: about a second per page on a fast site. The whole crawl must finish inside the 57 second limit and there is no `async_mode`, so keep `max_pages` to what the site can serve in under a minute; the pages read before the cut are lost with the 504.
- Billing: the session charge (2) plus 1 credit per page plus egress per MB of markdown plus prorated browser time. A crawl is always charged at least one action.

# 15. Search

## POST /v1/search

Search-engine results as structured JSON. No session is needed: each search runs on a browser of its own and tries the engines in order until one answers.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `query` | string, 1 to 2000 characters | required | The search string. |
| `engine` | string | null | Pin one engine: `duckduckgo`, `bing`, `google` or `yahoo`. With no pin the chain `duckduckgo`, `bing`, `google` is tried in order and the first engine that answers wins. |
| `region` | string, ISO 3166-1 alpha-2 | null | Run the search from this country. Not currently available: answers 503 `region_routing_unavailable` (see `GET /v1/search/regions`). |
| `count` | integer, 1 to 100 | 10 | Results wanted. |
| `offset` | integer, 0 or more | 0 | Skip this many results, for paging. |
| `collapse_domains` | boolean | false | Keep one result per domain. |
| `fresh` | boolean | false | Skip the result cache and refresh it. |
| `session_id` | string | null | Not supported; a search always uses its own browser. Refused with 409. |

Response:

| Field | Type | Meaning |
|---|---|---|
| `query` | string | The query as sent. |
| `engine` | string | The engine that answered. |
| `count` | integer | Results in this response. |
| `offset` | integer | The offset applied. |
| `total_found` | integer | Distinct results seen before paging. |
| `has_more` | boolean | `total_found` exceeds `offset + count`. |
| `results` | array | Each `{title, url, snippet, rank, engine, domain, published}`. `rank` starts at 1 after `offset`; `domain` is the result's host without `www`; `published` is an ISO date when the engine showed one, else null. |
| `status` | string | `ok` (the engine answered; `count` may still be 0), `blocked` (the request never reached results: a challenge, a consent or deny page, or the page did not load), `error` (the engine was reached but produced nothing usable), `empty` (an operator query such as `site:` that returned nothing; not billed). |
| `reason` | string or null | The fact behind a non-`ok` status, or `no_results` on an `ok` with nothing matched: `no_results`, `blocked`, `captcha`, `rate_limited`, `access_denied`, `proxy_refused`, `page_load_failed`, `parse_empty`, `engine_error`, `unsupported_operators`. |
| `engines_tried` | array | Every engine tried, in order: `{engine, status, reason, took_ms}` where `status` is `ok`, `no_results`, `blocked`, `parse_empty`, `timeout` or `engine_error`. |
| `fallback_from` | string or null | The first engine tried when the answer came from another one. |
| `cached` | boolean | The answer was served from the result cache. |
| `took_ms` | integer | Server time for the whole search. |
| `suggestion`, `operators` | string or null, array | On `reason: "unsupported_operators"`: the operators seen and a plain-language rewrite to retry. |
| `knowledge_graph`, `people_also_ask`, `related_searches`, `answer_box` | object or null, array, array, string or null | Rich blocks when the engine rendered them. |
| `region`, `exit` | string or null, object or null | Only on a regional search. |

The default chain, `{"query": "web scraping with a headless browser", "count": 5}`:

```json
{
 "query": "web scraping with a headless browser",
 "engine": "duckduckgo",
 "count": 5,
 "offset": 0,
 "total_found": 10,
 "has_more": true,
 "results": [
  {
   "title": "How to Scrape Dynamic Websites Using Headless Web Browsers",
   "url": "https://scrapfly.io/blog/posts/scraping-using-browsers",
   "snippet": "Intro to using headless web browser and libraries like Puppeteer, Playwright and Selenium in web scraping dynamic websites.",
   "rank": 1,
   "engine": "duckduckgo",
   "domain": "scrapfly.io",
   "published": null
  },
  {
   "title": "Best Headless Browsers for Web Scraping (2026 Guide)",
   "url": "https://www.browserbase.com/blog/best-web-scraping-headless-browsers",
   "snippet": "Compare the best headless browsers for web scraping : performance, detection avoidance, and scale.",
   "rank": 2,
   "engine": "duckduckgo",
   "domain": "browserbase.com",
   "published": null
  },
  {
   "title": "Headless Browser Automation Tools for Web Scraping (With Free Trials)",
   "url": "https://www.browserstack.com/guide/headless-browser-automation-tools-web-scraping",
   "snippet": "Explore the best headless browser automation tools for web scraping , including Playwright, Selenium, and managed solutions with free trials.",
   "rank": 3,
   "engine": "duckduckgo",
   "domain": "browserstack.com",
   "published": null
  },
  {
   "title": "How to Scrape Dynamic Websites with Headless Browsers in Python",
   "url": "https://www.firecrawl.dev/blog/headless-web-scraping-dynamic-websites",
   "snippet": "Learn how to scrape dynamic websites using Selenium, Playwright, and Pyppeteer in Python.",
   "rank": 4,
   "engine": "duckduckgo",
   "domain": "firecrawl.dev",
   "published": null
  },
  {
   "title": "GitHub - h4ckf0r0day/obscura: The headless browser for AI agents and ...",
   "url": "https://github.com/h4ckf0r0day/obscura",
   "snippet": "Obscura is a headless browser engine written in Rust, built for web scraping and AI agent automation.",
   "rank": 5,
   "engine": "duckduckgo",
   "domain": "github.com",
   "published": null
  }
 ],
 "status": "ok",
 "reason": null,
 "engines_tried": [
  {"engine": "duckduckgo", "status": "ok", "reason": null, "took_ms": 1233}
 ],
 "fallback_from": null,
 "cached": false,
 "took_ms": 1298,
 "suggestion": null,
 "operators": [],
 "knowledge_graph": null,
 "people_also_ask": [],
 "related_searches": [],
 "answer_box": null,
 "region": null,
 "exit": null
}
```

Pinned to Google, `{"query": "web scraping with a headless browser", "count": 3, "engine": "google"}`, with `published` dates (trimmed to the results and the attempt record):

```json
{
 "query": "web scraping with a headless browser",
 "engine": "google",
 "count": 3,
 "offset": 0,
 "total_found": 13,
 "has_more": true,
 "results": [
  {
   "title": "Your preferred method to scrape? Headless browser or ...",
   "url": "https://www.reddit.com/r/webscraping/comments/1hjuan9/your_preferred_method_to_scrape_headless_browser/",
   "snippet": "Freely Zoomable Hierarchy Search Engine · Better web scraping using headless instance of Chrome · ...",
   "rank": 1,
   "engine": "google",
   "domain": "reddit.com",
   "published": null
  },
  {
   "title": "What Is a Headless Browser and Best Ones for Web Scraping",
   "url": "https://www.zenrows.com/blog/headless-browser-scraping",
   "snippet": "Headless web scraping is a way to perform scraping with a special version of a browser with no UI, ...",
   "rank": 2,
   "engine": "google",
   "domain": "zenrows.com",
   "published": "2022-11-23"
  },
  {
   "title": "How to Scrape Dynamic Websites with Headless Browsers ...",
   "url": "https://www.firecrawl.dev/blog/headless-web-scraping-dynamic-websites",
   "snippet": "Learn how to scrape dynamic websites using Selenium, Playwright, and Pyppeteer in Python. ...",
   "rank": 3,
   "engine": "google",
   "domain": "firecrawl.dev",
   "published": "2025-12-17"
  }
 ],
 "status": "ok",
 "reason": null,
 "engines_tried": [
  {"engine": "google", "status": "ok", "reason": null, "took_ms": 8729}
 ],
 "fallback_from": null,
 "cached": false,
 "took_ms": 8857
}
```

A pin has no fallback: when the pinned engine stalls, the request stalls and can hit the 57 second limit:

```
HTTP 504
{"error": "deadline_exceeded", "detail": "the request ran past 57s and was ended; the session is intact", "retry_with": "async_mode", "deadline_s": 57.0}
```

Search has no `async_mode`, so retry the call, with a smaller `count` or without a pin.

An unknown engine:

```
HTTP 400
{"detail": "unknown engine 'ask' (one of ('duckduckgo', 'bing', 'google', 'yahoo'))"}
```

Errors:

| Status | `error` or message | When |
|---|---|---|
| 400 | `unknown engine ...` | `engine` is not one of the four. |
| 402 | `insufficient_credits`, `quota_exceeded` | No credit, or the plan allowance is used up. |
| 409 | `unsupported_data_plane_command` | `session_id` was given. |
| 422 | `invalid_region`, `unsupported_region`, `region_with_session` | `region` is not a country code, no exit serves it, or it was combined with `session_id`. |
| 429 | `concurrency_limit` | No room for the session the search creates. Close sessions or retry. |
| 502 | `session_launch_failed` | The search's browser could not start; retry. |
| 503 | `region_routing_unavailable` | `region` was given. |
| 504 | `deadline_exceeded` | The search ran past 57 seconds. |

Notes:

- Timing: the default chain answers in 1 to 2 seconds; a Google pin can take around 9 seconds.
- Cache: results are cached for 120 seconds per engine, query, region, offset, count and `collapse_domains`, and `fresh: true` bypasses it. Do not depend on a repeat being served from cache or being identical.
- Billing: the session charge (2) plus 1 action plus prorated browser time. The action is charged only on `status: "ok"` (an `ok` with zero results included); a `blocked`, `error` or `empty` search is charged the session only.
- Operator queries (`site:`, `inurl:`, `OR`, ...) that return nothing come back as `status: "empty"` with `reason: "unsupported_operators"`, the `operators` seen and a `suggestion` rewrite, and are not charged the action.

## GET /v1/search/engines

The engines `POST /v1/search` accepts and the order an unpinned search tries them.

Auth: Bearer API key. No body.

```json
{"engines": ["duckduckgo", "bing", "google", "yahoo"], "default": "duckduckgo", "chain": ["duckduckgo", "bing", "google"], "max_count": 100, "cache_ttl_s": 120.0}
```

| Field | Meaning |
|---|---|
| `engines` | Values `engine` accepts. |
| `default` | The first engine of the chain. |
| `chain` | The order an unpinned search tries. `yahoo` is available only as a pin. |
| `max_count` | The ceiling for `count`. |
| `cache_ttl_s` | How long a result set is cached. |

## GET /v1/search/regions

Countries a search can be run from, with the routes that serve each.

Auth: Bearer API key. No body.

```json
{"available": false, "order": [], "regions": {}}
```

When regional search is available, `available` is true, `order` lists the route kinds best first, and `regions` maps each country code to its routes. Until then `region` on `POST /v1/search` answers 503.

# 16. Inspect and solve

## POST /v1/inspect

Drive the session's browser to a URL, capture all network traffic for a period, and return a report of the site's API calls, auth signals and asset loading. Use it to find the JSON endpoints behind a page before you scrape it.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | string | required | A ready session you own. |
| `url` | string | required | The page to watch. Public http or https. |
| `duration` | number, 0 or more | 60 | Seconds of network capture, capped at 180. The whole call ends within the capture plus 45 seconds. |
| `async_mode` | boolean | false | Return a job at once; poll `GET /v1/job/{job_id}`. |

Request:

```json
{"session_id": "sess_6ac4459ad3e24b8289fc20911d76374f", "url": "https://example.com/", "duration": 3}
```

Response (synchronous):

| Field | Type | Meaning |
|---|---|---|
| `url` | string | The page watched. |
| `duration_s` | number | Actual capture length. |
| `total_calls` | integer | Network calls seen. |
| `by_kind` | object | Count per kind: `document`, `api`, `asset`, ... |
| `api_endpoints` | array | The JSON and XHR calls seen, each with method, URL (query stripped), status, mime, kind and a body sample. |
| `auth_signals` | array | Calls that set cookies or carried an `Authorization` header. |
| `asset_summary` | object | Count per asset type. |
| `markdown` | string | The same report as a markdown document. |

```json
{
 "url": "https://example.com/",
 "duration_s": 4.1,
 "total_calls": 2,
 "by_kind": {"document": 1, "asset": 1},
 "api_endpoints": [],
 "auth_signals": [],
 "asset_summary": {"Script": 1},
 "markdown": "# Site reconnaissance: https://example.com/\n\nCaptured **2** network calls over 4.1s.\n\n| kind | count |\n|---|---|\n| document | 1 |\n| asset | 1 |\n\n## API endpoints (0)\n_none observed_\n\n## Auth signals (0)\n_none observed_\n\n## Assets\n- Script: 1"
}
```

With `async_mode: true` the answer is a job envelope:

```json
{"session_id": "sess_6ac445c25d9d4d6eafac24308f4060e7", "job_id": "sess_6ac445c25d9d4d6eafac24308f4060e7.c543a77567f24fce8d95bd23af4a8d54", "kind": "inspect", "status": "pending"}
```

and the poll's `result` is the report above once `status` is `done`.

Concurrency: three captures may run at once per API key, counted across the whole service. A fourth answers 429 `too_many_concurrent_inspects` with `Retry-After: 5`, `X-RateLimit-Limit: 3`, `X-RateLimit-Remaining: 0`. Run concurrent captures on separate sessions; captures on one session contend for the same browser and can time out against each other.

Errors:

| Status | `error` or message | When |
|---|---|---|
| 400 | `unsafe url: ...` | The URL is not public http or https. |
| 402 | `insufficient_credits`, `quota_exceeded` | No credit, or the plan allowance is used up. |
| 404 | `No such session` | Unknown or foreign session id. |
| 409 | `session not ready`, `session browser is not alive` | The session cannot be driven. |
| 410 | terminal record | The session was released or expired. |
| 429 | `too_many_concurrent_inspects` | A fourth capture for this key. |
| 502 | `inspect_failed` | The capture itself failed (the page could not be navigated, the browser refused the capture); `detail` names it. |
| 504 | `inspect_timeout` | The capture did not finish within `duration + 45` seconds. On a job this lands in the poll's `result.error`. |

Notes:

- Timing: a 3 second capture answers in about 4.5 seconds. Anything that may run past 57 seconds in total must use `async_mode`, so in practice a synchronous `duration` above about 10 seconds is a risk.
- Billing: 1 credit per capture plus 1 credit per MB the page moved (every asset counts, since the capture pulls them all), billed as premium egress when the session is residential.

## POST /v1/solve

Clear a challenge widget or interstitial blocking the page the session is on: hCaptcha, reCAPTCHA v2 and v3, Turnstile, a Cloudflare interstitial. You do not have to name the wall. Call it after a `/navigate` or `/act` hit a challenge, or after a `/v1/fetch` came back `blocked`, and carry on with the same session: the clearance stays on the tab that earned it.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | string | required | The session whose page is blocked. |
| `url` | string | null | Navigate here first. Omit to solve whatever the session is already on; a session with no open tab then needs a `url`. |
| `kind` | string | null | A hint: `hcaptcha`, `recaptcha_v2`, `recaptcha_v3`, `turnstile`. Omit unless the probe cannot see the widget. |
| `timeout` | number, 1 to 300 | 45 | Seconds to spend, navigation included. A synchronous call lowers anything above 50 to 50 and reports it; an async one lowers anything above 180. |
| `async_mode` | boolean | false | Return a job at once; poll `GET /v1/job/{job_id}`. |

Response:

| Field | Type | Meaning |
|---|---|---|
| `solved` | boolean | A solver ran and the wall is verified gone. The page is re-probed after the solve; a solver that claims success while the wall is still up answers false. |
| `already_clear` | boolean | No challenge was found, so nothing was solved and nothing is billed. |
| `kind` | string | The challenge family the probe named, or empty. Decide on `solved` and `already_clear`, not on `kind`. |
| `reason` | string | `cleared`, `nothing_to_solve: ...`, `challenge_not_cleared`, a navigation failure, or `deadline: ...` when the time ran out. |
| `elapsed_ms` | integer | Time spent. |
| `session_id` | string | The session. |
| `timeout_s` | number | The budget applied. |
| `timeout_clamped` | boolean | The requested `timeout` was lowered to the limit. |
| `job_id`, `status` | string | With `async_mode`: the job to poll and `pending`. |

A page without a challenge:

```json
{
 "solved": false,
 "kind": "cloudflare",
 "reason": "nothing_to_solve: no challenge found on the page",
 "elapsed_ms": 170,
 "session_id": "sess_6ac4459ad3e24b8289fc20911d76374f",
 "timeout_s": 45.0,
 "timeout_clamped": false,
 "already_clear": true
}
```

Errors:

| Status | `error` or message | When |
|---|---|---|
| 400 | `unsafe url: ...` | `url` is not public http or https. |
| 402 | `solving a challenge needs more credits (top up at /dashboard)` | The balance cannot cover one solve (20 credits). Checked before anything runs. |
| 404 | `No such session` | Unknown or foreign session id. |
| 409 | `session not ready`, `session browser is not alive` | The session cannot be driven. |
| 410 | terminal record | The session was released or expired. |
| 429 | rate limit | The per-key drive window was exceeded. |

Notes:

- Timing: the default budget is 45 seconds and a synchronous call never exceeds 50. When the budget runs out the answer is `solved: false` with a `reason` starting `deadline:`, and the session stays open. On a deadline, re-run with `async_mode: true` (budget up to 180 s), or read the page with `POST /v1/fetch` with `async_mode: true`, which escalates across exits on a 900 s budget; a block that is tied to the exit IP rather than a widget is a `fetch` or `rotate-ip` problem, not a `solve` problem.
- Billing: 20 credits when `solved` is true (a solver ran and the wall is gone), including the case where the navigation itself cleared the wall. Nothing for `already_clear` or a failed solve.
- A `/v1/fetch` that comes back `blocked` has usually already tried the solvers on its own; `/v1/solve` is for the page you are driving by hand.

# 17. Agent tasks

An agent task is a named, pre-built browser flow (log in, paginate a listing, extract a table, run a script, take a screenshot) that runs inside your session's browser. You list the catalogue, then run one task by name with its parameters. The result is a uniform envelope: `ok`, the task's `data`, a `steps` trace of what happened, and an `error` when it failed. The routes in this and the following automation sections leave the session open when they finish; release it yourself.

## GET /v1/agent/tasks

List the task names you can pass to `POST /v1/agent`.

Auth: Bearer API key. No body, no parameters.

```json
{"tasks": ["authenticated_fetch", "captcha_gated_flow", "click_by_text", "dismiss_popups", "download_file", "evaluate_js", "extract_by_schema", "extract_table", "fill_form", "follow_link_by_text", "handle_new_tab", "infinite_scroll_collect", "login", "multi_step_checkout", "navigate_spa", "paginate_collect", "recon_site_api", "screenshot_capture", "search_site", "solve_press_and_hold", "upload_file", "wait_and_extract"]}
```

Free, no session needed. Errors: 401 only.

## POST /v1/agent

Run one task in a session's browser and return its result, or start it in the background and return a job id.

Auth: Bearer API key. The session must belong to the same key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | string | required | the session whose browser runs the task |
| `task` | string | required | a name from `GET /v1/agent/tasks` |
| `params` | object | `{}` | the task's inputs (see the catalogue below). At most 100 keys. Counters such as `max_pages`, `max_scrolls`, `limit`, `count`, `max_items` are clamped to server ceilings (100 pages or scrolls, 500 for `limit` and `count`, 1000 items) and never go negative |
| `async_mode` | boolean | `false` | return at once with `job_id` and `status: "pending"`, run the task in the background, poll `GET /v1/job/{job_id}` |
| `approval_id` | string | null | re-run a `login` that was paused for approval, after a member approved it (see Approvals) |

Every string in `params` that looks like a URL, at any depth, is checked before the task starts: a host that resolves to a private, loopback or cloud-metadata address is refused with 400.

Where the task runs: when `params.url` is given the task navigates to it first. Without a URL the task acts on the page the session is already showing, which is the page a `POST /v1/session/{id}/navigate` left open. Tasks that have no `url` parameter at all (`click_by_text`, `dismiss_popups`, `follow_link_by_text`, `handle_new_tab`, `navigate_spa`, `upload_file`, `captcha_gated_flow`, and `multi_step_checkout` without `cart_url`) need a page to be open and answer `ok: false` with `error: "no_page: navigate the session to a page first"` when the session shows a blank tab. `evaluate_js` runs wherever the tab is, including a blank one.

Response:

| Field | Type | Meaning |
|---|---|---|
| `session_id` | string | echoed |
| `task` | string | echoed |
| `ok` | boolean | the task succeeded. In `async_mode` the immediate answer is always `false` with `status: "pending"`; that is not a failure |
| `data` | any | the task's payload (see the catalogue). Null while pending or on most failures |
| `steps` | string[] | a human-readable trace of what the task did |
| `error` | string or null | why it failed, for example `timeout`, `no_match`, `login_not_verified`, `task_timeout: did not finish in 300 s` |
| `meta` | object | task-specific extras (counts, modes, hints, `cookies_applied`, `reasons`) |
| `job_id` | string or null | set in `async_mode`; poll `GET /v1/job/{job_id}` |
| `status` | string or null | `"pending"` in async mode; `"awaiting_approval"` when a login is paused for a human decision |
| `approval_id` | string or null | set with `status: "awaiting_approval"`; poll `GET /v1/approvals/{approval_id}` |

`evaluate_js` with a URL:

```json
{"session_id": "sess_3d245e9c250d4713b0f633ab34f018f0", "task": "evaluate_js",
 "params": {"url": "https://httpbin.org/html", "script": "document.querySelector('h1').textContent"}}
```

```json
{"session_id": "sess_3d245e9c250d4713b0f633ab34f018f0", "task": "evaluate_js", "ok": true, "data": {"value": "Herman Melville - Moby-Dick"}, "steps": ["navigated to https://httpbin.org/html", "evaluated script"], "error": null, "meta": {}, "job_id": null, "status": null, "approval_id": null}
```

`wait_and_extract` with a field map (`first_words` trimmed):

```json
{"session_id": "sess_3d245e9c250d4713b0f633ab34f018f0", "task": "wait_and_extract",
 "params": {"url": "https://httpbin.org/html", "wait_selector": "h1",
            "fields": {"heading": "h1", "first_words": "p"}, "timeout_ms": 10000}}
```

```json
{"session_id": "sess_3d245e9c250d4713b0f633ab34f018f0", "task": "wait_and_extract", "ok": true, "data": {"heading": "Herman Melville - Moby-Dick", "first_words": "Availing himself of the mild, summer-cool weather that now reigned in these latitudes, ..."}, "steps": ["selector 'h1' appeared", "extracted 2 field(s)"], "error": null, "meta": {"wait_selector": "h1", "mode": "flat"}, "job_id": null, "status": null, "approval_id": null}
```

`async_mode`, then the job poll. The script ran without a `url` on a session that had no page open, so the value is the blank tab's address:

```json
{"session_id": "sess_3d245e9c250d4713b0f633ab34f018f0", "task": "evaluate_js",
 "params": {"script": "location.href"}, "async_mode": true}
```

```json
{"session_id": "sess_3d245e9c250d4713b0f633ab34f018f0", "task": "evaluate_js", "ok": false, "data": null, "steps": [], "error": null, "meta": {}, "job_id": "sess_3d245e9c250d4713b0f633ab34f018f0.035cc5179b874715a04e64db260a33c3", "status": "pending", "approval_id": null}
```

`GET /v1/job/sess_3d245e9c250d4713b0f633ab34f018f0.035cc5179b874715a04e64db260a33c3`:

```json
{"session_id": "sess_3d245e9c250d4713b0f633ab34f018f0", "job_id": "sess_3d245e9c250d4713b0f633ab34f018f0.035cc5179b874715a04e64db260a33c3", "kind": "agent", "status": "done", "result": {"ok": true, "task": "evaluate_js", "data": {"value": "about:blank"}, "steps": ["evaluated script"], "error": null, "meta": {}}}
```

The job envelope is `session_id`, `job_id`, `kind` (`agent` here, `template` for a template job), `status` (`pending`, `done`, `error`, `cancelled`) and `result`, which is the task result once the job is done. The job keeps the session from idling out while it runs.

Errors:

| Status | `error` or `detail` | When |
|---|---|---|
| 400 | `unknown task '<name>'` | `task` is not in the catalogue: `{"detail": "unknown task 'nope'"}` |
| 400 | `unsafe url: ...` | a URL in `params` points at a non-public host |
| 401 | `Invalid API key` | bad or missing key |
| 402 | `insufficient_credits`, `quota_exceeded` | the wallet or the monthly plan allowance cannot cover one action |
| 404 | `No such session` | the session id does not exist or is not yours |
| 409 | `session not ready (state=...)`, `session browser is not alive ...` | the session is still starting or closing, or its browser died; create a new session |
| 409 | `approval not usable: ...` | `approval_id` is not approved, is for another credential or session, was already used, or expired |
| 410 | the session's closing record | the session has ended |
| 422 | `invalid_agent_params` | a required parameter is missing or blank; `fields` names them: `{"detail": {"error": "invalid_agent_params", "fields": ["wait_selector"]}}` |
| 422 | validation list | `params` is not an object or has more than 100 keys; a field has the wrong type |
| 429 | `rate_limited` | the per-key drive limit, counted across all servers; the body carries `limit`, `window_seconds` and `retry_after_seconds`, and the `Retry-After` header is set |

A task that fails inside the browser is not an HTTP error: the answer is 200 with `ok: false` and `error` set.

Notes:
- Deadline: 300 s per run. A task that does not finish answers `ok: false`, `error: "task_timeout: did not finish in 300 s"`.
- Serialisation: two calls on the same session run one after the other, so two scripts cannot clobber one tab.
- Billing: one action credit per successful run (`ok: true`); a failed run is not charged. In async mode the charge happens when the job completes.
- Secrets: a `login` run, or any task whose parameters carry a `vault://` reference, never places the secret in `steps`, `data` or `meta`.
- Tabs a task opens for itself are closed when it ends. The page your session was showing before the call stays as the task left it.

### Task catalogue

Required parameters are marked "required"; everything else is optional with the default shown. `url` always means "navigate there first".

| Task | Parameters | `data` on success and notable errors |
|---|---|---|
| `authenticated_fetch` | `url` required; `cookies` (object, list, or a `Cookie` header string) or `cookie`; `extract` `"auto"` | Applies the cookies before navigating, then reads the page: `{title, text, final_url}` or a parsed record. With no cookies given, the session your org stored for that site (from a vault login, or a saved or imported login) is applied instead. `meta.cookies_applied` is the count and `meta.cookies_source` is `caller`, `session_keeper` or `saved_auth`; cookie values are never returned. Detects a login wall and reports it |
| `captcha_gated_flow` | `max_attempts` 2 | Detects a CAPTCHA on the current page and tries to clear it: `{captcha, solved, attempts}`; `captcha` is `none` when there was nothing to solve. `ok: false` when it stayed |
| `click_by_text` | `text` required; `role`; `exact` false; `nth` 0 | Finds a button, link or widget by visible text (case-insensitive contains, or exact) and clicks it: `{text, tag, selector, index, count}`. Error `no_match` with `meta.count` candidates |
| `dismiss_popups` | `max_dismiss` 5 | Closes visible overlays and cookie banners: `{dismissed}`. Always `ok: true` |
| `download_file` | one of `url`, `link_selector`, `link_text`; `dest` | Resolves the download link and downloads it on the session's machine: `{href, dest, bytes, triggered}`. The file is named from the response's file name only (no directory parts), capped at 512 MB, follows at most 5 redirects, and non-public hosts are refused. The bytes are not returned; use `POST /v1/session/{id}/files/fetch` to get a file back. Errors `no download link found`, `could not trigger download` |
| `evaluate_js` | `script` required; `url` | Runs an expression or an arrow function in the page and returns its value: `{value}`. Errors `no_script`, `evaluate_failed: ...`, `navigate_failed: ...` |
| `extract_by_schema` | `schema` required (`{field: "selector"}` or `"selector@attr"`; add `"_item": "<row selector>"` for one record per row); `url` | Flat mode returns one object (a missing field is null). With `_item`, or when a repeating grid is detected from the selectors, returns a list; `meta.mode` is `flat` or `list`, `meta.auto_item` true when the grid was inferred. All-null answers carry a `meta.hint` explaining that schema values must be CSS selectors |
| `extract_table` | `table_selector` `"table"`; `which` `"auto"` (the largest table), `"all"`, or an index; `url` | The chosen table as header plus rows, or a list of every table with `"all"`. `meta.selected_index` says which was picked. Errors `no tables found`, `table index N out of range` |
| `fill_form` | `data` required (`{field: value}`); `submit` true; `form_index` 0; `url` | Fills a detected form by field name: `{fields_filled, submitted}`. Errors `no_form_data`, `no_form_found`, `fill_failed: ...` |
| `follow_link_by_text` | `text` required; `exact` false | Finds a link by its visible text and navigates to it. Error `no link matching text=...` |
| `handle_new_tab` | `trigger_selector` or `trigger_text`; `timeout_ms` 5000 | Clicks something that opens a new tab and captures it: `{url, title, snippet}`. When no tab opened, `meta.fallback` is `same_tab` and the original tab is reported |
| `infinite_scroll_collect` | `item_selector`; `max_scrolls` 20 (at most 40); `settle_ms` 400; `url`; `nav_timeout_ms` 60000 | Scrolls to the bottom repeatedly and collects items as they load; stops when the count stops growing for two scrolls, at the scroll cap, or at 5000 items |
| `login` | `username`, `password`, `totp` (a literal or a `vault://` reference); `url`; `user_selector`, `pass_selector`, `submit_selector`, `otp_selector`; `success_text`; `allow_hosts` (extra origins the credential may be typed into, for SSO) | Detects the login form, fills, submits and verifies: `{logged_in, final_url}`; `meta.reasons` lists the signals (`url_changed`, `account_marker`, `success_text`, `password_field_gone`). With no `username` and `password`, the credential your org stored for that host is used; error `no_credential_for_host` when there is none. Error `login_not_verified` when no signal was seen. A credential whose policy is `approval_required` pauses the call with `status: "awaiting_approval"` (see Approvals). Secrets are never placed in `steps`, `data` or `meta` |
| `multi_step_checkout` | `add_to_cart_selector`; `cart_url`; `checkout_selector`; `shipping` (`name`, `first_name`, `last_name`, `email`, `phone`, `address`, `address2`, `city`, `state`, `zip`, `country`, or any field name); `place_order` false | Adds to cart, opens the cart, proceeds to checkout and fills shipping: `{reached_step, placed}`. Never places an order unless `place_order` is `true` |
| `navigate_spa` | `link_text` or `link_selector`; `expect_url_contains`; `timeout_ms` 10000 | Clicks an in-app link and waits for a client-side route change: `{old_url, new_url, changed}`. Error `no_route_change` |
| `paginate_collect` | `item_selector`; `fields` (`{name: selector}` read relative to each item); `next_selector`; `max_pages` 10 (at most 50); `url`; `settle_ms` 200 | Walks a "next page" chain, collecting deduplicated items; stops when there is no next control, the page did not change, nothing new was found, or at the page cap. A first page with no items is retried and, when it stays empty because of a block, `meta.blocked` says so |
| `recon_site_api` | `url` required; `duration` 20 (seconds); `capture_bodies` false | Loads the page while capturing its network traffic and returns a report: API endpoints, auth signals, asset summary, counts by kind, incomplete calls and a rendered markdown summary |
| `screenshot_capture` | `url`; `full_page` false; `scroll_stitch` false; `max_segments` 20 | Returns the image: `{mode, bytes, dimensions, image_base64, content_type}`; with `scroll_stitch`, `segment_images` (a base64 list). Refuses to shoot a blank tab with `no_page_loaded: ...`; pass `url` or navigate first |
| `search_site` | `query` required; `url`; `input_selector`; `submit_selector`; `result_selector`; `timeout_ms` 15000 | Types the query into the site's search box, submits and collects the result links |
| `solve_press_and_hold` | `url`; `hold_ms` 3200; `attempts` 3 | Clears a "press and hold" challenge with a human-style pointer hold: `{detected, cleared, title}`; `detected: false` means there was no challenge |
| `upload_file` | `file_path` required (a path on the session's machine); `input_selector` `"input[type=file]"` | Sets a file on a file input: `{selector, file, set}`. Errors `no file input matching ...`, `could not set file input` |
| `wait_and_extract` | `wait_selector` required; `fields` (a schema as in `extract_by_schema`); `timeout_ms` 15000; `url` | Waits for the selector to appear, then returns the matched element's text, or the record or list described by `fields`. Error `timeout` |

### Vault references in task parameters

`login` accepts `vault://<kind>/<name>` in `username`, `password` and `totp` (for example `vault://password/github-com`). The reference is resolved to the stored secret at the moment of the fill and discarded afterwards; nothing of it reaches `steps`, `data` or `meta`. The referenced credential's declared host pins where it may be typed: a login page on another origin is refused unless you name that origin in `allow_hosts`. Credentials are created from the dashboard or through a connect link (see Credentials below), and listed with `GET /v1/credentials`, which returns the `path` you put after `vault://`.

# 18. Templates

A template is a packaged, reusable browser workflow with a declared input schema, written by the Tilion team, that runs in your session like an agent task. The same catalogue is exposed as MCP tools (`tilion_template_<name>`), so a template you can run over REST is also a tool a model can call.

## GET /v1/templates

The catalogue, with each template's input schema.

Auth: Bearer API key.

Request: optional query parameters `category` (one of `job-automation`, `data-extraction`, `form-filling`, `monitoring`, `research`, `commerce`, `other`) and `tag`.

Response:

| Field | Type | Meaning |
|---|---|---|
| `templates[]` | object[] | sorted by `name` |
| `templates[].name` | string | the slug you pass as `name` to `POST /v1/template` |
| `templates[].title`, `description` | string | what it does |
| `templates[].category`, `tags`, `author` | string, string[], string | catalogue facets |
| `templates[].tool_name` | string | the MCP tool name for the same template |
| `templates[].inputs` | object | a JSON Schema describing `params`; `required` lists what you must pass |

The current catalogue has two templates, both of which take a LinkedIn `li_at` session cookie (trimmed):

```json
{"templates": [
  {"name": "linkedin_extract", "title": "LinkedIn authenticated extraction", "description": "Authenticate a session to LinkedIn with an injected li_at cookie and extract everything the logged-in page exposes from a target URL: a profile, company page, search-results page, or the feed. ...", "category": "data-extraction", "tags": ["linkedin", "auth", "cookies", "extraction", "scraping"], "author": "@tilion", "tool_name": "tilion_template_linkedin_extract", "inputs": {"type": "object", "properties": {"li_at": {"type": "string", "description": "LinkedIn session cookie. DevTools > Application > Cookies > www.linkedin.com > li_at. Treat as a password."}, "target": {"type": "string", "description": "Any LinkedIn URL to extract as the logged-in user: a profile, a company page, a search-results URL, or the feed."}, "jsessionid": {"type": "string", "description": "Optional JSESSIONID. Quotes are stripped automatically. Only needed for write actions."}}, "required": ["li_at", "target"]}},
  {"name": "linkedin_session", "title": "LinkedIn authenticated session", "description": "Authenticate a session to LinkedIn with an injected li_at cookie and verify it is logged in. Returns authenticated=true/false plus the reason. Use this as the gate before any logged-in LinkedIn flow. ...", "category": "job-automation", "tags": ["linkedin", "auth", "cookies", "session"], "author": "@tilion", "tool_name": "tilion_template_linkedin_session", "inputs": {"type": "object", "properties": {"li_at": {"type": "string", "description": "LinkedIn session cookie."}}, "required": ["li_at"]}}
]}
```

Errors: 401 invalid key; 422 when a query parameter has the wrong type. Free, no session needed.

## POST /v1/template

Run a template by name in a session's browser. Same envelope, auth, limits and billing as `POST /v1/agent`.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `session_id` | string | required | the session whose browser runs the template |
| `name` | string | required | a slug from `GET /v1/templates` |
| `params` | object | `{}` | validated against the template's `inputs` schema before anything runs; at most 100 keys; URL values are checked for non-public hosts |
| `async_mode` | boolean | `false` | return `job_id` and `status: "pending"` now; poll `GET /v1/job/{job_id}` (`kind: "template"`) |

Response: the `POST /v1/agent` envelope. `task` echoes `name`, `steps` is always `[]` and `meta` always `{}`; `data` is the template's own result. `linkedin_session` returns `authenticated` (true or false) with a `reason` (`ok`, `cookie_not_applied`, `auth_wall`, `checkpoint`, `navigation_failed`), and `linkedin_extract` adds `target`, `final_url`, a best-effort structured `data` (name, headline, location, about, experience, education, skills, connections, followers, any JSON-LD, `page_type`), the page as `markdown`, and `raw_html_len`. On a template timeout the answer is `ok: false`, `error: "template_timeout: did not finish in N s"`.

A required input missing (no browser is touched):

```json
{"session_id": "sess_3d245e9c250d4713b0f633ab34f018f0", "name": "linkedin_session", "params": {}}
```

```json
{"detail": {"error": "invalid_template_params", "issues": [{"path": ["li_at"], "constraint": "required", "message": "required input is missing"}]}}
```

An unknown name:

```json
{"detail": "unknown template 'nope' — GET /v1/templates for the list"}
```

Errors:

| Status | `error` or `detail` | When |
|---|---|---|
| 400 | `unknown template '<name>' ...` | `name` is not in the catalogue |
| 400 | `unsafe url: ...` | a URL in `params` points at a non-public host |
| 402, 404, 409, 410, 429 | as for `POST /v1/agent` | quota, session, rate limit |
| 422 | `invalid_template_params` | `issues[]` lists each failing input with `path`, `constraint` (`required`, `type`, `unexpected_parameter`, ...) and `message`. Input values are never echoed |

Notes:
- Timeout: the template's declared limit, 180 s for both current templates, never more than 300 s.
- Billing: one action credit per run that finishes without a timeout.
- Validation happens before the session is looked up, so a bad body is refused in under half a second.

# 19. Skills

`POST /v1/task` states a goal against a domain and reads fields off a page. The first call for a given domain and goal derives a skill (the selectors and the wait signal that satisfy the goal) and stores it in your account's skill library; every later call with the same domain and goal replays that skill with no model call and no tokens. When a replay fails on a page that changed, the skill is healed where possible and the answer says so. Skills are shared across every server: whichever one answers your call sees the same library.

## POST /v1/task

Run a goal against a domain in your session's browser: replay the stored skill, or derive one.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `domain` | string | required | the site key the skill is stored under (`httpbin.org`); at most 253 characters |
| `goal` | string | required | the natural-language intent; the skill id is derived from domain plus goal; at most 2000 characters |
| `session_id` | string | required | an existing session to drive |
| `url` | string | null | the page to open for a cold derive; checked for non-public hosts |
| `binding` | object | required | `{field: "selector"}` or `"selector@attr"`; the fields to read. At most 200 entries |
| `wait_for` | object | null | a readiness signal, for example `{"type": "selector", "value": "h1"}` |
| `schema_keys` | string[] | null | the output field names you expect; at most 200 |
| `variables` | object | `{}` | values for `{slot}` placeholders in the goal; at most 200 |

Response:

| Field | Type | Meaning |
|---|---|---|
| `data` | object | the extracted fields, keyed as in `binding` |
| `decision` | string | `REPLAY` (a stored skill ran), `DERIVE` (a new skill was built and stored), `HEAL` (the stored skill was repaired first) |
| `success` | boolean | the fields were read |
| `from_cache` | boolean | true on a replay |
| `self_healed` | boolean | true when a heal was needed |
| `tokens_used` | integer | model tokens spent by this call (0 with an explicit binding) |
| `tokens_saved` | integer | the estimated derive cost a replay avoided |
| `skill_id` | string | `<domain>:<hash of the goal>` |
| `reason` | string | `hit`, `miss`, or why a heal or a failure happened |
| `vertical` | string or null | the detected site vertical (retail, travel, jobs, ...) when one is recognised |
| `archetype` | string or null | the interaction shape matched (a search-results grid, a detail page, ...) |
| `warm_start` | boolean | the derive was seeded from a known archetype |
| `guard_level` | string or null | how strictly the stored skill is checked on replay: `light`, `full` or `strict`, from its history |

A goal that already had a skill, `REPLAY`:

```json
{"domain": "httpbin.org", "goal": "read heading", "session_id": "sess_3d245e9c250d4713b0f633ab34f018f0",
 "url": "https://httpbin.org/html", "binding": {"heading": "h1"}, "schema_keys": ["heading"]}
```

```json
{"data": {"heading": "Herman Melville - Moby-Dick"}, "decision": "REPLAY", "success": true, "from_cache": true, "self_healed": false, "tokens_used": 0, "tokens_saved": 8000, "skill_id": "httpbin.org:c07f5df685", "reason": "hit", "vertical": null, "archetype": null, "warm_start": false, "guard_level": "full"}
```

A new goal, `DERIVE` (`paragraph` trimmed):

```json
{"domain": "httpbin.org", "goal": "read the first paragraph", "session_id": "sess_3d245e9c250d4713b0f633ab34f018f0",
 "url": "https://httpbin.org/html", "binding": {"paragraph": "p"}, "wait_for": {"type": "selector", "value": "h1"}}
```

```json
{"data": {"paragraph": "Availing himself of the mild, summer-cool weather that now reigned in these latitudes, ..."}, "decision": "DERIVE", "success": true, "from_cache": false, "self_healed": false, "tokens_used": 0, "tokens_saved": 0, "skill_id": "httpbin.org:5ad473bf3b", "reason": "miss", "vertical": null, "archetype": null, "warm_start": false, "guard_level": null}
```

Errors:

| Status | `detail` | When |
|---|---|---|
| 400 | `unsafe url: ...` | `url` points at a non-public host |
| 402 | `insufficient_credits`, `quota_exceeded` | wallet or plan allowance exhausted |
| 404 | `No such session` | unknown session or not yours |
| 409 | `session not ready ...`, `session browser not ready` | the session is starting, closing, or its browser died |
| 410 | the session's closing record | the session has ended |
| 422 | `provide a 'binding' ...` | no `binding` was given |
| 422 | `derived skill failed security gate: ...` | the derived skill would embed a credential or a dangerous navigation; it is not stored |
| 429 | `rate_limited` | the per-key drive limit |

Notes:
- A task that ran but read nothing answers 200 with `success: false` and null fields; check `success`, not the status code.
- The tab the task opens is closed afterwards; the page your session was showing is untouched.
- Billing: one action credit per call with `success: true`.

## GET /v1/skills

The skills stored for your account.

Auth: Bearer API key.

Response:

| Field | Type | Meaning |
|---|---|---|
| `skills[]` | object[] | one row per skill |
| `skills[].skill_id`, `domain`, `intent` | string | the id, the domain, and the goal it was derived for |
| `skills[].version` | integer | increments on a heal |
| `skills[].steps` | integer | recorded steps |
| `skills[].params`, `schema_keys` | string[] | the placeholders it takes and the fields it returns |
| `skills[].success_rate` | number | 0 to 1 over verified runs |
| `skills[].verified_runs` | integer | replays that succeeded |
| `skills[].derive_cost_tokens` | integer | what the derive cost, which is what each replay saves |
| `count` | integer | number of rows |

```json
{"skills": [{"skill_id": "httpbin.org:c07f5df685", "domain": "httpbin.org", "intent": "read heading", "version": 1, "steps": 2, "params": ["_plan"], "schema_keys": ["heading"], "success_rate": 1.0, "verified_runs": 11, "derive_cost_tokens": 8000}, {"skill_id": "httpbin.org:5ad473bf3b", "domain": "httpbin.org", "intent": "read the first paragraph", "version": 1, "steps": 3, "params": ["_plan"], "schema_keys": ["paragraph"], "success_rate": 1.0, "verified_runs": 0, "derive_cost_tokens": 8000}], "count": 2}
```

Errors: 401 only.

## GET /v1/determinism/stats

Replay statistics for your account: how much repeat work was served from stored skills.

Auth: Bearer API key.

Response:

| Field | Type | Meaning |
|---|---|---|
| `runs` | integer | `/v1/task` runs counted for your account |
| `cache_hits` | integer | runs answered by a replay |
| `hit_rate` | number | `cache_hits / runs` |
| `tokens_saved` | integer | the derive cost avoided across those replays |
| `usd_saved` | number | the same at list model prices |
| `skills` | integer | skills stored for your account |

```json
{"runs": 7, "cache_hits": 6, "hit_rate": 0.8571, "tokens_saved": 48000, "usd_saved": 0.996, "skills": 2}
```

Errors: 401 only.

# 20. Workflows

`POST /v1/workflow` runs a multi-step browser job in one call. It has two modes:

- Prompt mode: you pass a natural-language `prompt`; the model plans it, then drives the browser and the content tools in a loop until the plan's success criteria hold, the model says it is done, or a cap is hit. This mode spends model tokens and is billed per plan call and per step.
- Recording mode: you pass a Waystone `recording` (the `automation.json` a `waystone record` session wrote) and the values for its placeholders; the recorded steps are replayed in your session's browser with no model, zero tokens, and a step-by-step report. This is the deterministic way to automate a flow you can perform once by hand.

Exactly one of `prompt` or `recording` must be present.

## POST /v1/workflow

Auth: Bearer API key.

Request:

| Field | Type | Default | Mode | Meaning |
|---|---|---|---|---|
| `prompt` | string | null | prompt | the task in natural language, 1 to 8000 characters |
| `recording` | object | null | recording | a Waystone `automation.json`: the folder wrapper (with `workflow` inside), the CDP export (with `workflow` next to `run`), or a bare workflow (`name`, `start_url`, `steps`) |
| `session_id` | string | null | both | the session whose browser runs the job. Required with a recording; optional with a prompt |
| `params` | object of strings | `{}` | recording | values for the recording's `{{name}}` placeholders. A missing one is refused with 422 before the browser is touched |
| `until` | integer | null | recording | replay steps `0..until` inclusive, then stop |
| `return_markdown` | boolean | `false` | recording | include the page the replay ended on as markdown |
| `answers` | object | null | prompt | answers to the clarifications a previous `POST /v1/plan` asked |
| `max_records` | integer | null | prompt | override the plan's target count (sets the success criterion `min_records`) |
| `budget_tokens` | integer | null | prompt | a token ceiling for the run; checked after each step, so a run can end a little over it |
| `max_rows_in_response` | integer | 200 | prompt | cap on `dataset` rows returned, 1 to 5000; the full set is the run's artifact |

### Prompt mode

Response:

| Field | Type | Meaning |
|---|---|---|
| `plan` | object | the plan that was run, the same shape `POST /v1/plan` returns |
| `terminal` | string | why the run stopped: `completed` (success criteria held), `model_finished`, `step_cap`, `budget_exceeded`, `no_tools` (the model produced neither a tool call nor a finish), `no_data` (every source was blocked, empty or behind a login), `error` |
| `dataset` | object[] | the records collected, at most `max_rows_in_response` |
| `dataset_total`, `dataset_truncated` | integer, boolean | the full count and whether `dataset` was cut |
| `trace` | object[] | one entry per tool call: `tool`, `params`, `outcome`, and sizes such as `content_chars` |
| `steps` | integer | tool calls made |
| `tokens` | object | `in`, `out`, `total` |
| `result_text` | string | the model's closing text, often empty |

Request and answer (the `plan` object is trimmed to its top-level keys; it is the same shape as the `/v1/plan` example below):

```json
{"prompt": "Get the heading text from https://httpbin.org/html", "session_id": "sess_3d245e9c250d4713b0f633ab34f018f0",
 "max_records": 1, "budget_tokens": 4000, "max_rows_in_response": 5}
```

```json
{"plan": {"goal": "Get the heading text from https://httpbin.org/html", "task_type": "data_collection", "target": {"entity": "record", "count": null, "output_schema": ["heading_text", "url"], "constraints": ["url=https://httpbin.org/html"], "dedup_key": ["url"]}, "phases": "...", "success": {"min_records": 1, "required_fields": ["url"], "field_validity_min": 0.9, "unique_by": ["url"], "notes": "all record(s) matching url=https://httpbin.org/html"}, "estimate": {"plan_tokens": 448, "runtime_tokens": 0, "browser_seconds": 30.0, "egress_mb": 7.5, "est_usd": 0.01, "wall_clock_s": 8.0, "confidence": 0.5, "dominant_risk": "no scraper yet"}, "gaps": "...", "assumptions": "...", "clarifications": "...", "is_valid": true}, "terminal": "budget_exceeded", "dataset": [], "trace": [{"tool": "fetch_page", "params": {"url": "https://httpbin.org/html"}, "outcome": "ok", "content_chars": 3596}], "steps": 2, "tokens": {"in": 5937, "out": 97, "total": 6034}, "result_text": "", "dataset_total": 0, "dataset_truncated": false}
```

The run fetched the page in its first step and stopped at the token ceiling (6034 tokens against a budget of 4000, because the budget is checked after each step) before it emitted a record. A tiny budget is a way to cap spend on a probe; a real run needs a larger one.

Billing: one plan call plus one workflow step per tool call (2 credits each; `GET /v1/credits` has the current numbers). The run above was 2 + 2 x 2 = 6 credits. A run that ends in `terminal: "error"` bills the plan call only.

### Recording mode

How to record: run a Waystone recording session (`waystone record <url> -n <name>`), perform the task once in the browser it opens, and stop. Waystone writes a folder named after the recording with an `automation.json`; post that file's contents as `recording`. Values you typed can be turned into `{{placeholders}}` in the recording and supplied per run through `params`.

What the replay does: every step's target carries ranked selector candidates and a fingerprint of the element. For each step the page is left to settle for at least twice the time the recorder measured, the candidates are tried in order, the first that matches one visible element wins (several matches are ranked by fingerprint), and the action is delivered with real pointer and keyboard input. A step whose candidates all miss within 10 s fails the run and reports the candidate kinds it tried. Dialogs the page raises are accepted. Recorded secrets are scrubbed from the report.

Supported step types: `navigate`, `click`, `dblclick`, `type`, `press`, `select`, `check`, `set`, `hover`, `scroll`, `new-tab`, `switch-tab`, `dialog`, `wait`. Not supported, and reported rather than crashed: `drag`, `upload`, `print`, and any target located on a canvas (`terminal: "unsupported"`). A recording may have at most 500 steps.

Response:

| Field | Type | Meaning |
|---|---|---|
| `terminal` | string | `done`, `step_failed`, `unsupported` |
| `steps_run` | integer | steps that completed |
| `steps[]` | object[] | one per step attempted: `index`, `type`, `ok`, `resolved_by` (`kind`, `value`, `score`, and `fallback` when a programmatic click or value set was needed; null for steps with no target), `waited_ms` (settling and locating time inside the step), `url` (after the step) |
| `failed_step` | object or null | `index`, `type`, `reason`, `tried` (the candidate kinds attempted) |
| `final_url` | string | where the tab ended |
| `markdown` | string or null | the final page as markdown when `return_markdown` is true |
| `name` | string | the recording's name |
| `tokens` | object | always `{"in": 0, "out": 0, "total": 0}` |
| `plan`, `dataset`, `trace`, `dataset_total`, `dataset_truncated` | null, [], [], 0, false | present so a prompt-mode consumer can read either answer |

A `wikipedia_search` recording (searches Wikipedia for a topic, waits for the article, opens its Talk page), abbreviated to its first step; `markdown` trimmed:

```json
{"recording": {"waystone": 2, "name": "wikipedia_search", "start_url": "https://en.wikipedia.org/wiki/Main_Page", "params": ["query"],
               "workflow": {"name": "wikipedia_search", "start_url": "https://en.wikipedia.org/wiki/Main_Page",
                            "steps": [{"index": 0, "type": "navigate", "url": "https://en.wikipedia.org/wiki/Main_Page", "settle_ms": 850}, "...[5 more steps: type {{query}}, press Enter, navigate, wait, click]"]}},
 "params": {"query": "Python (programming language)"},
 "session_id": "sess_3d245e9c250d4713b0f633ab34f018f0", "return_markdown": true}
```

```json
{"terminal": "done", "steps_run": 6, "steps": [{"index": 0, "type": "navigate", "ok": true, "resolved_by": null, "waited_ms": 0, "url": "https://en.wikipedia.org/wiki/Main_Page"}, {"index": 1, "type": "type", "ok": true, "resolved_by": {"kind": "css", "value": "input[name=\"search\"]", "score": 0.8}, "waited_ms": 303, "url": "https://en.wikipedia.org/wiki/Main_Page"}, {"index": 2, "type": "press", "ok": true, "resolved_by": null, "waited_ms": 445, "url": "https://en.wikipedia.org/wiki/Python_(programming_language)"}, {"index": 3, "type": "navigate", "ok": true, "resolved_by": null, "waited_ms": 856, "url": "https://en.wikipedia.org/wiki/Python_(programming_language)"}, {"index": 4, "type": "wait", "ok": true, "resolved_by": {"kind": "css", "value": "#firstHeading", "score": 0.9}, "waited_ms": 711, "url": "https://en.wikipedia.org/wiki/Python_(programming_language)"}, {"index": 5, "type": "click", "ok": true, "resolved_by": {"kind": "role", "value": "link:Talk", "score": 0.9166666666666666}, "waited_ms": 303, "url": "https://en.wikipedia.org/wiki/Talk:Python_(programming_language)"}], "failed_step": null, "final_url": "https://en.wikipedia.org/wiki/Talk:Python_(programming_language)", "markdown": "# Talk:Python (programming language)\n\n...", "tokens": {"in": 0, "out": 0, "total": 0}, "plan": null, "dataset": [], "trace": [], "name": "wikipedia_search", "dataset_total": 0, "dataset_truncated": false}
```

An unsupported step (a bare workflow with one `drag` step):

```json
{"terminal": "unsupported", "steps_run": 0, "steps": [{"index": 0, "type": "drag", "ok": false, "resolved_by": null, "waited_ms": 303, "url": "https://example.com/"}], "failed_step": {"index": 0, "type": "drag", "reason": "drag steps are not supported by workflow replay", "tried": ["css"]}, "final_url": "https://example.com/", "markdown": null, "tokens": {"in": 0, "out": 0, "total": 0}, "plan": null, "dataset": [], "trace": [], "name": "workflow", "dataset_total": 0, "dataset_truncated": false}
```

Errors (both modes):

| Status | `detail` | When |
|---|---|---|
| 400 | `unsafe url: ...` | prompt mode: the model chose a URL on a non-public host; the fetch is refused |
| 402 | `insufficient_credits`, `quota_exceeded` | before any model call |
| 404 | `No such session` | unknown session or not yours |
| 409 | `session browser is not alive` | the session's browser died |
| 410 | the session's closing record | the session has ended |
| 422 | `pass exactly one of prompt or recording` | neither or both given |
| 422 | `a recording replays on a session's browser: pass session_id` | a recording without `session_id` |
| 422 | `recording: ...` | the recording cannot be run: no steps, no `start_url`, more than 500 steps, an unknown step type, a target with no candidates |
| 422 | `missing params: <names>` | a `{{placeholder}}` has no value in `params`: `{"detail": "missing params: query"}` |
| 429 | `rate_limited` | the per-key drive limit |

A failed or unsupported step is not an HTTP error: the answer is 200 with `terminal` and `failed_step` set, and the steps that ran are reported.

Notes:
- Timing: the Wikipedia recording replays in 13 to 15 s; most of it is the page's own load and settle time.
- Billing: one workflow step per step that ran (2 credits each), no plan call, no tokens. The six-step run above was 12 credits; the `drag` run was free (nothing ran).
- `until` lets you replay part of a recording, for example to reach a logged-in page and then take over with `/v1/agent` tasks on the same session.

# 21. Plans

## POST /v1/plan

Compile a prompt into a plan without running it. A plan is a typed description of the job: the goal, the target entity and output schema, phases of sub-tasks with their executors, success criteria, a cost estimate, the gaps (sources with no scraper yet), the assumptions made, and clarifying questions you can answer in a follow-up `answers` object (to this route or to `POST /v1/workflow`).

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | string | required | the task, 1 to 8000 characters |
| `answers` | object | null | answers to a previous plan's `clarifications`, keyed by what each one `resolves` |

Response:

| Field | Type | Meaning |
|---|---|---|
| `goal` | string | the prompt as understood |
| `task_type` | string | for example `data_collection` |
| `target` | object | `entity`, `count`, `output_schema`, `constraints`, `dedup_key` |
| `phases[]` | object[] | `name`, `parallel`, `subtasks[]` (`intent`, `executor` with `kind` and `ref`, `inputs`, `outputs`, `expected_rows_band`, `expected_success_rate`, `cost_per_run_credits`, `fallback`) |
| `success` | object | `min_records`, `required_fields`, `field_validity_min`, `unique_by`, `notes` |
| `estimate` | object | `plan_tokens`, `runtime_tokens`, `browser_seconds`, `egress_mb`, `est_usd`, `wall_clock_s`, `confidence`, `dominant_risk` |
| `gaps[]` | object[] | `what`, `for_subtask`, `blocker` |
| `assumptions` | string[] | what the planner assumed |
| `clarifications[]` | object[] | `question`, `resolves`, `why`, `options` |
| `is_valid` | boolean | the plan's phases are consistent |

Request and answer (phases trimmed to the first sub-task of each):

```json
{"prompt": "Find the current price of the Kindle Paperwhite on amazon.com"}
```

```json
{"goal": "Find the current price of the Kindle Paperwhite on amazon.com", "task_type": "data_collection", "target": {"entity": "listing", "count": null, "output_schema": ["product_name", "price", "currency", "availability", "url"], "constraints": ["site=amazon.com", "product=Kindle Paperwhite"], "dedup_key": ["url"]}, "phases": [{"name": "discover_sources", "parallel": false, "subtasks": [{"intent": "find sources holding listings", "executor": {"kind": "search", "ref": "...", "params": {}}, "inputs": [], "outputs": ["candidate_sources"], "expected_rows_band": [0, 0], "expected_success_rate": 0.0, "cost_per_run_credits": 0.0, "fallback": null}]}, {"name": "select", "parallel": false, "subtasks": [{"intent": "rank candidate sources by coverage × our success ÷ cost", "executor": {"kind": "transform", "ref": "select_sources", "params": {}}, "inputs": ["candidate_sources"], "outputs": ["selected_sources"], "expected_rows_band": [0, 0], "expected_success_rate": 0.0, "cost_per_run_credits": 0.0, "fallback": null}]}, {"name": "collect", "parallel": true, "subtasks": ["..."]}, {"name": "dedupe", "parallel": false, "subtasks": ["..."]}, {"name": "validate", "parallel": false, "subtasks": ["..."]}, {"name": "assemble", "parallel": false, "subtasks": ["..."]}], "success": {"min_records": 1, "required_fields": ["url"], "field_validity_min": 0.9, "unique_by": ["url"], "notes": "..."}, "estimate": {"plan_tokens": 448, "runtime_tokens": 0, "browser_seconds": 30.0, "egress_mb": 7.5, "est_usd": 0.01, "wall_clock_s": 8.0, "confidence": 0.5, "dominant_risk": "no scraper yet"}, "gaps": ["..."], "assumptions": ["..."], "clarifications": ["..."], "is_valid": true}
```

Errors:

| Status | `detail` | When |
|---|---|---|
| 402 | `insufficient_credits`, `quota_exceeded` | before the model call |
| 422 | validation list | `prompt` missing, empty or over 8000 characters |
| 429 | `rate_limited` | the per-key drive limit |

Notes:
- Timing: 2 to 3 s; one model call.
- Billing: one plan call (2 credits) when the model produced the plan. When no model is available the planner falls back to a zero-token heuristic, says so in `assumptions`, and is not billed.
- No session is needed; nothing is executed.

## GET /v1/plan/health

Whether planning uses a model.

Auth: Bearer API key.

Response: `ok` (always true when the route answers), `understander` (`llm` or `heuristic`), `provider` (the model provider, or null in heuristic mode).

Errors: 401 only.

# 22. Credentials, connect links, verifications and approvals

The credential vault stores your organisation's site logins (passwords and authenticator seeds) encrypted, so an agent can log in with a `vault://` reference and never see the secret. The REST surface below is read-and-status only: no route ever returns a secret, a code, or a connect token, not even to the caller that created it. Credentials are created, edited and deleted from the dashboard, or captured from the person who owns the login through a connect link. Second-factor codes come in through verifications, and a credential whose policy is `approval_required` pauses the login until a member approves it in the dashboard.

## GET /v1/credentials

List the credentials stored for your organisation, metadata only.

Auth: Bearer API key. No body.

Response:

| Field | Type | Meaning |
|---|---|---|
| `credentials[]` | object[] | newest first |
| `credentials[].id` | string | the credential id |
| `credentials[].kind` | string | `password`, `totp`, or `cookie` |
| `credentials[].name` | string | the name chosen at creation (a connect link uses the host with dots replaced by dashes) |
| `credentials[].host` | string or null | the site it is pinned to |
| `credentials[].path` | string | `<kind>/<name>`; the `vault://` reference is `vault://` plus this path |
| `credentials[].policy` | string | `auto` or `approval_required` |
| `credentials[].grant_scope` | string | `once`, `session` or `ttl`: how long an approval or a resolve stays valid |
| `credentials[].ttl_seconds` | integer or null | the grant lifetime for `ttl` |
| `credentials[].risk_tier` | string or null | the tier assigned at creation |
| `credentials[].status` | string | `active`, `revoked`, or `needs_reauth` |
| `credentials[].created_at`, `updated_at` | string | ISO timestamps |

With nothing stored:

```json
{"credentials": []}
```

Errors: 401; 502 when the credential store did not answer.

Free. Ask this before attempting a `login` so an agent knows whether a credential for the host already exists instead of asking a person for a password.

## GET /v1/credentials/{cred_id}

One credential's metadata (the fields listed above).

Auth: Bearer API key.

Errors: 404 `credential not found` for an unknown or malformed id, or another organisation's (not distinguished); 401.

## DELETE /v1/credentials/{cred_id}

Revoke a credential everywhere: the row is deleted first, then every live session that used it is signed out and the cookies captured from its logins are forgotten.

Auth: Bearer API key.

Response: `{"ok": true, "id": "<cred_id>", ...}` plus counts of what the revocation reached (sessions touched, cookie jars deleted).

Errors: 404 `credential not found`; 401.

## POST /v1/credentials/connect

Mint a one-time capture link for a host. You post the link to the person who owns the login; they open it, enter the username and password (or an authenticator key) on a page served by Tilion, and the credential lands in your organisation's vault pinned to that host. The token is in the URL only: it is returned once and never stored or shown again.

Auth: Bearer API key. The key must belong to an organisation account (one created through the dashboard sign-up).

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `host` | string | required | the site the credential is for, for example `github.com` |
| `user_id` | string | null | bind the link to one dashboard user; anyone else who opens it voids it |
| `session_id` | string | null | the session that hit the login, recorded on the link |
| `kinds` | string[] | `["password"]` | what the page asks for: `password`, `totp` |
| `reason` | string | null | shown on the capture page |

Response: `connect_id`, `connect_url` (the link to post), `host`, `expires_at`. A link lives 15 minutes and completes once.

Errors:

| Status | `detail` | When |
|---|---|---|
| 400 | `host is required` | no `host` |
| 400 | `connect links need an org account: this key is not owned by an org` | the key has no organisation to bind the credential to; sign up on the dashboard and mint a key there |
| 400 | other messages | `host` or `kinds` not accepted |

Free. The capture page itself (`GET /connect/{token}`) needs no API key; it is plain HTML, never echoes what was typed, and answers 404 for a link that is unknown, used, expired or voided. A link minted for one dashboard user and opened by another is voided (403).

## GET /v1/credentials/connect/{connect_id}

Poll a link you minted. Status only.

Auth: Bearer API key (the same organisation that minted it).

Response: `connect_id`, `status` (`pending`, `completed`, `expired`, `voided`), `host`, `credential_id` (set once completed; use it with `GET /v1/credentials` to find the `path`), `expires_at`, `session_id`.

Errors: 404 `connect link not found` for an unknown id or another organisation's link (the two are not distinguished).

## GET /v1/verifications

The pending second-factor verifications for your organisation, so an agent or a dashboard can show the inbox.

Auth: Bearer API key.

Response: `verifications[]`, each with the fields of `GET /v1/verifications/{id}` below. Expired rows are dropped before the list is answered.

```json
{"verifications": []}
```

## GET /v1/verifications/{verification_id}

Poll one verification. The code is never returned.

Auth: Bearer API key.

Response:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | the verification id |
| `status` | string | `pending`, `resolved`, `expired`, `failed` |
| `host` | string | the site that asked for the code |
| `rung` | string or null | which channel produced the outcome (a stored authenticator seed, or a code forwarded through the API) |
| `expires_at` | string | when a pending verification lapses |
| `session_id` | string or null | the session whose login is waiting |

Errors: 404 `verification not found` for an unknown id or another organisation's row.

## POST /v1/verifications/{verification_id}/code

Submit the one-time code for a pending verification. A login that stopped at a second factor claims the code exactly once and types it; the code is stored encrypted and never returned.

Auth: Bearer API key.

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `code` | string | required | the one-time code |
| `channel` | string | `api` | where the code came from, for your audit trail |

Response: `{"id": "<verification_id>", "status": "resolved"}`.

Errors:

| Status | `detail` | When |
|---|---|---|
| 404 | `verification not found` | unknown id or not yours |
| 409 | `verification not pending: <why>` | the verification exists but is already resolved, expired or failed |
| 422 | `code is required` | empty or missing `code` |

## GET /v1/approvals/{approval_id}

Poll a login approval. When a `login` task uses a credential whose policy is `approval_required`, the task answers at once with `ok: false`, `status: "awaiting_approval"` and an `approval_id` (in `async_mode`, the same fields appear in the job's `result`). A member of your organisation approves or denies it in the dashboard, which can show the paused session through `live_view_url`. You poll here, and when the status is `approved` you call `POST /v1/agent` again with the same `login` parameters plus `approval_id`; the approval is spent by that call, is bound to the credential and session it was granted for, and expires if unused.

Auth: Bearer API key (the organisation that owns the approval). Deciding is a dashboard action.

Response:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | the approval id |
| `status` | string | `pending`, `approved`, `denied`, `expired`, `consumed` (already used to resume a login) |
| `expires_at` | string | when a pending approval lapses |
| `job_id` | string or null | the paused job, for a login started in `async_mode` |
| `live_view_url` | string or null | a read-only live view of the paused session, for the approver |

Errors: 404 `approval not found` for an unknown or malformed id, or another organisation's approval. A resume with an approval that is not `approved`, is for another credential or session, or has expired is refused by `POST /v1/agent` with 409 `approval not usable: <why>`.

Free. Two concurrent resumes with the same approval cannot both succeed; the second sees `consumed`.

# 23. Session sidecar

A sidecar is a small program of yours (one Node or Python file, or a gzip tarball with an entry file) that runs inside the session's virtual machine, next to the browser, for the life of the session. It is for logic that needs to sit on the browser's side of the network: inside the VM it finds the browser's CDP address in the `TILION_CDP_URL` environment variable and must listen for HTTP on the port in `PORT`; the passthrough route below is the only way in or out, since the sidecar has no network of its own. The feature is enabled per account; a key without it answers 403 `sidecar_not_enabled` on every sidecar route.

## PUT /v1/session/{session_id}/sidecar

Upload and start the session's sidecar.

Auth: Bearer API key (`sessions:write`).

Request:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `runtime` | string | required | `node` or `python` |
| `entry` | string | required | the file to run, 1 to 200 characters |
| `bundle_b64` | string | required | base64 of the source file or of a gzip tarball containing `entry`; up to 3,000,000 characters (about 2.2 MB) |

Response: `{"session_id": "...", "state": "..."}`.

Errors: 403 `sidecar_not_enabled`; 404 or 410 for a session that is not yours or has ended; 409 `sidecar_unavailable` (`this session has no sidecar slot (create a new session)`); 422 `bundle_b64 is not base64`, 422 `sidecar_start_failed` with the runner's message, or a 422 validation list for a bad `runtime` or `entry`.

## GET /v1/session/{session_id}/sidecar

The sidecar's state. Add `?log=true` for its output so far in `log`.

Auth: Bearer API key.

On a session with no sidecar:

```json
{"session_id": "sess_3d245e1dc50046628f3573aa7d79f8dc", "state": "idle", "error": null}
```

| Field | Meaning |
|---|---|
| `state` | `idle` until you start one; after a start, the runner's state for your program |
| `error` | the runner's error text when the program failed, else null |
| `log` | with `?log=true`, the program's output so far |

Errors: 403 `sidecar_not_enabled`; 409 `sidecar_unavailable`; 404 or 410 for the session.

## DELETE /v1/session/{session_id}/sidecar

Stop the sidecar. The session keeps running. Answers `204 No Content`.

Errors: 403, 409, 404 or 410 as above.

## GET, POST, PUT, PATCH, DELETE /v1/session/{session_id}/sidecar/http/{path}

Call your sidecar's own HTTP API. The path after `/http/`, the query string, the body and the `Content-Type` and `Accept` headers pass through; the sidecar's status, body and content type come back as it wrote them. A call may run for up to 300 seconds.

Auth: Bearer API key with `sessions:write`, for every method including GET.

With no sidecar running:

```json
{"detail": {"error": "sidecar_unreachable", "message": "the sidecar is not answering on its PORT"}}
```

Errors: 502 `sidecar_unreachable` when nothing is listening on the port (not started, crashed, or still starting); 403 `sidecar_not_enabled`; 409 `sidecar_unavailable`; 404 or 410 for the session.

# 24. MCP server

The hosted Model Context Protocol server gives any MCP client the same browser the REST API gives you, as tools: open and read pages, fill and click, collect datasets, manage logins, with a live view the user can watch. Every tool call is a REST call underneath, so it is owner-scoped, metered and rate limited exactly as the equivalent route.

## Endpoint and transport

- URL: `https://back.tilion.dev/mcp/`. `https://back.tilion.dev/mcp` answers 307 to the slash form, so configure the slash form.
- Transport: streamable HTTP, stateless. Each JSON-RPC message is a `POST /mcp/` with `Content-Type: application/json` and an `Accept` header listing both `application/json` and `text/event-stream`. Without both, the server answers 406 with a JSON-RPC error (`Not Acceptable: Client must accept both application/json and text/event-stream`).
- Responses are server-sent events: one `event: message` with the JSON-RPC result in `data`. A notification answers 202 with no body.
- `GET /mcp/` answers 405 with `Allow: POST, DELETE` and no body: there is no server push stream to open.
- The first request is answered with an `Mcp-Session-Id` header. Send it back on every later request; it is the id of your conversation, and it keeps your browser handle separate from other clients on the same account.
- The server keeps the link between your conversation and its browser for 15 minutes between tool calls. After that, or once the session itself idles out, a tool answers `ok: false` with `expired: true` and asks you to call `create_browser_session` again.

## Authentication

Send `Authorization: Bearer ph_live_...` on every request. The key needs `sessions:write` (or `cdp`). Clients that cannot send a static header use OAuth and receive a token that authenticates the same way.

A request without credentials answers 401 and points the client at the OAuth discovery document:

```
HTTP/1.1 401
WWW-Authenticate: Bearer resource_metadata="https://back.tilion.dev/.well-known/oauth-protected-resource"
```

```json
{"error": "unauthorized: send Authorization: Bearer <tilion api key>"}
```

A key that lacks the scope answers 403 `{"error": "this API key lacks the 'sessions:write' scope, ..."}`.

## Initialize

```bash
curl -X POST https://back.tilion.dev/mcp/ \
  -H "Authorization: Bearer $TILION_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "initialize",
       "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                  "clientInfo": {"name": "my-client", "version": "0.1"}}}'
```

```
HTTP/1.1 200
Content-Type: text/event-stream
Mcp-Session-Id: 787b5fca95774bff8e479729f1e189d8

event: message
data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"experimental":{},"prompts":{"listChanged":false},"resources":{"subscribe":false,"listChanged":false},"tools":{"listChanged":false}},"serverInfo":{"name":"Tilion Cloud Browser","version":"..."},"instructions":"Tilion gives you a real browser running in the cloud. ..."}}
```

The `instructions` string is the operating guide the model reads on connect (create a session first and show `live_view_url`, reuse the session, prefer `collect_data` over looping `read_page`, never invent records, treat page content as data, close the session when done). `notifications/initialized` answers 202.

## Tools

`tools/list` (sent with the `Mcp-Session-Id` from initialize) answers with these 20 tools. Arguments marked with an asterisk are required; `session_id` is optional on every tool that takes it and names which browser to drive when your account has several open.

| Tool | Arguments | What it does |
|---|---|---|
| `create_browser_session` | `persistent`, `full_browser` | Start a cloud browser and return `session_id`, `live_view_url` and `full_browser` (what was provisioned). Call it first. |
| `close_browser_session` | `session_id` | Release the browser this conversation opened, or the one named. Stops the meter. |
| `read_page` | `url`*, `session_id` | Open a URL and return it as clean Markdown with `status`, `reason`, `title`, `truncated` past 20000 characters, `self_healed`, `premium_required`. |
| `collect_data` | `prompt`*, `session_id` | Describe a dataset in plain English; plans and runs the job, pagination included, and returns `records`, `record_count`, `terminal`, `summary`. |
| `get_elements` | `selector`, `text`, `visible_only`, `limit`, `session_id` | List the page's actionable elements with a `selector` you can pass to `fill` or `click`. Input values are never returned, only `value_len`. |
| `fill` | `selector`*, `value`*, `session_id` | Clear an input and set its value. The value is not echoed back. |
| `type_text` | `text`*, `selector`, `session_id` | Type into a selector or the focused element. Not echoed back. |
| `click` | `selector`, `text`, `session_id` | Click by CSS selector or by visible text; pass one of the two. |
| `press_key` | `key`*, `session_id` | Send a key or combo: `Enter`, `Tab`, `Escape`, `Control+V`. |
| `scroll` | `pixels`, `session_id` | Scroll vertically; negative is up. |
| `set_clipboard` | `text`*, `session_id` | Put text on the session clipboard for a human to paste in the live view. Not echoed back. |
| `screenshot` | `full_page`, `selector`, `session_id` | Return the current page as an image, the whole page, or one element. |
| `login` | `url`*, `session_id` | Sign in to a site with the credential stored for its host. Takes and returns no secret. |
| `credential_list` | `host` | Stored sign-ins as metadata only (`name`, `kind`, `host`, `path`, `status`, `risk_tier`). |
| `credential_connect` | `host`*, `reason` | Mint a secure link the user opens to enter a sign-in; returns `connect_id`, `connect_url`, `expires_at`. |
| `credential_wait` | `connect_id`, `verification_id`, `timeout_s` | Wait for the user to finish a connect link or supply a one-time code. |
| `save_login` | `domain`*, `session_id` | Remember the current session's login for a domain so later sessions start signed in. |
| `import_login` | `domain`*, `token`*, `cookie_name` | Bring your own session cookie for a domain. |
| `list_logins` | | Domains with a saved login. |
| `delete_login` | `domain`* | Forget a saved login. |

A tool that fails answers `ok: false` with an `error` the model can act on: out of credits or over quota (402), a missing scope (403), rate limited (429), or the HTTP status and message otherwise.

## OAuth

Clients that connect through OAuth (claude.ai and Claude Desktop connectors, for example) discover the server from two documents and never see an API key.

```bash
curl https://back.tilion.dev/.well-known/oauth-authorization-server
```

```json
{
  "issuer": "https://back.tilion.dev",
  "registration_endpoint": "https://back.tilion.dev/oauth/register",
  "authorization_endpoint": "https://back.tilion.dev/oauth/authorize",
  "token_endpoint": "https://back.tilion.dev/oauth/token",
  "scopes_supported": ["cdp"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "none"],
  "code_challenge_methods_supported": ["S256"]
}
```

```bash
curl https://back.tilion.dev/.well-known/oauth-protected-resource
```

```json
{
  "resource": "https://back.tilion.dev/mcp",
  "authorization_servers": ["https://back.tilion.dev"],
  "scopes_supported": ["cdp"],
  "bearer_methods_supported": ["header"]
}
```

The same document is served at `/.well-known/oauth-protected-resource/mcp`, the path-specific location spec-following clients try first.

The flow, as a client runs it:

1. `POST /oauth/register` with `{"redirect_uris": [...], "client_name": "...", "token_endpoint_auth_method": "none" | "client_secret_post"}`. Answers 201 with `client_id`, the registered URIs, `grant_types` and `response_types`, plus `client_secret` once for a confidential client. Redirect URIs must be `https`, or `http` on `localhost`, `127.0.0.1` or `[::1]`, with no fragment; anything else answers 400. Registration is unauthenticated and throttled per address.
2. `GET /oauth/authorize?response_type=code&client_id=...&redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256&scope=cdp`. PKCE with S256 is mandatory and `cdp` is the only scope. An unknown client or an unregistered redirect URI stops on an error page; other mistakes bounce to the redirect URI with `error` and `error_description`. A valid request sends the user to a consent page on the same host where they sign in with an emailed code and approve what the client gets: open and control a browser in their account, read what it visits, and spend their credits.
3. The client is redirected back with `code` and `state`.
4. `POST /oauth/token` as a form with `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id` and, for a confidential client, `client_secret`. Codes are single use and bound to the client and redirect URI. The answer carries an access token (`mcpt_...`) and a refresh token; `grant_type=refresh_token` rotates them, and a refresh token is single use. Errors are 400 or 401 with `error` and `error_description` in the OAuth vocabulary (`invalid_client`, `invalid_grant`, `unsupported_grant_type`).
5. The access token goes in `Authorization: Bearer mcpt_...` on `/mcp/` and on the REST API, where it carries the `cdp` scope. Revoke it from API keys in the dashboard.

## Client configuration

Claude Code:

```bash
claude mcp add --transport http tilion https://back.tilion.dev/mcp/ \
  --header "Authorization: Bearer ph_live_..."
```

Cursor (`.cursor/mcp.json`, per project or global):

```json
{
  "mcpServers": {
    "tilion": {
      "url": "https://back.tilion.dev/mcp/",
      "headers": {"Authorization": "Bearer ph_live_..."}
    }
  }
}
```

Claude Desktop and claude.ai: add a custom connector with the URL `https://back.tilion.dev/mcp/`. The client discovers the OAuth documents above, registers itself, opens the consent page for you to sign in and approve, and stores its own token; no key is pasted. The same connector dialog revokes it.

Any other client that supports streamable HTTP with a static header works with the URL and the `Authorization` header above.
