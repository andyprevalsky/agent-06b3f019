---
id: 2026-10-07-fadein-markdown-dropped-photos
date: 2026-10-07
title: Agent markdown rendered through second renderers (FadeInMarkdown word list, StreamingText, plain transcript text) dropped photos, tables and code structure
surface: front-end
component: MarkdownText / FadeInMarkdown
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/components/MarkdownText.tsx — static FYI/tool/plan bubbles used FadeInMarkdown, whose extractWords walk keeps only text nodes and silently drops <img>
symptoms:
  - FadeInMarkdown
  - raw pipes
  - literal backticks in Claude Code reply
  - node="[object Object]"
  - code agent stdout one paragraph
tags:
  - markdown
  - photos
  - fade-in-markdown
  - attention-message
  - chat
  - file-pointer
  - tables
  - code-agent
  - streaming
sources:
  - agent 3be856d5-e4fe-4eb5-b30e-ea99d44793fe
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82
  - agent ddf91c56-26fd-406f-b361-9a1bfc3b1fbb
  - agent 0e16359e-0df7-4424-91b9-0e5b8643ccf4
repro: front-end/src/tests/blackbox/agent-markdown-rendering.blackbox.tsx (prod fixtures; 8 of 13 fail on main 75d1b1df8) and markdown-text.blackbox.tsx (photos)
status: fixed
---

## Problem

Discovered while investigating agent `3be856d5-e4fe-4eb5-b30e-ea99d44793fe`. That incident's first-bad is the chat router choosing `direct_answer` and refusing (case `2026-10-07-chat-router-pointer-as-satisfaction`). This case is the sibling display bug: FYI bubbles render through `AttentionMessage` → `MarkdownText` with `shouldAnimate=false`. The default path sent that text through FadeInMarkdown. `extractWords` walks the rendered DOM and keeps only text nodes, so a markdown photo (`![alt](url)`) becomes a caption with no `<img>`. Local repro on the buggy path: `MarkdownText` of `![Cyber Racoon PC Cafe](https://www.cyberracoon.com/gallery/room.jpg)` produced `img=null` and only the caption text "Cyber Racoon interior:". The prod refusal turns never emitted markdown photos, so fixing this renderer does not close that incident.

**Archive searches:** `photo display image broken`, `image attachment photo render display`, `can't display images chat photos file_pointer`, `web_fetch image file_pointer show photos user`. No prior case on this renderer boundary. Relative of SMS/attachment file_pointer cases, not a recurrence.

## Diagnosis

**Critical path:** user "Show me photos" → chat router/generator (text-only send_message_to_user) → AttentionMessage FYI → MarkdownText (shouldAnimate=false) → FadeInMarkdown extractWords → renderWords → user sees no photo.

**First-bad display boundary:** static markdown used a text-only reconstruction. The `breaks=true` path already used ReactMarkdown and would have kept the photo. FYI bubbles did not set `breaks`, so photos were dropped.

**Step 5a:**
1. User sees no photos in the FYI bubble.
2. FadeInMarkdown dropped the `<img>` (proof: the failing blackbox HTML had the caption and no img).
3. Static rendering used the animation extractor even when it was not animating. The more general class is "a second renderer that cannot represent every GFM node."

Sibling failures of the same gap: tables, raw HTML, and any other non-text markdown node on the default static path.

Related but separate: chat routed "show me photos" to `direct_answer` and the generator refused instead of `start_superintelligence`. That incident lives in `2026-10-07-chat-router-pointer-as-satisfaction` and remains open.

## Solution

Delete the failure surface on the static path: `MarkdownText` uses ReactMarkdown whenever `shouldAnimate` is false (GFM; remark-breaks only when `breaks=true`). FadeInMarkdown now keeps `<img>` nodes so the animated path also shows photos.

Cemented by:
- `front-end/src/tests/blackbox/markdown-text.blackbox.tsx` — static and animated markdown photos render `<img src>` / `alt`
- `front-end/src/tests/blackbox/message-bubble.blackbox.tsx` — finished FYI attention bubble shows the markdown photo

**10k-agent behavior:** O(1) per message render; no extra subscriptions, queries, or broadcasts. ReactMarkdown is the path the `breaks` bubbles already used.

**Golden reference:** `claude-code-src/src/utils/markdown.ts:139` formats a markdown `image` token to `token.href` rather than dropping it. Rose's web renderer now keeps the image node (converges on "do not discard the image token").

## Recurrence 2026-11-06: tables, streaming and code-agent replies (C16)

**Evidence.** In Rose-on-Rose run "Rose Repo Status" (root `1a3d495c-826c-4eca-afe0-382fcbf72e82`, Claude Code task `6f8f8f4d-c670-4bc8-b5df-e2c785c4a908`), the user's screenshots S5/S6 show Claude Code's final reply with literal backticks, `**` and ``` fences, and its git log run together as one paragraph. Prod rows (read-only) give the exact reply text: inline code, bold and a fenced block. Root replies with real GFM tables (agent `ddf91c56-26fd-406f-b361-9a1bfc3b1fbb`) and with headings and nested lists (agent `0e16359e-0df7-4424-91b9-0e5b8643ccf4`) were rendered in a local FE (backend :3741, FE :3742, isolated DB `victoria_lane_d`) and with Playwright.

**Archive searches:** `markdown table raw pipes literal backticks code agent reply plain text MarkdownText`, `FadeInMarkdown extractWords animated markdown lost formatting streaming text`. Top hit for both: this case. **This is a recurrence.**

**Why the earlier fix did not hold.** The 2026-10-07 fix took the static path off the word list but kept FadeInMarkdown reconstructing markdown through `extractWords` → `renderWords`, and patched `<img>` into the extractor. It fixed the instance (photos), not the class ("a second renderer that cannot represent every GFM node"). That case's Step 5a had already named tables as a sibling. Other second renderers also existed outside MarkdownText: `StreamingText` (raw spans) and the code-agent transcript's plain-text rows.

**Local repro (failed on main 75d1b1df8, 8 of 13):** `cd front-end && npx vitest run src/tests/blackbox/agent-markdown-rendering.blackbox.tsx`
1. Fading in: the table flattened into run-on words ("FieldResponse plan First/last name …"). h2/h3 and nested lists were lost.
2. Streaming (`AttentionMessage isStreaming`): `StreamingText` printed raw markdown with newlines collapsed, so no `<table>` rendered.
3. Settled: the table had no scroll container, only `display:block` on `<table>`. `overflow-wrap: anywhere` broke cell words mid-word ("discover ed", "LinkedIn/socia l").
4. Code-agent command output: `codeSessionTurns.activityMessage` handed raw stdout to MarkdownText, so 61-line outputs became one paragraph and hostnames were linkified.
5. `MarkdownLink` spread react-markdown's `node` prop onto every `<a>` (`node="[object Object]"`).
6. Single newlines in agent replies ("**Open PRs:** 262⏎**Open issues:** 8") rendered on one line.
The code-agent chip transcript (`codeAgentChip.steer.tsx` `CodeAgentTranscript`, S5) also printed replies as plain text. Lane B is deleting that view and routing the code agent through the shared message list, so this lane tests that the shared path renders the same real reply.

**Step 5a.** (1) The user sees markdown syntax and broken tables. (2) The rows reached the screen through renderers other than the shared ReactMarkdown tree: the word list, `StreamingText` and the plain transcript. Proof: the failing assertions above, plus the pre-fix Playwright shots. (3) Nothing enforced a single render path for agent text. Each surface or animation state picked its own. The next rung, "every text surface in the app," is not one owned contract: documents, SMS previews and user bubbles intentionally differ. Stop at "agent replies and code-agent output."

**Fix (front-end only, no prompt changes).**
- Delete: `extractWords.ts`, `renderWords.tsx`, `renderBlocks.tsx`, `renderInlineGroup.tsx` and `StreamingText.tsx`.
- Animated path: `FadeInMarkdown` renders the same ReactMarkdown tree as the static path. A rehype pass (`fadeWords.tsx`) wraps each word in a staggered motion span. Completion ownership is unchanged: only the committed, mounted generation calls `onComplete`.
- Streaming: answers render through `MarkdownText`.
- One component map (`markdownComponents.ts`): `MarkdownTable` gives each table a scroll container; `MarkdownLink` passes only href/title.
- Styles (`MarkdownStyles`): whole-word table cells, neutral dark borders and code colors, and tighter list and code-block spacing.
- Final answers: `AttentionMessage` passes `breaks`, and the animated path now honors `breaks`.
- Code-agent output: the projection fences command output (`lib/fenceTerminalOutput.ts`), and linkify protection is fence-length aware.

**Regressions (frontend-vitest lane, /deploy Step 4b):** `agent-markdown-rendering.blackbox.tsx`, `agent-markdown-benchmark.blackbox.tsx` (also the benchmark check: `front-end/scripts/check-agent-markdown.sh`), migrated `markdown-text`, `massive-markdown-rendering` and `message-bubble` cases.

**10k-agent behavior:** client-side, per rendered message. The rendering is a single ReactMarkdown parse, where the old animated path did a hidden render plus a DOM walk. No subscriptions, queries or broadcasts are added.

**Golden reference:** not applicable (no approval-gated hunk).

## Human feedback

2026-11-06 (via the orchestrator) the user said its not a prompt change, we are talking about within the code agent too. C16 is FE rendering only; markdown and tables must render inside the code-agent view as well as the root. The user called the code-agent UI "super jank" and asked that tables display well and that all agent markdown be human-readable. Do not edit the bespoke code-agent transcript; Lane B is replacing it with the shared message list.

## Reusable lesson

Render every agent reply (streaming, fading in or settled; root or code agent) through the one ReactMarkdown tree, and hand it terminal output as a fenced block; never rebuild markdown through a second renderer.
