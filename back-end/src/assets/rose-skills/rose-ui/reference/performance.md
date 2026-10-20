# Performance budgets (`rose-ui check`)

`rose-ui check` measures every manifest entry (add --examples, or name HTML
files) in headless Chromium at 1280x800 and exits 1 on any violation:

- frame rate: p50 >= 55 fps and p5 >= 30 fps on the main thread and in each
  worker that animates (target 60, 120 on ProMotion);
- no main-thread task over 50 ms while running (load-time ones are warnings);
- cumulative layout shift <= 0.1; no animation of layout properties (width,
  height, top, left, margin, padding, ...): animate transform/opacity/filter;
- stops when hidden: <= 2 callbacks/s (rAF + timers, page and workers) after
  a visibilitychange to hidden;
- prefers-reduced-motion: under reduce, no continuous motion (<= 0.1% of
  pixels changing per 400 ms, median of 3 intervals);
- size: <= 5 MB per entry folder, <= 1.5 MB of JS/WASM, <= 2 MB per media
  file, GIFs <= 512 KB (use MP4/WebM or animated WebP/AVIF instead);
- no uncaught errors; theme tokens valid.

`rose-ui perf [--entry path.html | --route /]` prints the numbers as JSON: fps
p50/p5 (main + workers), long tasks, layout shift, bytes loaded, a GPU memory
estimate. fps is judged on the better of two windows; on an overloaded host
(load above 1.25 per CPU) or a host that can't render a blank page at 55 fps,
missed fps budgets are reported as inconclusive warnings, not failures. The
sandbox has no GPU (software rendering), so GPU-heavy work measures slower
than on the user's device: budget for that, e.g. cap shader resolution.

## Rules of thumb

- Target 60 fps, 120 fps on ProMotion displays; no main-thread task > 50 ms.
- Render canvases at devicePixelRatio, with a pixel budget for heavy shaders.
- Animate only compositor properties (transform, opacity, filter); never
  animate layout (width, height, top, left, margin).
- Respect prefers-reduced-motion and prefers-reduced-transparency.
- Stop animation loops when hidden (document.visibilitychange) or offscreen
  (IntersectionObserver).
- Lazy-load and size media (width/height); prefer AVIF/WebP and MP4/WebM over
  large GIFs.
