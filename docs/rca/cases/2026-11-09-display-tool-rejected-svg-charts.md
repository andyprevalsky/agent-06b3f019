---
id: 2026-11-09-display-tool-rejected-svg-charts
date: 2026-11-09
title: display rejected the agent's SVG revenue chart because SVG was deliberately excluded
surface: back-end
component: agent-tools-display
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/agentTools/media.ts classifyDisplayMedia returned null for SVG (no magic bytes, not declared HTML), so displayService rejected it with "is not a displayable file (... SVG excluded)"
symptoms:
  - "is not a displayable file (allowed: image/*, video/*, an .html page, a .js/.mjs script, a 3D model (.glb .gltf .obj .stl .usdz), a .pdf, or a site folder; SVG excluded)"
  - "Invalid media: chart.svg (SVG excluded)"
  - "revenue chart .svg could not be displayed"
tags:
  - display
  - svg
  - agent-tools
  - xss
  - image
sources:
  - benchmark run revenue-chart (display of the agent's SVG chart rejected)
  - memory: owner decision 2026-11-09 (Andy), the display tool must accept SVG
repro: back-end/src/tests/unit/display-svg-prepare.test.ts
status: fixed
---

## Problem

The revenue-chart run produced its chart as an SVG and called `display` on it.
The backend refused it: `media.ts` documented "SVG is deliberately excluded", and
`TYPES_HELP` told the model "SVG excluded". The same rejection applied to the main
agent, code agents and the rose CLI/MCP path, which all go through
`displayService.prepareSingle`.

## Diagnosis

`classifyDisplayMedia` decides binary images from magic bytes and accepts markup
only as a declared HTML page. SVG is text with no magic bytes, so an undeclared or
`.svg` file returned `null`. The exclusion was a safety choice (an SVG can carry
`<script>` and event handlers), but the display renderer only ever shows images
through `<img>`, where browsers never run SVG scripts.

## Solution

- `looksLikeSvg`: UTF-8 text without NULs whose root element (after an optional
  BOM, XML declaration, comments and SVG doctype) is `<svg>`. A `.svg` name or an
  `image/svg+xml` response must be an SVG root, else it is refused; an undeclared
  SVG root is an SVG image; a declared `.html` page stays `text/html`. Stored as
  `image/svg+xml` at `<owner>/display/<sha>.svg`, kind `image`, with no
  usercontent page URL, so it is never framed or served as a page.
- `TYPES_HELP` (model-visible) now says `image/* (including .svg)` and drops
  "SVG excluded".
- Safety: the FE renders display images only through `<img>` (inline gallery and
  preview drawer; no SVG markup is inlined anywhere). An SVG opened as a page would
  run its scripts on the storage origin, so every signed SVG URL (backend
  `getSignedUrl` and FE client signing) forces a download
  (`Content-Disposition: attachment`); `<img>` ignores the disposition.

Regressions: `display-svg-prepare.test.ts` (unit: classification, preparation,
download signing), the `agent-tools` blackbox case "display shows an SVG as an
image stored with image/svg+xml, never as a page" (main's "SVG → 400" assertion now
checks HTML renamed `.svg` → 400), the Chromium render case "a displayed SVG never
runs its script or onload as an <img> (a document would)" with a positive
control, and FE `inline-media.blackbox.tsx` SVG cases. Existing image, HTML and PDF
cases are unchanged.

## Human feedback

Andy (2026-11-09): the display tool must accept SVG; no script in an SVG may run
in our app.

## Reusable lesson

Accept a risky format by constraining how it is rendered (image-only, download on navigation), not by excluding it.
