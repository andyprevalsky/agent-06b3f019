# Live agent display and StreamDiffusion

Rose already exposes the `display` tool to the root agent. A code agent's
published display is mirrored into the owning Rose conversation. The frontend's
Agent Display panel shows those existing display records. This guide adds a
reusable **live HTML control bridge**, not another video-generation tool.

## What works without a GPU

`scripts/live_display/server.py` serves a WebGL watch-inspired visual and a
read-only state feed. The agent can change the prompt, color, motion speed, or
selected renderer with its normal shell/code tools. Changes reach the open
HTML in about one polling interval (500 ms plus network time), without another
`display` call or iframe reload. The visual is procedural artwork, not a CAD
model or a manufactured watch design.

Run the server in the agent's existing workspace. `--public-url` must be the
**actual user-reachable HTTPS origin** routed to this server; a devbox's localhost
address cannot serve a remote user's Agent Display. The server binds loopback
by default. Use an existing authenticated/public ingress with a dedicated
route rather than binding every service on the machine.

```bash
python3 scripts/live_display/server.py serve \
  --state /workspace/live-display/state.json \
  --port 7861 \
  --public-url https://YOUR-EXISTING-DISPLAY-ORIGIN \
  --write-html /workspace/live-display/studio.html
```

The generated HTML contains only a random **read-only viewer capability**, not
Rose's API keys or the upstream URL. It remains usable from display's opaque
sandbox (`Origin: null`, no cookies). Treat the generated HTML/link as private;
restart the server to revoke the capability. There is no public settings-write
endpoint. Keep the state file and command execution on the agent's own host.

Call the existing Rose tool once, with the file in that agent's accessible tree:

```json
{ "tool": "display", "paths": ["studio.html"], "caption": "Live design studio" }
```

Then steer it using normal agent execution:

```bash
python3 scripts/live_display/server.py set \
  --state /workspace/live-display/state.json \
  --prompt 'Brushed titanium watch, cyan accents, sapphire crystal' \
  --hue 185 --speed 0.7 --mode webgl
```

Prompt text changes the caption and the diffusion input. It does not magically
rewrite the WebGL shader. Edit the HTML/shader through the normal coding tools
for structural design changes and publish that changed file again.

## Optional live diffusion images

Use a running instance of the upstream
[StreamDiffusion realtime-txt2img demo](https://github.com/cumulo-autumn/StreamDiffusion/tree/main/demo/realtime-txt2img).
Its `/api/predict` contract accepts `{"prompt":"..."}` and returns
`{"base64_image":"<JPEG>"}`. This is repeatedly generated imagery, not a
Seedance/video job and not an authoritative CAD geometry engine.

Add `--upstream http://127.0.0.1:7860` **on the GPU host** (or an existing trusted
service URL reachable from the bridge). No GPU is allocated or model downloaded
by this bridge. If the service needs additional authentication, put it behind a
local authenticated proxy; do not place secret headers in displayed HTML.

```bash
python3 scripts/live_display/server.py set \
  --state /workspace/live-display/state.json \
  --prompt 'Detailed mechanical watch, macro studio render, rose gold case' \
  --mode diffusion
```

Frames are requested only while the visible viewer selects diffusion and is
not paused. There is at most one inference request in flight, a 500 ms shared
cache, a 20-second upstream timeout and an 8 MiB response limit. A settings
change during inference discards the stale result. Failures stay visible; the
WebGL renderer remains available. A configured URL is not proof of GPU/model
readiness or of any FPS target.

For upstream's live **image-to-image** screen/camera protocol, use its separate
WebSocket + MJPEG demo. This adapter intentionally targets only the documented
text-to-image API; it does not pretend text-to-image is screen capture.

## Verification and limits

```bash
python3 -m unittest discover -s scripts/live_display -p 'test_*.py'
```

The tests use real local HTTP servers and a deterministic upstream fixture.
They check read-only capability access, live revisions, validation, bounded
frame reuse and stale-frame rejection. They do **not** verify GPU inference.
This devbox has no NVIDIA device attached; a live StreamDiffusion render and a
real Rose-agent-to-production-display run remain unverified until a reachable
GPU service and a signed-in Rose session are available.

Stop the exact server process when the display is no longer needed; do not
leave an inference service running for a closed demonstration.
