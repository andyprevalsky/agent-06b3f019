# Examples

Reference implementations in ~/.rose/skills/rose-ui/examples/. Each one
passes `rose-ui check` and documents how to wire it at the top of its
index.html. Copy the folder into your bundle (root/, inline/<view>/ or
apps/<app>/) and add it to rose-ui.json.

- inline-hello — the smallest inline view (props, resize).
- shader-background — WebGPU shader background with a WebGL2 fallback;
  DPR-aware pixel budget, quality governor, pauses when hidden.
- agent-dashboard — live agent dashboard from rose:props, with View
  Transitions and a FLIP fallback; props.example.json shows the shape.
- particles-worker — OffscreenCanvas particles in a Web Worker, simulated at
  a fixed 120 Hz; blob: worker pattern for the sandbox.
- media-menu — animated menu decorations: lazy MP4 loops, AVIF/WebP stills in
  <picture>, sized and paused offscreen (8 KB of video, no GIFs).
- rose-os — "Rose OS" windowed shell: menu bar, dock, draggable windows, all
  transform-only.
- wasm-viz — Rust → WebAssembly reaction-diffusion; src/lib.rs is the source
  of viz.wasm (rebuild with build.sh).

To measure an example as is, copy it into your bundle under examples/ and run
`rose-ui check --examples`. Delete copies you do not use before
`rose-ui publish`.
