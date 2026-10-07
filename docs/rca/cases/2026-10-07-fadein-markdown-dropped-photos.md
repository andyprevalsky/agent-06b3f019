---
id: 2026-10-07-fadein-markdown-dropped-photos
date: 2026-10-07
title: Default MarkdownText path dropped photos because FadeInMarkdown reconstructs only text nodes
surface: front-end
component: MarkdownText / FadeInMarkdown
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/components/MarkdownText.tsx — static FYI/tool/plan bubbles used FadeInMarkdown, whose extractWords walk keeps only text nodes and silently drops <img>
symptoms:
  - I can't display images in this chat
  - This chat has no image display
  - Show me photos of both places
  - U can show photos
  - FadeInMarkdown
tags:
  - markdown
  - photos
  - fade-in-markdown
  - attention-message
  - chat
  - file-pointer
sources:
  - agent 3be856d5-e4fe-4eb5-b30e-ea99d44793fe
repro: front-end/src/tests/blackbox/markdown-text.blackbox.tsx (renders markdown photos on the default static path used by FYI attention bubbles)
status: fixed
---

## Problem

Prod agent `3be856d5-e4fe-4eb5-b30e-ea99d44793fe` (Mac app, title "Embarcadero Gaming Cafe") finished a cafe search, then the user asked **four times** to see photos of Cyber Racoon and Euphnet. Chat answered with send_message_to_user FYI bubbles:

- "I can't display images here."
- "I can't show images in this chat."
- "This chat has no image display."

The user replied "U can show photos" and later set `photos_shown: list[file_pointer]`.

Those FYI bubbles render through `AttentionMessage` → `MarkdownText` with `shouldAnimate=false`. The default MarkdownText path sent that text through FadeInMarkdown. `extractWords` walks the rendered DOM and keeps only text nodes, so a markdown photo (`![alt](url)`) becomes a caption with no `<img>`. Local repro on the buggy path: `MarkdownText` of `![Cyber Racoon PC Cafe](https://www.cyberracoon.com/gallery/room.jpg)` produced `img=null` and only the caption text "Cyber Racoon interior:".

**Archive searches:** `photo display image broken`, `image attachment photo render display`, `can't display images chat photos file_pointer`, `web_fetch image file_pointer show photos user`. No prior case on this renderer boundary. Relative of SMS/attachment file_pointer cases, not a recurrence.

## Diagnosis

**Critical path:** user "Show me photos" → chat router/generator (text-only send_message_to_user) → AttentionMessage FYI → MarkdownText (shouldAnimate=false) → FadeInMarkdown extractWords → renderWords → user sees no photo.

**First-bad display boundary:** static markdown used a text-only reconstruction. The `breaks=true` path already used ReactMarkdown and would have kept the photo. FYI bubbles did not set `breaks`, so photos were dropped.

**Step 5a:**
1. User sees no photos in the FYI bubble.
2. FadeInMarkdown dropped the `<img>` (proof: the failing blackbox HTML had the caption and no img).
3. Static rendering used the animation extractor even when it was not animating. The more general class is "a second renderer that cannot represent every GFM node."

Sibling failures of the same gap: tables, raw HTML, and any other non-text markdown node on the default static path.

Related but separate: chat routed "show me photos" to `direct_answer` and the generator refused instead of `start_superintelligence` (file_pointer / browser capture). That is a prompt-contract gap and is not this display fix.

## Solution

Delete the failure surface on the static path: `MarkdownText` uses ReactMarkdown whenever `shouldAnimate` is false (GFM; remark-breaks only when `breaks=true`). FadeInMarkdown now keeps `<img>` nodes so the animated path also shows photos.

Cemented by:
- `front-end/src/tests/blackbox/markdown-text.blackbox.tsx` — static and animated markdown photos render `<img src>` / `alt`
- `front-end/src/tests/blackbox/message-bubble.blackbox.tsx` — finished FYI attention bubble shows the markdown photo

**10k-agent behavior:** O(1) per message render; no extra subscriptions, queries, or broadcasts. ReactMarkdown is the path the `breaks` bubbles already used.

**Golden reference:** `claude-code-src/src/utils/markdown.ts:139` formats a markdown `image` token to `token.href` rather than dropping it. Rose's web renderer now keeps the image node (converges on "do not discard the image token").

## Human feedback

None recorded.

## Reusable lesson

Never reconstruct static markdown through a text-only word list — if GFM can emit an `<img>`, the default chat renderer must keep it.
