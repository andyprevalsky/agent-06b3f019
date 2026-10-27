# R1b proposal — runtime not applied

Base: `b0853214450c5716f648a863c8003fede03361b2`.
Proposed patch: [exact diff](2026-10-27-neutral-worker-hydration.patch), SHA256
`86e5c336f7b2673acbedcb29e044c45144a5e8e6b8f01b7c12045745c9c849da`.

All20 run.json hashes and initialization errors were independently checked.
The real producer/consumer and activity test reproduce the missing-realm error.
The same activity control passes against the proposal. Five initial/resume
context controls and50 credential controls pass. No task/evaluator change or
benchmark outcome claim is made.

Independent review by `ph713pr5yxbgrhp4j9d1tdvvqh8h2c2y` found all runtime
hunks GROUNDED. Full approval remains NOT_GROUNDED because no browser recording was attached to this zero-step
failure. The initial canonical API lookup returned404; I12 recovered HTTP200
with15 messages by publishing the exact captured run through the normal
publisher. Its validator confirms three terminal rows and zero recording
events or pointers. Recorder creation lies after the failing initialization
gather; no recording is fabricated. The last root response_schema dump was recovered and published through
the supported renderer; its seven-day HTTPS link was independently read back
by both author and reviewer. SHA256:
`accb93b0bceea82981283ce6006129d3d6c9ba3dd364927a6e04db92c3869153`.
Private signed URL, complete canonical review packet and test receipts remain
in the thread attachments and `.context/polar-r1b/`. No private config or
credentials are included in this packet.

## Opened primary mapping

- `back-end/src/domains/browser-session/service.ts:200` emits the exact neutral
  inventory for about:blank; `service.credential-error.ts:12` serializes it.
- `agents/domains/spawn_browser_agent_v3/handler.py:1708` establishes resume URL
  precedence; `:9170` performs JIT preparation; `:9266` reports no-origin state.
- Hermes d94b70f675205c2c046138997819428772cd2678,
  `tools/browser_camofox.py:284` creates neutral tabs;
  `tools/browser_vault_tool.py:179` has no origin for blank, and `:465` requires
  a matched real origin before filling secrets.
- OpenClaw76ddbf697fc263cc1bf89fe3f4d08d96ed4a43af,
  `extensions/browser/chrome-extension/modules/tab-eligibility.js:27` requires
  explicit controlled blank; `tab-access.js:20` does not recreate initial blank
  ownership from stale snapshots after navigation/restart.

The proposal passes explicit URL context and requires complete empty inventory
for the neutral branch. It preserves explicitly empty backend realm, rejects
web/unknown resume payloads, and leaves nonempty-realm/JIT behavior unchanged.
The actual backend resume endpoint omits auth_options; its existing legacy
path is outside this fix. Supplied-neutral resume controls are protocol tests,
not an end-to-end backend resume claim.

## Next exact proof

Resolve the publication/recording approval boundary using surviving evidence or
an explicit authorized exception; do not silently apply this patch. After
full clearance, apply the exact snapshot, run owning gates, and push a separate
row-tagged runtime commit. Only the parent coordinates the next unchanged paid
cohort. Historical20 task FAILs remain FAILs; all20 native resources were
reported released by their launch owner.
