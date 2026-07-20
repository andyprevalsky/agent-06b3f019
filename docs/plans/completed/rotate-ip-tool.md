# `rotate_ip` — model-driven proxy/IP rotation for the browser agent

## Goal

Give the v3 browser agent a single LLM-callable tool, **`rotate_ip`**, that
replaces the browser session's outbound IP when the current one is being
blocked or rate-limited. Rotation follows a fixed escalation ladder driven by
call count, is capped at **4 rotations per browser sub-agent run**, and returns
its escalation state to the agent so the model can reason about when to stop.

No automatic detection layer, no geo change, no user-facing surface. The model
is the detector (it sees the rendered block/captcha page); the harness is the
executor.

## Context / why this is needed

Today there is **no mid-session proxy recovery**. Proxy logic
(`back-end/src/providers/browser/kernelProxy.ts`, `kernel.ts`) is geo-driven and
only relaxes location specificity at *session-creation* time
(`createWithManagedProxy`, `kernel.ts:232`). Once the agent is connected over
CDP, a bad exit IP is unrecoverable — the run just fails against a rate-limit or
anti-bot wall.

Key facts that shape the design (established from the SDK + code):

- Kernel proxies are **residential**, keyed per geo (`residential:<COUNTRY>:<STATE>:<CITY>`),
  cached in `BrowserProviderProxy` and **shared across all agents in that
  region** (`getOrCreateKernelProxy`, `kernelProxy.ts:97`). The `proxy_id` is a
  **pool selector, not an IP** — the SDK states the residential *"exit node
  varies between requests"* (`node_modules/@onkernel/sdk/resources/proxies.d.ts:29`).
  So concurrent agents do **not** share an egress IP; they share a pool config.
- A browser session has **exactly one egress IP for all hosts** — you cannot
  rotate per-host within a session. Rotation is therefore a **session-global**
  act.
- "Rotate to a fresh IP on the same live session" is not a Kernel primitive.
  A rotation = **new `browsers.create` on the same profile**, which draws a new
  exit node, then reconnect the live CDP connection to the new `ws_url`.
- Automatic 429 detection is brittle: most IP blocks arrive as 200-status
  challenge pages, captchas, or silent throttling, **not** clean 429s with
  `Retry-After`. The model looking at the page is the better detector — hence a
  tool, not a classifier.

## Design (locked)

### Escalation ladder — cap 4 per browser sub-agent run

| Call | Backend action | Tier | Region | Login preserved |
|------|----------------|------|--------|-----------------|
| 1–2 | recycle session, **same residential pool** + profile → fresh exit IP | residential | unchanged | yes |
| 3–4 | recycle session, **mobile carrier** proxy, same geo config (flag-gated) | mobile | unchanged\* | yes |
| 5+  | no rotation — tool returns `PROXY_ROTATION_EXHAUSTED` error to the run | — | — | — |

\* Mobile carrier routing *"can make observed geo vary"*
(`proxies.d.ts` `MobileProxyConfig`), but we never *intentionally* relocate the
region — geo config (`country/state/city`) is preserved across every tier. This
removes the "is this flow geo-sensitive?" judgment entirely.

- **Mobile is gated** by `KERNEL_MOBILE_FALLBACK_ENABLED`. When disabled, calls
  3–4 are additional residential recycles (cap still 4), then exhaustion.
- **Mobile pool availability** reuses the existing city→state→country relaxation
  (`createWithManagedProxy`) so an unavailable city-level mobile pool relaxes
  rather than fails.
- Every rotation **preserves the Kernel profile** → cookies/login survive; only
  the egress IP changes. In-progress unsubmitted form state on the current page
  is lost (documented in the tool description).

### Escalation key = the browser sub-agent run

The counter + current tier are keyed to the **stable `BrowserSession.id`
(taskId)**, which survives recycles (resume updates `sessionId`/`wsUrl` but keeps
the row `id`, `kernel.ts:381`). Rationale for rejecting the alternatives:

- **Kernel `session_id`** changes on every rotation → resetting the counter each
  rotate makes the cap meaningless. ✗
- **Per host / auth realm** doesn't map to the rotated resource — one egress IP
  serves all hosts, so a per-host budget is a lie. Budget fairness across sites
  is handled by the budget **resetting on each new browser spawn**, not per-host. ✗
- **Per profile/context** persists across many runs (days) — far too broad. ✗

The cap is enforced **server-side and atomically**, not in agent-loop memory
(a Temporal retry could reset in-memory state — rule 20). Persist
`proxyRotationCount` (int) + `proxyTier` (enum/string) on the `BrowserSession`
row; the backend increments + checks the cap in one transaction.

### Tool description (LLM-facing, canonical text)

> **`rotate_ip`** — Replace the browser's outbound IP address when the current
> one is being blocked or rate-limited by the site.
>
> **Use this ONLY when you have concrete evidence the IP itself is the
> problem** — a "too many requests" / rate-limit page, an "unusual traffic
> detected" or "access denied" interstitial, a CAPTCHA wall that keeps
> reappearing, or repeated 429 responses. **Do NOT use it for ordinary
> failures** — wrong credentials, a 404, a genuine out-of-stock, a form
> validation error, or a page that simply didn't load. Rotating won't fix those
> and it burns a limited budget.
>
> **Escalation path** (the tool advances automatically each call, up to 4
> rotations per browser run):
> - **Calls 1–2** → a fresh **residential** IP in the same region. Login and
>   cookies preserved.
> - **Calls 3–4** → a **mobile-carrier** IP (the strongest, hardest-to-block
>   tier), same region.
>
> After 4 rotations the tool returns an error — that means the site is
> hard-blocking our entire proxy pool for this session. Stop retrying this
> route: try a different approach or report the target as unreachable.
>
> Each rotation takes a few seconds and discards any unsubmitted form data on
> the current page, but keeps you logged in and returns you to the current URL.
> The result tells you which tier you landed on and how many rotations remain.

An optional required `reason: str` arg (a one-line "why I think I'm blocked") is
captured for telemetry + as a soft guard against reflexive spamming; it does not
gate execution.

## System diagram

```
 EXECUTE agent
     │ spawns
     ▼
 browser sub-agent run  ── escalation key = BrowserSession.id ──┐
     │  (agent loop, live CDP connection to ws_url)             │
     │                                                          │
     │  model sees block/captcha page → calls rotate_ip(reason) │
     ▼                                                          │
 service_actions.execute_action("rotate_ip")                    │
     │  POST /api/browser-session/rotate-proxy {taskId, reason}  │
     ▼                                                          │
 backend rotateProxy(taskId)                                     │
     │  1. atomic: read+increment proxyRotationCount on row ─────┘
     │  2. if count > 4 → 409/ROTATION_EXHAUSTED (no session churn)
     │  3. tier = count<=2 ? residential : mobile(flag)
     │  4. createRemoteSession(sameProfile, tier, sameGeo)  ← reuses resume path
     │  5. update BrowserSession row: sessionId, wsUrl, proxyTier
     ▼
 returns { ws_url, tier, rotationsUsed, rotationsRemaining }
     │
     ▼
 handler: tear down current CDP conn → connect_over_cdp(new ws_url)
          → re-goto current URL → resume loop
     │
     ▼
 tool result to model: "Rotated to fresh residential IP (2/4). ..."
```

## Surfaces to change

**Backend**
1. `back-end/src/providers/browser/kernel.ts` — add `rotateKernelProxy(taskId, tier)`:
   reuse `createRemoteSession(sameProfile, tier, sameGeo)` (the resume path already
   recreates a session on the same profile), select residential vs mobile config.
2. `back-end/src/providers/browser/kernelProxy.ts` — mobile candidate builder
   (mirror `kernelProxyCandidates` with `type: 'mobile'`); reuse relaxation.
3. `back-end/src/providers/browser/index.ts` — provider-agnostic `rotateProxy`.
4. `back-end/src/domains/browser-session/{routes,service}.ts` — `POST /rotate-proxy`,
   atomic count/tier read-increment-enforce; return new session metadata.
5. `back-end/prisma/schema.prisma` + **migration** — `BrowserSession.proxyRotationCount`,
   `BrowserSession.proxyTier`. (Real migration via `prisma migrate diff`, not
   `db push` — per DB rules. `migration-drift.test.ts` enforces.)
6. Zod request/response schema for the route — **rule 5 approval required.**

**Agents (v3 path only — not the legacy `tool_definitions.py`)**
7. `agents/browser_tools/schemas.py` — `RotateIpTool` Pydantic model + entry in
   `BROWSER_TOOL_MODELS` (auto-flows into `AVAILABLE_ACTIONS` + the action union).
   Changes the browser system prompt via `build_browser_use_system_prompt` —
   **rule 26 approval required.**
8. `agents/domains/spawn_browser_agent_v3/service_actions.py` — `execute_action`
   branch for `rotate_ip`.
9. `agents/domains/spawn_browser_agent_v3/repo.py` — `rotate_browser_proxy` HTTP call.
10. `agents/domains/spawn_browser_agent_v3/handler.py` — the mid-loop reconnect:
    tear down current Playwright/CDP conn, `connect_over_cdp(new ws_url)`, re-goto
    current URL, continue. **Highest-risk piece — reuse the resume reconnect
    machinery (`handler.py:~3121`, `resumeKernelSession`).**

## Automated verification (rule 15)

1. **Backend blackbox** (`back-end/src/tests/blackbox/browser-session.blackbox.ts`
   or `browser-provider.blackbox.ts`): drive `/rotate-proxy` against a task,
   assert (a) calls 1–2 return `tier: 'residential'` with a new `sessionId`/`wsUrl`
   and preserved profileId; (b) calls 3–4 return `tier: 'mobile'` (flag on);
   (c) call 5 returns `PROXY_ROTATION_EXHAUSTED` and **does not** create a new
   Kernel session; (d) `proxyRotationCount` on the row increments atomically.
2. **Backend unit** for the mobile candidate builder + cap-enforcement logic
   (no SDK needed — mirror `kernel-tab-reset.test.ts` style).
3. **Structural**: `migration-drift.test.ts` must pass with the new columns.
4. **Agent blackbox** (`agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py`):
   stub the backend `/rotate-proxy` to hand back a second `ws_url`; assert the
   handler tears down and reconnects to it and re-lands on the current URL, and
   that a `rotate_ip` action increments the model-visible rotation counter.
5. **Exhaustion path**: assert the 5th call surfaces `PROXY_ROTATION_EXHAUSTED`
   into the agent message stream (to the run, not the user).

## Approval gates (do not skip)

- **Rule 5** — the `/rotate-proxy` Zod request/response schema needs approval
  before implementing.
- **Rule 26** — adding `RotateIpTool` changes the browser system prompt; request
  fresh prompt approval for exactly that hunk (and again if later fixes touch it).

## Rollout / flags

- `KERNEL_MOBILE_FALLBACK_ENABLED` (default **off** initially) gates tiers 3–4.
  Ship residential-only first (cap 4, all residential recycles), enable mobile
  after cost review.
- Cap constant (4) centralized in one backend module; no per-benchmark override
  (rule 25).

## Implementation status (shipped in this branch)

Backend: `BrowserSession.proxyRotationCount` + `proxyTier` (migration
`20260719162739_browser_session_proxy_rotation`); `kernelProxy.ts` generalized to
`residential | mobile` candidates; `kernel.ts` `recreateKernelSession` shared by
resume + `rotateKernelSession`, **evicting the superseded live Kernel browser so a
rotation never leaks a paid session**; `index.ts` `rotateProxy` +
`ProxyRotationUnsupportedError`; `browserSessionResume.ts` `rotateBrowserProxy`
(ownership-scoped atomic conditional reservation, provider-failure rollback,
`selectRotationTier`, escalation message); `POST /rotate-proxy` split into
`routes.rotation.ts` (keeps `routes.ts` under the max-lines cap) with the Zod
`rotateProxySchema` and explicit 400 validation handling.

Agents: `rotate_ip` in `BROWSER_USE_TOOLS` (canonical description) + `RotateIpBrowserTool`
in `BROWSER_TOOL_MODELS`; `repo.rotate_browser_proxy`; handler dispatch +
`_reconnect_browser_stack_after_rotation` (tears down the live CDP/Playwright stack,
reattaches to the new ws_url, re-applies fingerprint, rebuilds the humanizer,
re-lands on the current URL).

Tests: `back-end/src/tests/unit/browser-proxy-rotation.test.ts` (mobile candidates +
ladder, runs in the coverage gate); real-rotation e2e added to
`browser-provider.blackbox.ts` (new ws_url + new session_id + **changed exit IP** via
api.ipify.org + old session evicted + 409 at cap + 404), runs in the smoke path;
agent benchmark `browser-rotate-ip-escalation` in `tasks.json` (**status: incomplete**
— exercises every branch incl. real mobile in one session; promote to `ready` once the
worker runs with `KERNEL_MOBILE_FALLBACK_ENABLED=1` + a mobile-capable Kernel plan).

Known follow-ups: humanizer cursor-streaming re-wiring after reconnect (cosmetic
recording overlay only); FE live-view re-point verified via the emitted browser
action chips (Rotating IP → IP rotated) — deeper visual jank check belongs in a
semantic Chrome test.

## Build order

1. Migration + schema columns + structural test green.
2. Backend `rotateKernelProxy` (residential only) + route + Zod (**get rule 5
   approval**) + backend blackbox for tiers 1–2 and exhaustion.
3. Agent `RotateIpTool` (**get rule 26 approval**) + dispatch + repo call +
   handler reconnect + agent blackbox.
4. Mobile candidate builder + flag + tests for tiers 3–4.
