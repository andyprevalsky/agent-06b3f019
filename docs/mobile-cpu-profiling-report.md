# Rose mobile app: foreground CPU investigation and optimization

Date: 2026-11-12 · Branch: `rose/mobile-app-cpu-optimization-7eab9901--mobile-app-cpu-optimizat-573e33`

## TL;DR

| Scenario (390x844 @3x, iPhone UA, touch) | Baseline renderer CPU | Optimized | Change | GPU-process CPU before → after |
|---|---:|---:|---:|---:|
| Chat: active agent open, user reading/scrolling | 21.53 % | 18.00 % | −16.4 % | 106.1 % → 99.2 % |
| Home: new-chat screen, agents list loaded | 24.95 % | 23.72 % | −4.9 % | 34.4 % → 32.1 % |
| Drawer: mobile agent list open over the chat | 21.30 % | 0.94 % | −95.6 % | 105.8 % → 0.1 % |
| **Mean of the three foreground scenarios** | **22.59 %** | **14.22 %** | **−37.1 %** | 82.1 % → 43.8 % |

(% of one core; mean of 3 × 60 s runs per scenario and build; same harness, same machine, same fixtures.)

Rendered output is pixel-identical. 52 frozen-state screenshots per build (chat, home, drawer-open,
drawer-closing × 13 animation times) match with **0 differing pixels**.

What can be cut and what can't, without changing a pixel:
- **Wasted work was removed.** Mounted energy pills that can never be seen, pills moving while fully masked,
  every ambient animation running under the opaque full-screen drawer, and a 10 Hz React re-render whose
  label changes once a second.
- **The remaining steady-state cost is the design itself.** In chat and home, the ASCII loader redraws
  25×/s, the energy pills move at 60 fps under a full-screen 10.5 px backdrop blur, and the send button
  runs a 60 fps WebGL shader. Every visible frame of these forces the blur to re-render, and the ASCII
  text plus its drop-shadow to re-raster. None of that can be lowered without changing what is on
  screen. This report quantifies it per hotspot, and lists the design-level options with their measured
  upper bounds in "Not done".

## 1. App and stack

- The "mobile app" is the **`front-end/` React 18 + Vite + Tailwind SPA/PWA** served on phones (iOS PWA
  viewport code in `front-end/src/features/app-wiring/hooks.ts`, mobile-specific layouts, drawer and
  header). There is no native iOS/Android, React Native or Flutter client in the repo. `mac-app/` is
  Electron and was out of scope.
- Main mobile screens: the terminal/chat (`features/terminal`, `features/terminal-component-group`), the
  agent drawer (`MobileAgentDrawer`), and the new-chat home (same route, no agent selected).
- Animation systems:
  - CSS keyframes: mobile energy pills, Tailwind transitions.
  - `setInterval` frame writers: ASCII loader at 40 ms, ROSE dot letters at 70 ms, elapsed clocks at
    100 ms, opening caption at 20 ms (finite).
  - WebGL `ShaderMount` (`@paper-design/shaders`) on the send/stop button.
  - Backdrop-filter glass: chat blur overlay, user bubbles, dark-glass button refraction.
- Sync: Supabase realtime channels plus a finite connected-completion backfill poll. Analytics: Amplitude
  autocapture with session replay at sample rate 1, Vercel analytics.

## 2. Measurement methodology (reproducible)

Harness: `front-end/scripts/mobile-cpu-benchmark.mjs` (committed).

```bash
cd front-end
export $(grep -v '^#' .env.example | xargs)
VITE_ENABLE_REACT_GRAB=false npx vite build --outDir /tmp/dist-X      # production bundle
node scripts/mobile-cpu-benchmark.mjs --dist /tmp/dist-X --seconds 60 --runs 3 --out result.json
#   [--scenario chat,home,drawer] [--profile prefix] [--trace prefix] [--diag]
#   MOBILE_CPU_EVAL='<js>' runs a snippet before the window (per-hotspot attribution only)
```

- **Build and serve.** The production build is served by a local static SPA server. `/_vercel/*`
  scripts are served empty because they only exist on Vercel.
- **Browser setup.** Playwright headless Chromium 149 (`--disable-renderer-backgrounding
  --disable-background-timer-throttling`) with viewport 390x844, deviceScaleFactor 3, `isMobile`,
  `hasTouch` and an iPhone Safari UA.
- **Fixtures, no network.** Every `/api/*` call is answered from fixtures: 6 agents, 3 ACTIVE and 3
  COMPLETED, 120 messages each, and the open agent has an IN_PROGRESS tool. The Supabase realtime
  websocket is acknowledged at the wire (joins and heartbeats), following the repo's
  `tests-e2e/mobile-performance.ts` pattern. Third-party hosts (Amplitude etc.) get local `{}`
  responses, so nothing leaves the sandbox.
- **Scenarios** (all start with a 5 s settle after the content is attached):
  - `chat`: `/?agent-id=cpu-active-a`, with the conversation scrolled up and back every 10 s.
  - `home`: `/` with no agent selected.
  - `drawer`: chat, then tap "Open menu" and wait 1 s for the slide-in.
- **Metric.** The renderer process's `utime+stime` from `/proc/<pid>/stat`, divided by wall time × CLK_TCK,
  over a 60 s window: **% of one core**.
- **Also recorded.** GPU-process and all-process CPU, per-thread renderer CPU
  (`/proc/<pid>/task/*/stat`: main, compositor, raster pool), and CDP `Performance.getMetrics`
  deltas (TaskDuration, Layout/RecalcStyle counts).
- **Profiling.** CDP sampling profiles and Chrome traces of the baseline.
- **Attribution.** The same harness with one loop paused at runtime through `MOBILE_CPU_EVAL`. Nothing
  disabling is committed.
- **Baseline** is the untouched `main` at 36700b227, built the same way.
- **Caveat.** Headless Chromium uses SwiftShader, so GPU-process numbers are CPU-emulated compositing.
  They are a faithful *relative* proxy for compositor/GPU load, not absolute phone GPU watts. The
  renderer number is the primary metric.

## 3. Baseline profile: where the CPU goes

CDP CPU profile, chat, 20 s: JS self time is **< 1 %**. The renderer's busy time is native rendering
work ("(program)" 17.6 %). It is not React, JSON parsing or timers.

Renderer threads (baseline, 60 s mean):

| thread | chat | home |
|---|---:|---:|
| main (CrRendererMain) | 6.4 % | 5.5 % |
| raster workers (ThreadPoolForeground) | 9.8 % | 15.1 % |
| compositor | 5.0 % | 4.1 % |

Chrome trace (home, 4 s): BeginMainFrame 737 ms, raster 700 ms, Commit 522 ms, `DoUpdateLayers` 470 ms.
Main frames run at 25–60/s even though nothing is being interacted with.

Per-hotspot attribution (baseline build, chat, 30 s each; one loop paused at runtime):

| paused | renderer | GPU proc | layouts | style recalcs |
|---|---:|---:|---:|---:|
| nothing | 20.2 % | 108.4 % | 785 | 1669 |
| ASCII loader (hidden) | 8.8 % | 110.7 % | 36 | 1620 |
| send-button shader (speed 0) | 18.0 % | 92.4 % | 771 | 885 |
| energy pills (animations paused) | 21.6 % | 72.6 % | 763 | 7 |
| all three | **1.4 %** | **0.5 %** | 35 | 32 |
| only pills running | 4.4 % | 95.2 % | | |
| only the 5 never-visible pills running | 4.4 % | **65.5 %** | | |
| only pills, chat backdrop blur removed | 4.1 % | 19.6 % | | |

Home shows the same picture: all three paused gives 2.6 % renderer and 1.7 % GPU. That leaves 1–3 %
for everything else in the app together: React, polling, realtime, analytics.

## 4. Hotspots (file:line in baseline `main`)

| sev | hotspot | class |
|---|---|---|
| critical | **The opaque full-screen mobile drawer leaves the whole app animating underneath it.** ASCII loader, pills under the blur and the shader keep running for pixels no one can see: 21.3 % renderer and 106 % GPU while browsing the agent list (`front-end/src/features/terminal-component-group/components/MobileAgentDrawer.tsx:212`). | (a) pure waste |
| critical | **Full-screen chat backdrop blur** `blur(10.5px)` with a mask, ≈1122×2013 device px. It is re-rendered on every frame where anything under it changes: pills, ASCII loader frames, even fully masked pills. This is the dominant GPU-process cost, 75–95 % of the 106 % (`front-end/src/features/terminal/components/ChatScrollArea.tsx:170`). | (c) visual; triggers partly (a) |
| high | **ASCII loader writes a new 27×50 frame every 40 ms.** It is gradient `background-clip:text` with a `drop-shadow` filter, re-rasterized at 3× every frame. That is 11–17 % renderer: raster pool plus 25 layouts/s. It stays visible at 20 % opacity behind the chat (`front-end/src/features/terminal-component-group/components/AsciiLoader.tsx:68`, `:57`, used at `front-end/src/features/terminal/components/ChatScrollArea.tsx:93`). | (c) visual |
| high | **Mobile energy pills: 8 infinite compositor animations; 5 of them can never be seen at 390×844.** h-01 is above the screen, h-05 under the tile cutout, h-13 under the input cutout, and v-10/v-14 past the right edge. The visible ones also keep moving while fully masked. Masked motion still damages the frame and forces the chat blur re-render (65 % GPU for the 5 invisible pills alone) (`front-end/src/features/terminal/components/GridEnergyPills.tsx:116`, `:306`, `:400`). | (a) waste + (c) visual |
| high | **Send-button liquid-metal WebGL shader on a main-thread rAF loop at 60 fps.** Each frame triggers a full main-frame lifecycle and commit: about 12 % main-thread busy and 7–8 % renderer alone. Only a 1–3.5 px outer ring of the canvas is visible (`front-end/src/components/ui/liquid-white-button.tsx:56`, `:73`). In the dark-glass theme its face also runs an SVG `url()` backdrop refraction over the canvas (`front-end/src/features/terminal-component-group/components/query-input/roseQueryBox.css:113`). | (c) visual |
| medium | **Connected-completion backfill re-fetches the full agent snapshot.** It polls every 600 ms ×9, then every 2 s for up to 150 s after selecting a running agent. It is radio/network wakeups more than CPU, since `replaceEqualDeep` already prevents re-renders (`front-end/src/features/agent-context/config.ts:23`, `front-end/src/features/agent-context/hooks/agentBackfill.ts:179`). | (b), product reliability |
| medium | **Amplitude session replay at sample rate 1, plus full autocapture.** It records DOM mutations of a constantly animating page. ASCII layers are already `data-amp-block`. Not measurable here because replay config fetches are stubbed (`front-end/src/features/app-wiring/config.ts:75`, `front-end/src/features/app-wiring/hooks.ts:45`). | (b), product decision |
| low | **Running-batch elapsed clock re-renders `TrajectoryWorkGroup` every 100 ms.** Past one minute the label only changes once per second ("1m 05s"), so 90 % of those renders are no-ops (`front-end/src/features/terminal-component-group/components/useBatchElapsed.ts:10`). | (b) |
| low | **10 Hz clocks that do display tenths.** `StreamingMetric` ("57.7s") and the explore carousel; they are visible (`front-end/src/features/terminal-component-group/components/StreamingMetric.tsx:41`, `front-end/src/features/terminal-component-group/components/ExploreActiveToolCarousel.tsx:79`). | (c) |
| low | **ROSE dot-letter working indicator at 70 ms.** It is already a single shared clock that re-renders only 25 spans (`front-end/src/features/terminal-component-group/components/roseDotLetters.ts:78`). | (c) |

Checked and found already efficient, so left alone:
- The opening caption (20 ms reveal, finite, isolated subscriber, `useOpeningAnimation.ts:26`).
- The AsciiLoader writes frames straight to text nodes, with no React render, and pauses when hidden
  or out of view.
- Pills are already compositor transforms, not canvas or SVG.
- The backfill state merge uses `replaceEqualDeep`.
- Polling loops skip hidden documents.
- No busy-waits or synchronous main-thread waits were found.
- Script time is < 1 % in profiles.

## 5. Optimizations (all output-identical)

1. **Cover the app under the opaque drawer** (`src/lib/appCover.ts` new,
   `MobileAgentDrawer.tsx`, `AsciiLoader.tsx`, `liquid-white-button.tsx`).
   - When the drawer's slide-in ends, `coverApp()` checks that the sheet is outside `#root`, has an
     opaque background, opacity 1 and spans the viewport.
   - Only then does it set `#root { visibility: hidden }`. Layout, scroll and CSS animation timelines
     are kept, but nothing under the sheet is painted or composited.
   - Subscribers hold their loops while covered: the AsciiLoader interval and the ShaderMount speed,
     the same hold both already do for `document.hidden`.
   - `uncoverApp()` runs in a `useLayoutEffect` on close, so the app is visible again before the
     slide-out's first frame.
   - Result: drawer 21.3 % → 0.94 % renderer, 106 % → 0.1 % GPU.
2. **Don't mount never-visible pills; park pills while masked** (`GridEnergyPills.tsx`).
   - The even-odd mask (viewport ∩ odd coverage of viewport/tile/input rects) is evaluated per
     rect-edge grid cell to get each pill's visible cycle windows, with a 2 px antialiasing margin.
   - A pill with no window is not rendered.
   - Otherwise its keyframes follow the original linear `from → to` path inside the windows. Between
     windows it holds still (`animation-timing-function: step-end`) and jumps to its re-entry point.
   - Every visible frame is the same position at the same time, because `startTime` stays pinned to
     the document timeline. Masked stretches no longer damage the frame or re-trigger the chat blur.
   - Pills-only GPU: chat 96.6 % → 75.7 %, home 15.0 % → 8.7 %.
3. **Elapsed clock ticks only when its label can change** (`useBatchElapsed.ts`). 100 ms ticks while
   tenths are shown (< 60 s), then one timeout per whole-second boundary. The label is identical, and
   React renders drop 10× after the first minute.
4. **Measurement and verification tooling** (`scripts/mobile-cpu-benchmark.mjs`,
   `scripts/mobile-visual-diff.mjs`), so the numbers can be re-run.

### Evaluated and rejected (not identical, or no net gain)

| idea | measured effect | why rejected |
|---|---|---|
| Render the send-button shader from a Worker via OffscreenCanvas | shader-only renderer 7.9 → 3.2 %; full chat main thread 18 → 4.3 %, but total renderer only −1.5 pts (ASCII's 25 main frames/s remain) | 1650 ring pixels differed by ≤3/255: Chromium composites worker canvases through a different resource path. Fails "pixel-identical". |
| Fragment early-out for the shader's hidden core (inside the chrome ring / dark-glass mask) | GPU 27.6 → 25.2 % (shader-only) | Adding a branch changed GPU codegen: 11–13 edge pixels differed by up to 24/255. |
| `will-change: transform` on the ASCII loader wrapper / `<pre>` | home renderer −30 %, but work moves to the GPU process (net ≈ 0 in Chromium) | Composited layer under `scale(0.95)` → WebKit rasterizes and resamples → softer text on iPhone. |
| Own layer for the static grid background | no change | — |
| `contain: layout style` on the ASCII `<pre>` | no change | — |

## 6. Verification

- **Pixel identity.** `MOBILE_CPU_NOW=1794000000000 node scripts/mobile-visual-diff.mjs --baseline <dist-main>
  --candidate <dist-opt> --out <dir>` renders both builds under one fake clock:
  - Playwright `clock.install`, then pause, then run timers 120 s, so the timer-driven UI reaches the
    same state in both builds.
  - The same text is written into the ASCII layers, and the shader is stopped at one frame
    (`setSpeed(0)` + `setFrame(4321)`).
  - Every running CSS animation (the pills included) is seeked to 13 times between 0 and 57 s, and
    each state is screenshot at 1170×2532.
  - Scenarios: chat, home, drawer open, drawer closing (the reveal frames).
  - Self-test, baseline vs baseline: 0 differing pixels in 52/52 frames.
  - **Baseline vs optimized: 0 differing pixels in 52/52 frames** (final build; see
    `visual-diff.json`).
- **Unit/integration (vitest, jsdom), whole front-end suite.** 4750 passed, 1 skipped, 3 failed during
  a run that hit an OOM kill (a parallel `vite build`). Re-running those 3 files alone gave 92/92
  passed: `app-sidebar-rows`, `rose-sidebar-projects`, `terminal`.
- **Updated tests.**
  - `grid-energy-pills-performance.blackbox.tsx` now asserts the new contract instead of
    "8 pills, 2-keyframe text": an independent sampler walks the whole cycle (2000 steps). Wherever a
    pill's keyframed position differs from the original linear path, both positions must be fully
    masked, and unmounted flows must be masked all cycle long. Mutation check: a −10 px visibility
    margin fails 5 tests.
  - `rose-theme` (`toHaveLength(3)`) and the frozen light-mode mobile background fixture were
    regenerated. The diff is only the pill layer.
- **New tests.** `mobile-cpu-idle.blackbox.tsx`:
  - The cover only engages for an opaque, full-viewport overlay outside `#root`.
  - The ASCII frame holds while covered and resumes on uncover.
  - The shader goes speed 0.5 → 0 → 0.5.
  - The elapsed clock renders 10×/s under a minute and 1×/s after, and shows each second exactly
    on time.
- **Static checks.** `tsc --noEmit -p tsconfig.app.json` and `eslint` on all touched files are clean;
  prettier was applied.
- **Constraint check.** No theme, style or design-token file was changed. The diff touches no
  colors, classes, typography, layout, shadows, gradients or animation durations/easings of anything
  on screen. Pill timing strings (`Ns linear -Ds infinite`) are unchanged; only the off-screen
  keyframe stretches differ.

## 7. Not done: options that need a design decision (measured upper bounds)

All of these change what is on screen, so they were not implemented:
- **Pause ambient animations after N s idle in chat** (ASCII loader, pills, shader): chat 20 % → 1.4 %
  renderer, 108 % → 0.5 % GPU (§3 "all three").
- **Drop or shrink the chat backdrop blur:** with the pills still running, GPU 95 % → 20 %.
- **Hide the dimmed ASCII loader once messages exist:** chat renderer −11 pts.
- **Lower Amplitude session replay sampling on mobile:** product decision.
- **Apply `appCover` to other opaque full-screen overlays:** `DocumentPreviewDrawer`, image lightbox,
  fullscreen browser view. Each needs its own opacity/geometry check.
