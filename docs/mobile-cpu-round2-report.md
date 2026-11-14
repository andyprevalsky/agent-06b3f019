# Rose mobile app: foreground CPU, round 2 (normal usage)

Date: 2026-11-12 · Branch: `perf/mobile-cpu-round2` · Baseline: `origin/main` @ `56192d92d` (round 1 shipped)

## TL;DR

Round 2 used round 1's harness and methodology without changes, targeting the scenarios people actually use: chat
with an ACTIVE agent (running status, elapsed clock, live UI) and home.

**No production code change is shipped in round 2.** Per-loop attribution shows what is left after round 1 in chat
and home:

- **Visible animation work.** It is nearly all on-screen work: the dimmed ASCII loader's text and drop-shadow raster,
  the send button's liquid-metal ring, the energy pills and the opening caption's reveal.
- **Everything else is ≈1–2.6 pts.** Non-animation work ("all three loops paused") measures 1.07 % in chat and
  2.6 % in home.
- **Every candidate that cuts the animation cost changes pixels.** Six candidates were built and measured (§5);
  each either drifted pixels in `scripts/mobile-visual-diff.mjs` or measured within noise. Under the hard 0-pixel
  rule they are rejected, with the measured drift recorded.

| Scenario (renderer, % of one core, 3 × 60 s) | Round-2 baseline (`main`) | Round-2 branch | Change |
|---|---:|---:|---:|
| Chat: ACTIVE agent open (normal usage), per-run [21.67, 22.08, 20.98] → [21.25, 21.43, 21.12] | 21.58 | 21.27 | -1.4 % (noise) |
| Home: new-chat screen, per-run [24.88, 28.41, 27.27] → [24.97, 24.72, 23.53] | 26.85 | 24.41 | -9.1 % (noise) |
| Drawer: agent list over the chat | 0.95 | 0.92 | -3.2 % (noise) |
| **Equal-weight mean** | **16.46** | **15.53** | **-5.7 %** |

The branch's front-end source is byte-identical to `main`: only this report is added. So the "branch" column
measures run-to-run noise of the method on an unchanged app, and the honest round-2 delta is 0. Cumulative:
round 1 22.59 → 14.22 (−37 %); round 2 16.46 → 15.53 (-5.7 %, noise); cumulative 22.59 → 15.53.

**The biggest remaining lever needs an owner decision.** Giving the ASCII loader its own compositing layer measured
**home 25.56 % → 19.96 % (−22 %)**. Its only pixel effect is that the header's top-right avatar is promoted to a
layer (overlap promotion) and its gradient rounds differently: **491 pixels change by 1/255**. That is invisible,
but it is not 0, so it was not shipped. Details are in §5.

## 1. Method (same as round 1)

```bash
cd front-end
export $(grep -v '^#' .env.example | xargs)
VITE_ENABLE_REACT_GRAB=false npx vite build --outDir <dist>
node scripts/mobile-cpu-benchmark.mjs --dist <dist> --seconds 60 --runs 3 --out result.json
MOBILE_CPU_NOW=1794000000000 node scripts/mobile-visual-diff.mjs --baseline <dist-main> --candidate <dist-branch> --out <dir>
```

- **Harness and scenarios.** The persistent round-1 harness is used unchanged: headless Chromium 149, 390×844 @3×,
  iPhone UA plus touch, fixture API and acked Supabase websocket. Scenarios after a 5 s settle:
  - `chat`: `/?agent-id=cpu-active-a`, an ACTIVE agent with an IN_PROGRESS tool, scrolled every 10 s;
  - `home`;
  - `drawer`: chat plus "Open menu".
- **Metric.** Renderer `utime+stime` from `/proc/<pid>/stat` over 60 s, giving % of one core; 3 runs per scenario.
  The headline is the equal-weight mean of the three scenarios.
- **Builds.** Baseline is built from pristine `origin/main` 56192d92d; the optimized build from the branch. Both run
  on the same 2-vCPU sandbox.
- **Raw results.** `/home/user/perf/out/r2-final-base.json` and `/home/user/perf/out/r2-final-opt.json`.
- **Attribution.** Each loop is paused at runtime with `MOBILE_CPU_EVAL` (30 s per variant); candidates were measured
  as separate build variants. Raw: `/home/user/perf/out/r2-attrib-base.txt` and `/home/user/perf/out/r2-variants.txt`.
- **Noise.** The machine is a shared 2-vCPU sandbox, so 30 s single runs vary by roughly ±2–4 pts between
  repetitions (home "none" measured 24.9–31.9 across this session). Only effects well above that are treated as
  real.

## 2. Where the CPU goes now (round-2 baseline, attribution)

Baseline `main`, 30 s, renderer % (threads: main / raster pool / compositor):

| paused at runtime | chat | home |
|---|---:|---:|
| nothing | 22.06 (6.1 / 10.4 / 5.1) | 28.80 (6.1 / 17.7 / 4.5) |
| send-button shader (speed 0) | 18.23 | 25.43 |
| energy pills | 22.13 | 25.73 |
| ASCII loader (hidden) | **8.30** | **7.90** |
| all three | **1.07** | **2.60** |

- **The ASCII loader is ~62 % of chat and ~72 % of home renderer CPU.** It writes a gradient-clipped, drop-shadowed
  27×50 `<pre>` every 40 ms, so the raster pool redraws it 25×/s.
- **Why home costs more than chat for the same art.** In chat, the loader is already in its own compositing layer,
  because the blur overlay sits beneath it. In home it shares the root layer, so each frame also re-rasters what is
  painted around it: home raster pool 15–18 vs chat 10.
- **The shader costs ≈3.4–3.8 pts renderer.** It also costs ≈12 pts of main-thread busy time, mostly lifecycle and
  GPU sync at 60 fps.
- **The pills cost ≈0 in chat and ≈3 pts in home.**
- **Everything else costs 1.1 (chat) / 2.6 (home).** That covers React, polling, realtime and Amplitude together.

## 3. Hotspots (file:line on `main` 56192d92d) with measured contribution

| sev | hotspot | measured |
|---|---|---|
| high | ASCII loader 25 fps frame writes into a drop-shadowed, gradient-clipped `<pre>`, visible at opacity 0.2 behind chat and on home (`front-end/src/features/terminal-component-group/components/AsciiLoader.tsx:68`, mounted at `front-end/src/features/terminal/components/ChatScrollArea.tsx:93`) | chat −13.8 pts, home −20.9 pts when hidden |
| high | Home: the ASCII loader shares the root layer, so every frame re-rasters its surroundings too (`front-end/src/features/terminal/components/ChatScrollArea.tsx:82`) | home raster pool 15.3–17.7 vs 9.9 with its own layer (−5.6 pts renderer) |
| medium | Send-button liquid-metal WebGL shader, main-thread rAF at 60 fps (`front-end/src/components/ui/liquid-white-button.tsx:52`) | −3.8 chat / −3.4 home renderer; −12 pts main-thread busy |
| medium | Energy pills (visible windows only since round 1) (`front-end/src/features/terminal/components/GridEnergyPills.tsx:306`) | ≈0 chat, −3.1 home |
| low | Opening caption typewriter reveal at 20 ms steps, visible (`front-end/src/features/terminal/hooks/useOpeningAnimation.ts:26`) | home −4.4 when hidden (noisy run) |
| low | Connected-completion backfill: full agent snapshot every 600 ms ×9, then every 2 s for up to 150 s (`front-end/src/features/agent-context/hooks/agentBackfill.ts:179`) | network: 26 → 6 requests per 30 s when limited to one attempt; renderer −0.8 chat (within noise) |
| low | Amplitude autocapture `MutationObserver` on `<body>` with `characterData`/`subtree`, which sees every ASCII frame (`front-end/src/features/app-wiring/hooks.ts:45`, sample rate `front-end/src/features/app-wiring/config.ts:75`) | combined with the backfill change above: within noise (chat 21.06 → 20.23, home 24.93 → 27.20) |

## 4. Optimizations shipped in round 2

None. No candidate both kept every pixel identical and measured above noise. The branch only adds this report.

## 5. Rejected candidates (measured)

| candidate | CPU effect (30 s, renderer) | pixel result (`mobile-visual-diff.mjs` vs `main`) |
|---|---|---|
| ASCII loader container in its own layer (`will-change: transform` on `terminal-opening-loader`; translate-only, scale painted inside) | **home 25.56 → 19.96 (−22 %)**, chat 20.93 → 20.13 | 13/52 frames, all home: **491 px, max Δ1/255**, all in the header avatar (CSS 348–380 × 12–44); the new layer overlap-promotes the avatar, whose gradient then rounds differently. Chat/drawer frames: 0 px |
| Layer on the loader's inner `div.space-y-6` (art + caption only, avoids overlapping the avatar) | not measured | **641k–685k px, max Δ35**: the composited subtree changes how the art interacts with the drop-shadow/blur |
| Shader WebGL context `desynchronized: true` | renderer no gain (chat 22.03, home 29.46); main-thread busy 17.5 → 7.8 | **1650 px, max Δ3** on the ring (same signature as round 1's worker OffscreenCanvas: non-main-thread canvas compositing) |
| Shader context `antialias: false` (no MSAA; a full-screen quad has no interior edges) | no gain (chat 22.46, home 29.03) | not adopted: no CPU benefit |
| One text node per ASCII line, writing only changed lines (runtime prototype) | worse (chat 21.1 → 22.4, home 26.8 → 28.9): background-clip:text and drop-shadow repaint the whole `<pre>` either way | not adopted |
| Amplitude init off + completion backfill limited to one attempt (attribution only) | within noise (chat −0.8, home +2.3); requests 26 → 6 per 30 s in chat | not adopted: no measurable CPU effect, and the backfill cadence is a deliberate reliability guard against lost realtime broadcasts |

### Ready-to-ship owner options (paired 60 s measurement, same harness and session)

Each option is one commit on its own pushed branch off `main` 56192d92d. They are not merged. Raw:
`/home/user/perf/out/r2-options-r2-base.json` and `/home/user/perf/out/r2-options-r2-option-*.json`.

| option (branch @ commit) | chat | home | drawer | mean | main-thread busy chat/home | pixel drift (full 52-frame set) |
|---|---:|---:|---:|---:|---|---|
| baseline `main` | 22.33 | 27.17 | 1.17 | 16.89 | 17.4 / 15.5 % | — |
| ASCII loader own layer (`perf/mobile-cpu-r2-option-loader-layer` @ `618c4240b`) | 20.80 (−6.9 %) | **21.78 (−19.8 %)** | 1.22 (+0.05) | **14.60 (−13.6 %)** | 17.4 / 16.9 % | 13/52 frames (all home), 491 px/frame, max Δ1/255 (header avatar) |
| Shader `desynchronized: true` (`perf/mobile-cpu-r2-option-shader-desync` @ `9008a9056`) | 21.68 (−2.9 %) | 33.88 (+24.7 %, noisy run) | 1.07 (−0.1) | 18.88 (+11.8 %) | **7.6 / 8.0 %** | 38/52 frames (chat, home, drawer-closing; covered drawer frames clean), 1650 px/frame, max Δ3/255 (send-button ring) |

The loader layer is the only option with a clear renderer win. Shader desync is a main-thread responsiveness win
(input latency) with no renderer win.

**Measured-and-within-noise candidates (not shipped, no option branch):**
- **Completion backfill limited to one attempt, together with Amplitude init removed.** One build variant measured
  chat 21.06 → 20.23 and home 24.93 → 27.20 (30 s). That is within noise; network requests fell 26 → 6 per 30 s.
  The ceiling for all non-animation work combined is 1.07 % (chat) / 2.60 % (home), the "all three paused"
  attribution.
- **Shader `antialias: false`:** chat 22.46, home 29.03 (30 s); no gain.
- **Per-line ASCII text nodes:** chat 22.4, home 28.9 vs 21.1 / 26.8; worse.

Round 1 also rejected the worker OffscreenCanvas shader (Δ3 on 1650 px) and the shader fragment early-out
(11–13 px). The same mechanisms reproduce here.

## 6. Owner decisions that would move the needle

1. **Accept the 1/255 avatar shift** (491 px, invisible) for the ASCII loader layer: home −22 % renderer. This is a
   one-line change on `ChatScrollArea.tsx:82` and is already measured.
2. **Pause or hide the dimmed ASCII loader in chat once messages exist:** −13.8 pts chat (−62 %). This is a visual
   change.
3. **Backfill cadence while realtime is healthy:** about 4× fewer snapshot requests (radio wakeups on phones). This is
   a reliability/product trade-off.

## 7. Verification

- **Pixel identity.** The branch's front-end source is identical to `main`. The final full run of
  `mobile-visual-diff.mjs` (52 frames: chat/home/drawer/drawer-closing × 13 animation times, 1170×2532) gives
  **52/52 frames, 0 differing pixels** (`/home/user/perf/r2-diff-final/visual-diff.json`).
- **Static checks and tests.** front-end `tsc --noEmit -p tsconfig.app.json`: clean. Full vitest (hardlinked `node_modules`, so no symlink quirk): **327/327 files, 4757 passed, 1 skipped, 0 failed**, plus 6 *unhandled errors* (`TypeError: Cannot read properties of undefined (reading 'introStart')`) from `src/tests/blackbox/index.blackbox.tsx`. They reproduce in isolation on this branch, whose front-end source is byte-identical to `main`, so they are pre-existing on `main` (landing-page video markers) and not introduced by round 2. ESLint: no source files touched.
- **Style files.** 0 theme/style/CSS/token files changed; 0 production source files changed.
- **Deploy.** The `/deploy` command (`.claude/commands/deploy.md`) opens with:

  > description: "Ship the whole devbox to production: gates, review, merge, production verification, scorecard."
  >
  > # /deploy
  >
  > Ship every intended Rose change on this devbox to production, verified, and publish the deploy scorecard.

## 8. Deploy outcome: `/deploy` BLOCKED (missing production credentials); fallback landed via `/push`

`/deploy` was run from `/home/user/r2` on `perf/mobile-cpu-round2`.

1. **Step 1, `scripts/deploy sync`:** `DEPLOY_SYNC up-to-date head=56192d92d17a main=56192d92d17a`.
2. **Step 2, `bash scripts/prepare-deploy-worktree.sh --check`:** first run printed `❌ Isolated deploy worktree is
   missing .context/deploy-worktree.env.`
3. **Documented workaround, full preparation.** Ran `prepare-deploy-worktree.sh --worktree /home/user/r2 --source
   /home/user/workspace --skip-database`. It first failed on the sandbox's missing `ensurepip`. After building
   `agents/venv` with uv's Python 3.11 from `agents/requirements.txt`, preparation succeeded:
   `✅ Prepared isolated deploy worktree /home/user/r2 identity=r2-6741eff9b40b base_port=10000`.
4. **Retried check, still blocked:** `❌ Deploy worktree credential must be a hydrated symlink: back-end/.env`.
   This sandbox has no `back-end/.env` or `agents/.env` anywhere. Those production credential files feed the gates,
   the Render/Vercel/Fly lanes and production semantics, and only the owner can provision them.
5. **Stop protocol:** `scripts/deploy finish --outcome blocked` ran, giving `DEPLOY_FINISH FAIL outcome=blocked`. Its
   factory-ledger step published 1 row to `origin/main` (data-only commit `4f71f0dd4`).

**Production is still serving pre-round-1 code.** `https://www.roselabs.ai/version.json` returns
`{"buildId":"d27550bc957c-..."}`. Vercel blocked the production builds of `d7e7dfe18` and `56192d92d`, with GitHub
statuses "Deployment was blocked" and "GitHub couldn't verify an account for the commit". Those `main` heads were
authored by the sandbox identity "Rose Agent", which is not a verified GitHub account. Round 1's −37 % therefore has
not reached users yet.

To ship it, run `/deploy` from a devbox that has the credential files. Its PR merge creates a merge commit authored by
a verified account, and Vercel deploys that commit. The fallback `/push` from this sandbox lands the report on `main`,
but Vercel is expected to block it for the same reason.
