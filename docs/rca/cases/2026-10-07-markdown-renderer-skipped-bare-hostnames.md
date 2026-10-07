---
id: 2026-10-07-markdown-renderer-skipped-bare-hostnames
date: 2026-10-07
title: MarkdownText left bare hostnames as plain text because GFM autolinkLiterals require a scheme or www
surface: front-end
component: markdown-text
classification: our-bug
problem_class: other
first_bad_boundary: front-end MarkdownText / remark-gfm autolinkLiterals — stored `(bytescafesa.com)` never became an <a href>
symptoms:
  - "Links should be hyperlinked"
  - "bytescafesa.com"
  - send_message_to_user
  - MAC_APP
  - "may be a mac-app issue / fe issue"
tags:
  - markdown
  - autolink
  - hostname
  - send-message-to-user
  - mac-app
  - remark-gfm
sources:
  - agent 3be856d5-e4fe-4eb5-b30e-ea99d44793fe
repro: front-end/src/tests/blackbox/markdown-text.blackbox.tsx
status: fixed
---

## Problem

Prod Mac-app agent `3be856d5-e4fe-4eb5-b30e-ea99d44793fe` answered "where can i find a proper gaming cafe..." via `send_message_to_user`. The stored attention text (message `8536f4f9-64c4-407c-83f1-d0069e6f8cfe`, 1070 bytes from `GET /api/agents/3be856d5-e4fe-4eb5-b30e-ea99d44793fe`) contains parenthetical hostnames, not markdown links:

```
**Bytes Cyber Café** (bytescafesa.com)
**Mixer eSports + Cafe** (mixeresports.com)
**JB Gaming Cafe** (jbgamingcafe.com)
```

The user-visible bubble rendered those tokens as plain text. The reporter asked for them to be hyperlinked and suspected mac-app or FE.

Exact stored bytes are pinned at `front-end/src/tests/blackbox/fixtures/agent-3be856d5-attention.txt` (byte-equal to the GET `text` field).

## Diagnosis

Critical path: LLM `send_message_to_user` text → DB `Message.text` → FE `AttentionMessage` → `MarkdownText` → remark-gfm → `FadeInMarkdown`/`extractWords` → `<a>` or plain text. The mac-app aliases `@` to `front-end/src` and already `openExternal`s outbound `<a href>` via `will-navigate` / `setWindowOpenHandler`.

Midpoint: the stored string is a valid write (bare hostnames, no scheme). Data first goes wrong at render: remark-gfm `autolinkLiterals` emit `<a>` only for `http(s)://` and `www.`, not `example.com`.

Local repro on the exact stored text, default `FadeInMarkdown` path:

```
cd front-end && vitest run src/tests/blackbox/markdown-text.blackbox.tsx -t "hyperlinks"
```

Pre-fix (HEAD `0ad1b9d91`, before the linkify pass):

```
expected [] to deeply equal ArrayContaining [
  "https://bytescafesa.com",
  "https://mixeresports.com",
  "https://jbgamingcafe.com",
]
```

A sibling assertion showed `https://bytescafesa.com/lounge` already became an `<a>` (GFM). `www.jbgamingcafe.com` became `http://www.jbgamingcafe.com`. So the first-bad gap is specifically schemeless hostnames.

Step 5a:

1. Why no `<a>`? GFM autolinkLiterals omit bare hosts.
2. Why no extra pass? `MarkdownText` treated GFM as the whole "looks like a URL" policy.
3. Prompting the model to emit `[label](url)` is the wrong layer: paste, tool text, and future models still emit bare hosts. The renderer owns the sink contract.
4. Persist-time rewrite of `Message.text` would mutate the LLM transcript and fight the SMS "never emit markdown into SMS" sibling. Stay at render time.
5. A 35-TLD allowlist would miss `google.de`. The class is "hostname-shaped token without scheme", not ".com only". Filename-like final labels (`js`, `ts`, `json`, …) stay denylisted.

Archive searches: `links hyperlinked markdown url render`; `link not clickable mac-app frontend message markdown`; `remark-gfm autolinkLiterals AttentionMessage send_message_to_user hostname`; `bytescafesa hyperlink bare hostname MarkdownText`. No prior case at this boundary. Relative (opposite direction): `2026-08-05-sms-approval-markdown-and-truncated-drafts` — that case forbids markdown in SMS; this case requires hyperlinks in the FE/mac-app markdown sink. Novel at `MarkdownText`.

Golden reference: `claude-code-src/src/components/shell/OutputLine.tsx:44` `linkifyUrlsInText` only matches `https?://`. The fix converges on a dedicated linkify pass in the render pipeline and extends it to the hostname class GFM and that analog omit. `openclaw/`, `hermes-agent/`, and `codex/` were absent in this workspace.

Linux cannot run the packaged Electron binary. The mac-app suspicion is closed at source-share + existing outbound navigation guards: once the shared renderer emits `<a href="https://…">`, the installed app already opens it externally.

## Solution

`normalizeMarkdownText` now runs `linkifyMarkdownText` after unescape so both `FadeInMarkdown` and the static `breaks` path wrap schemeless hostnames as `[host](https://host)` before ReactMarkdown. Protected segments (fences, inline code, existing `[label](url)`, HTML) are skipped. Filename-like TLDs and dotted versions (`1.2.3`) stay plain. `MarkdownLink` keeps only `http(s)` hrefs and sets `target="_blank"` `rel="noopener noreferrer"` so Electron uses `setWindowOpenHandler`.

Siblings also covered: `www.` upgraded to `https://`; country hosts such as `google.de`; the same captured text on `breaks={true}`.

10k-agent: per-message O(text length) string walk, no shared fan-in, no extra subscriptions.

Post-fix: the identical vitest file passed 28/28, including the captured-text assertions on both render paths.

## Human feedback

Reporter scoped the bug as "may be a mac-app issue / fe issue". No later corrections during this RCA.

## Reusable lesson

If user-visible text contains a hostname without a scheme, the markdown renderer must emit an `<a href>` — do not assume the model wrote `[label](url)` or that GFM autolinkLiterals cover the class.
