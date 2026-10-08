---
id: 2026-10-07-launcher-submit-dropped-when-main-window-receiver-absent
date: 2026-10-07
title: Quick-launcher submit was silently discarded when the mac-app main window was closed, because every hop sent the query without a receiver
surface: mac-app
component: quick-query
classification: our-bug
problem_class: other
first_bad_boundary: mac-app/main/app/quickQuery.ts `quick-query:submit` handler — `if (mainWindow !== null && hasContent)` returned `{ success: true }` without sending when the main window was closed
symptoms:
  - "quick launcher sometimes doesn't work"
  - "main app isn't loaded up"
  - launcher closes after Enter and no agent is created
  - quick-query:submit
  - "[QuickQuery] Submit held for main window"
tags:
  - mac-app
  - electron
  - quick-launcher
  - global-shortcut
  - ipc
  - event-before-listener
  - window-lifecycle
  - did-finish-load
sources:
  - commit 996266553
  - PR #1447
repro: mac-app/tests/blackbox/electron-main.blackbox.ts
status: fixed
---

## Problem

The user reported: "when i use the quick launcher, sometimes it doesn't work cuz the main app isn't loaded up or something". Alt+Space opened the launcher, Enter closed it, and no agent appeared.

Runtime evidence, read from the installed app's logs at 23:00Z (one process, started `2026-10-07T15:31:00.767Z`):

- `mac-app-ipc-logs.log` showed the main-window renderer booting twice in that one process: `auth:check` + `onboarding:setComplete` at `15:31:01–02Z` and again at `22:55:25–26Z`.
- `mac-app-console-logs.log` showed `[App] main window shown` at `22:55:24.330Z` next to `reason=activate`, with bounds `{ x: 100, y: 104, width: 1609, height: 977 }`. The previous show at `18:34:45Z` had `{ x: -376, y: -1410, width: 2560, height: 1410 }`.

A second renderer boot with no app restart means the main window had been closed and was re-created by a dock click, minutes before the report. Rose keeps running on macOS after its window closes (`window-all-closed` only quits off darwin), so the global shortcut still opened the launcher during that gap.

Two evidence gaps:

- The submit path logged nothing, so the discarded submit itself was never in the log. The closed-window state is proven by the log; the discard is proven by the reproduction below. The installed build (`/Applications/Rose.app`, 1.1.196) carries the same handler.
- The log is truncated on every app start, and the app was restarted at `23:30:05Z` before a copy was saved. The lines quoted above are the surviving record. Copy a log before diagnosing from it.

## Diagnosis

Critical path: launcher renderer `submitQuickQuery` → `ipcMain` `quick-query:submit` (`main/app/quickQuery.ts`) → `mainWindow.webContents.send` → preload `ipcRenderer.on` (`main/domains/electron-preload/service-events.ts`) → `QuickQueryListener` (`ui/features/quick-query-listener.tsx`) → `dispatchQuickQueryEvent` (`front-end/src/lib/quickQuery.ts`) → `useQuickQuery` in Terminal → `createAgent`.

First bad boundary: the main-process handler. `main/index.ts` sets `mainWindow = null` in the window's `closed` callback; the handler then skipped the send and still returned success.

Local repro, at the wiring level (real `main/index.ts`, real controller, stubbed Electron):

```
cd mac-app && npx vitest run tests/blackbox/electron-main.blackbox.ts -t "quick-query: submit recreates a closed main window"
```

Pre-fix (production files at `996266553`, final tests):

```
AssertionError: expected "spy" to be called 3 times, but got 2 times
```

`BrowserWindow` was constructed twice (main + launcher) and never a third time: no window, no delivery.

Step 5a:

1. Why was the query lost? The handler had no main window to send to and treated that as nothing to do.
2. Why was that even possible? The path was fire-and-forget at every hop, and no hop checked that its receiver existed. Two more hops had the same gap. Each is reachable on its own in the installed build (cold start, Cmd+R, Terminal unmounted), produces the same symptom, and the log could not have told them apart:
   - main → renderer: the renderer registered `ipcRenderer.on('quick-query:submit')` only inside a React effect, so a send into a window that was not listening yet was lost. Pre-fix: `expected [] to deeply equal [ [ 'quick-query:take' ] ]` (`electron-preload.blackbox.ts`, "takes the submits the main process is holding as soon as it subscribes").
   - renderer → Terminal: the shell renders a loading screen while auth and onboarding resolve (`ElectronAppInner.tsx`), and Terminal is unmounted on `/about`, `/privacy` and `/terms`, so the window `CustomEvent` fired with no listener. Pre-fix: `expected "vi.fn()" to be called 1 times, but got 0 times` (`quick-query-attachments.blackbox.ts`, "launches a submit that was dispatched before the hook mounted"). Terminal's own `useAuth()` also starts with `loading: true`, `isFullySignedIn: false`, so a submit handled then sent a signed-in user to the login modal. Pre-fix: `expected "vi.fn()" to not be called at all, but actually been called 1 times` (`setLoginModalOpen`).
3. Why did the deep link not have this bug? `openAppFromDeepLink` already re-creates the window and the preload registers `open-agent` eagerly with a pending slot. The launcher was written without that contract. Stop: the next "why" is a design choice, and the fix lives at rung 2.

Problem class: an event sent to a receiver that may not exist yet, with success reported regardless. No taxonomy bucket fits (`other`); candidate bucket: "delivery without a registered receiver".

Why the fix does not infer readiness from load state. The first version waited on `did-finish-load` when the window was loading. Two probes against the real Electron 31.7.7 runtime (hidden window, local HTTP page) showed that inference is unsound:

- While an iframe added to an already-loaded page was loading, `isLoading()` was `true` and `isLoadingMainFrame()` was `false`; when it finished only `did-frame-finish-load main=false` fired. Waiting on `did-finish-load` because `isLoading()` is true never completes while a live browser view loads.
- Inside the `did-finish-load` handler itself, `isLoadingMainFrame()` was still `true` in 5 of 5 loads; it was `false` by `did-stop-loading`. A submit handled between those two events would wait for an event that has already fired.

Archive searches: `quick launcher submit dropped main window closed mac-app`; `quick-query:submit webContents.send renderer not loaded listener missing event lost`; `event sent before listener registered dropped silently renderer not ready`; `grep -ril "quick.?query|quick launcher" docs/rca/`. No prior case. Novel.

Golden reference: `hermes-agent/apps/desktop/electron/main.ts:19230-19234` holds a deep link in the main process (`_pendingDeepLink`) when the renderer is not ready or the main window is missing or destroyed; `:19249-19265` flushes it once when the renderer calls `hermes:deep-link-ready` after mounting its listener; `:15300-15306` resets readiness when the main window closes. The fix converges on that: the main process owns the queue and the renderer says when it can receive, here by taking. Hermes leaves the link pending when no window exists; Rose re-opens the window, because the user asked for the launcher to open the app. `claude-code-src/` and `openclaw/` have no Electron delivery code (`did-finish-load`, `webContents.send`, `ipcRenderer.on`: no matches). `codex/` was not on this host and was not cloned: the disk was at 99%. The Hermes and OpenClaw clones read were in `~/Developer/rose-daily50-final-control12-20261007/`.

Adversarial review (Step 7) changed the fix: it found that held submits had no age bound, that Terminal is unmounted on the legal routes, that delivery was not logged, and that readiness was inferred. All four are addressed below. It also found three weak assertions, since corrected. A second independent review of the final diff found no blocking defect and three small issues (expired-toast wording with files, an unguarded throw path, a non-finite timestamp), also addressed below. CodeRabbit's review of PR #1447 then asked for serialized launches, every expired draft kept, a bound on the renderer queue, and a submit retained until acknowledged; the take-and-claim protocol below is the result.

## Solution

The main process holds each submit until the main window's consumer claims it:

- `main/app/quickQuery.ts` + `quickQueryHeldSubmits.ts`: the submit handler queues the query with an id, calls the new `openMainWindow` option (`handleActivate` in `main/index.ts`: re-create if closed, restore if minimized, show, focus) and sends `quick-query:pending`. `quick-query:take` lists what is held without removing it; `quick-query:claim` removes one submit, once, for the main window's renderer only. Each step is logged. At most 20 submits are held. The handler accepts and keeps the query even if opening the window throws; a rejected IPC would re-enable the launcher and a retry would queue the query twice.
- `service-events.ts`: `onQuickQuerySubmit` lists on subscribe and again on every `quick-query:pending`, forwards each held submit once with its claim, and returns a disposer. Delivery no longer depends on load events.
- `ui/features/quick-query-listener.tsx`: returns to the Terminal route, then forwards the submit and its claim.
- `front-end/src/lib/quickQuery.ts`: `dispatchQuickQueryEvent` holds submits (at most 20) until a consumer calls `subscribeQuickQuery`, and claims a submit only then, in order. `useQuickQuery` subscribes only once `authReady` (`!auth.loading`) and launches one submit at a time.
- A submit held longer than 60 s (`QUICK_QUERY_LAUNCH_WINDOW_MS`) is not launched: its text is put in the input with a toast that says when attached files must be added again; several that expire together are all kept. An agent costs money, and a late one is not what the user asked for. `normalizeQuickQueryPayload` replaces a non-finite `submittedAt`, which would never expire.
- `main/index.ts`: `openAppFromDeepLink` now checks `isLoadingMainFrame()`, which fixes the embedded-frame case for deep links.

The claim is made before the consumer acts, so delivery is at most once: a renderer that reloads, crashes or closes before claiming leaves the submit in the main process for the next window. The loss window is the claim's own round trip. Acknowledging after the consumer acts would close that window but could launch the same paid query twice.

Post-fix, the same tests pass unchanged, and the full mac-app and front-end suites pass.

Not done:

- Not exercised in the packaged app. Proof is the wiring-level blackbox suites plus the two runtime probes.
- `openAppFromDeepLink` still waits on `did-finish-load`, so the sub-millisecond gap from the second probe remains on that path. Moving deep links to the same take-and-claim model would close it.
- Once the auth check has resolved as signed out, a held submit opens the login modal and keeps only its text, as a live submit always has.

Also repaired because the mac-app structural suite was already red on main (5 violations from the connectivity chip): the chip portal moved to `ui/shared/bottom-left-chips`, and `connectivity-indicator` gained its `types.ts` and `api.ts` layers.

10k-agent: nothing here scales with agent count. One submit is one queue entry, three IPC messages and one `createAgent`; both queues are bounded at 20.

## Human feedback

The user asked for the behavior directly: "make sure it opens the main app then launches it in that case". None recorded beyond that.

## Reusable lesson

When the main process hands work to a renderer, keep it queued in the main process until that renderer asks for it; never report success from a branch that skipped delivery, and never infer a renderer is listening from Electron load events.
