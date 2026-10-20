# Examples

Reference implementations in ~/.rose/skills/rose-ui/examples/. Each one
passes `rose-ui check` and documents its technique at the top of its
index.html. Copy the parts you need into inline/<view>/ or apps/<app>/ and
add the entry to rose-ui.json.

- inline-hello — the smallest inline view (props, resize).
- agent-dashboard — a live dashboard from rose:props, with View Transitions
  and a FLIP fallback; props.example.json shows the shape.
- particles-worker — OffscreenCanvas particles in a Web Worker, simulated at
  a fixed 120 Hz; the blob: worker pattern for the sandbox.
- shader-background — a WebGPU shader with a WebGL2 fallback; DPR-aware
  pixel budget, quality governor, pauses when hidden.
- media-menu — lazy MP4 loops and AVIF/WebP stills in <picture>, sized and
  paused offscreen (8 KB of video, no GIFs).
- rose-os — draggable windows, a menu bar and a dock, all transform-only.
- wasm-viz — Rust → WebAssembly reaction-diffusion; src/lib.rs is the source
  of viz.wasm (rebuild with build.sh).

To measure an example as is, copy it into your folder under examples/ and run
`rose-ui check --examples`. Delete copies you do not use before
`rose-ui publish`.
