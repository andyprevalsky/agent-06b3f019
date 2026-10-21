# Tilion browser provider (default)

Goal: add Tilion Cloud (`https://back.tilion.dev`, API reference attached to the
originating thread; pilot: 20 concurrent browsers, 2,000 browser-hours, 50 GB
premium proxy, $500 credit wallet = 250,000 credits) as a browser provider that
does everything Kernel/Steel/Browser Use do today, and make it the **default for
new browser sessions**. A run whose provider switches mid-run (rotation,
challenge recovery, promoted preferred config) keeps the switched provider and
its browser state; the default never overrides a run's persisted provider.

Credentials: `TILION_API_KEY`, `TILION_BASE_URL` in `agents/.env` and
`back-end/.env` (never print). Prod surfaces (Render, Fly, Codex cloud, boxes
managed env, bench guest secrets) need user approval; queued for /deploy.

## System context

```
 agent worker (Python, Fly)                     backend (Express, Render)
 spawn_browser_agent_v3 ── initSession ───────▶ providers/browser/index.ts
   │  ws_url (CDP, token in query)                │ selectedBrowserProvider()  default: tilion
   │                                              │   kill switch BROWSER_AGENT_TILION_ENABLED=false → kernel
   │                                              ├─ tilion.ts ── tilionClient.ts ──▶ Tilion REST
   │                                              ├─ kernel.ts / steel / browserUse.ts   (unchanged)
   ▼                                              ├─ rotation.ts ladder (tilion → kernel → steel …)
 Tilion browser ◀──── single CDP client ──────────┤ sessionCleanup / reaper (owned rows only)
   ▲                                              └─ live view: /v1/session/{id}/live-view?token (1800 s)
   └── FE live panel (iframe, token refreshed via backend)
```

## Decisions

- Provider name `tilion`. `selectedBrowserProvider()` defaults to `tilion`;
  missing `TILION_API_KEY` throws a named error (no silent downgrade).
  `BROWSER_AGENT_TILION_ENABLED` (default on) is the kill switch → Kernel.
  Unknown provider strings fail closed in config; stored rows with `tilion`
  are recognised (no legacy fallback to Steel).
- No silent runtime fallbacks during development (CLAUDE.md rule 8): 429
  `concurrency_limit` → `BrowserProviderRateLimitError('tilion')`; 402
  `insufficient_credits` → typed non-retryable error.
- Never use Tilion saved logins (`/v1/auth*`, account-wide → cross-user leak).
  Browser state moves through our provider-neutral CDP injection/harvest
  (`steel/injection.ts`, `sessionAuthPersist.ts`), optionally `/context`.
- Tilion allows **one CDP client per session** (second socket → close 4409) and
  REST drive calls may wait while CDP is attached. Every backend/worker path
  that opens a second connection while the agent is attached must be removed or
  sequenced for Tilion. Lane E measures the real behaviour first.
- Session `ttl`/`idle_timeout` from env (`TILION_SESSION_TTL_SECONDS`,
  `TILION_IDLE_TIMEOUT_SECONDS`), lifetime ≥ activity budget + 5 min; an
  expired session is recreated on resume with the same state and URL.
- `cdp_observe` (vendor auto CAPTCHA solve) is configurable (`TILION_CDP_OBSERVE`),
  default off: it solved neither live demo and cost 100–250 ms per navigation.
  Missing CAPTCHA solving stays an open issue (T1), not a resolved item.
- Ownership: Tilion has no session tags and one account is shared by prod, dev
  and benchmarks. Cleanup/reaping acts only on session ids recorded in the
  local DB as ours and no longer ACTIVE. Never reap by account listing alone.
- Recording: provider-neutral screenshot replay (no Tilion recording API).
- Cost row: 2 credits/create + 1 credit/min at $0.002/credit (12¢/hour).

## Lanes (file ownership; do not edit another lane's files)

| Lane | Owns |
|---|---|
| A1 client+adapter | `tilionClient.ts`, `tilion.ts` (replace stub; keep exported names), fake Tilion server test helper, `tests/unit/tilion-*.test.ts` |
| A2 backend wiring | `types.ts`, `config.ts`, `index.ts`, `sessionCleanup.ts`, `context.ts`, `sessionAuthPersist.ts`, `captcha*.ts`, `compute-grants/*`, browser-session domain, `agentCleanup.ts`, `server.ts` shutdown, Tilion reaper, selection/default cases in `browser-provider.blackbox.ts`, provider-branch structural test |
| B rotation/recovery | `rotation.ts`, `rotationGeolocation.ts`, `challengeRecovery*.ts`, `browserSessionResume.ts`, `resumeTransport.ts`, `recoveryOriginStorage.ts`, their tests; mid-run switch persistence tests |
| C agent worker | `agents/domains/spawn_browser_agent_v3/*`, `agents/browser_tools/*`, CDP URL helpers, agent tests (cancel set, cost row, recording, downloads, uploads, captcha wait, single-CDP-client audit) |
| D frontend+ops | front-end live view (`liveViewDisplay.ts`, panel), `scripts/lib/cloudbench-env.sh`, `scripts/cloud-init.sh`, `.env.example` files, `run-coverage.sh`, bench guest env distribution |
| E live probe+gates | `back-end/scripts/tilion-probe.ts`, `browser-provider.tilion-live.support.ts`, live passkey/auth-persist/concurrency cases, `/deploy` registration |

## Validation criteria

A selection/config: A1 `tilion` known, unknown fails closed · A2 missing key fails
loudly · A3 kill switch routes new work to Kernel · A4 every provider-name branch
handles tilion (structural test).
B lifecycle: B1 create contract + row + release on failed validation · B2
idempotent create (Idempotency-Key) · B3 cancel during create releases · B4 every
terminal path releases (204/404/410 = released, 503 retried) · B5 typed cleanup
failure · B6 owned-only reaper · B7 lifetime ≥ budget + 5 min, expired session
recreated with state · B8 deploy drain resumes same session.
C CDP: C1 production key boundary in live harness · C2 no 4409 collisions · C3
bounded CDP awaits · C4 injected scripts survive injector disconnect · C5 pixels =
input coordinates · C6 typed errors (429/402/403/410 browser_crashed).
D live view: D1 interactive take-control, read-only viewers inert · D2 follows
session binding, token refresh, expired → live:false · D3 approval on same
session · D4 native passkey chooser dismissable.
E recording: E1 finished playable recording · E2 multi-part across providers ·
E3 failures never fail actions; durable links.
F auth: F1 no cross-user state · F2 cookies/localStorage/IndexedDB survive
Kernel→Tilion→Kernel · F3 sign-in harvest + kill switch · F4 benchmark isolation.
G proxy: G1 geo + city fallback, no downgrade · G2 rotate-ip changes exit IP,
keeps CDP/profile/tier · G3 timezone/locale, no IP headers · G4 WebDecoy ≤ 0.163.
H CAPTCHA: H1 reCAPTCHA grid solved or handed off; Turnstile/hCaptcha · H2 solver
status visible, verified on live tab.
I files/passkeys: I1 real downloads only · I2 upload works · I3 real passkey
assertion, sign count advances.
K capacity/cost/obs: K1 21st session typed 429 · K2 cost row vs /v1/usage · K3
worker RSS bounded · K4 X-Request-ID logged.
L acceptance: live gates green with `BROWSER_PROVIDER=tilion`; benchmarks on
Tilion with verified FE links: browser smoke, `browser-biometrics-webdecoy`,
`browser-blue-bottle-challenge-recovery`, `browser-1015-eventim-request-card`,
`browser-rotate-ip-escalation`, `browser-file-upload-tinypng`,
`linkedin-data-download`, `browser-agent-amazon-passkey`, `browser-auth-*`
sample (payment canary skipped by user); pass rate/latency/cost ≥ Kernel;
Tilion live parity registered in /deploy.

## Open issues (report at the end; a mitigation is not a resolution)

- **T1 [critical] H1/H2**: Tilion CAPTCHA solving failed: cdp_observe auto-solve and REST /v1/solve did not solve the reCAPTCHA v2 demo (provider_failed) or the Cloudflare Turnstile demo (deadline). No per-session CAPTCHA telemetry.. Current handling: cdp_observe default off (+100-250 ms per navigation, no observed benefit); challenges go to our rotation ladder (Tilion -> Kernel -> Steel) or user handoff. Next: measure cdp_observe on vs off on the real challenge benchmarks (blue-bottle challenge recovery, eventim, webdecoy); raise a vendor ticket.
- **T2 [high] G1**: Geo targeting is country-only: state, city and zip are geo_unsupported; region:'de' on a direct session still exited in the US. Current handling: fallback to country, geo_applied recorded.
- **T3 [high] G3**: Timezone and locale never follow the exit geo (always America/New_York, en-US). Current handling: worker applies emulation over its CDP socket (lane C), needs live verification.
- **T4 [high] G4**: Bot-detector: runtimeEnableLeak RED, platformMismatch YELLOW (claims Win32); WebDecoy score not yet measured on Tilion. Current handling: Runtime.enable leak is pre-existing on all providers via Playwright; mux adds none.
- **T5 [medium] E1**: No recording API (replay_url field is always null). Current handling: provider-neutral screenshot replay (Kernel has native video replay).
- **T6 [high] C2**: Only one CDP client per session (4409), and REST screenshot/act/files fail while CDP is attached (409 session_driven_by_client / 502 ExternalControlBusy), contrary to the docs ('waits'). Current handling: worker owns the only socket; the backend never connects mid-run.
- **T7 [medium] I2**: No upload API; raw DOM.setFileInputFiles with a local path is a silent no-op; data: URLs blocked. Current handling: worker blob/https upload, needs live verification.
- **T8 [medium] I3**: WebAuthn: virtual authenticator works, but WebAuthn.getCredentials is intermittently 'not enabled' and one credentials.* call hung. Current handling: bounded calls; needs a live passkey gate.
- **T9 [high] K1**: 20 concurrent browsers, account-wide, shared by prod, dev and benchmarks; the 21st gets 429 with no Retry-After. Current handling: typed rate-limit error; bench capacity row (lane D).
- **T10 [medium] B7/D2**: CDP connect and view tokens expire after 30 min; idle_timeout max 1 h kills quiet sessions (user takeover / approval waits). Current handling: fresh URL minted on every reattach/live-view fetch; resume recreates with carried state; the live-view iframe reloads every 25 min.
- **T11 [medium] K2**: $500 credit wallet: service stops when spent (402); no per-session cost breakdown in /v1/usage. Current handling: typed 402; cost row estimated at 12c/hour.
- **T12 [low] F1**: Tilion saved logins (/v1/auth) are account-wide, so they would leak across users. Current handling: never called; our per-user injection is used instead.
- **T13 [high] A3**: Prod is pinned to BROWSER_PROVIDER=kernel on Render; Tilion is not the prod default until approved env writes land (Render, Fly, Codex cloud, boxes managed env, bench secrets). Current handling: queued for user approval at deploy.
