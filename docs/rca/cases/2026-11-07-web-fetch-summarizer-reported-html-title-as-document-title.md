---
id: 2026-11-07-web-fetch-summarizer-reported-html-title-as-document-title
date: 2026-11-07
title: web_fetch summarizer reported the page's HTML <title> as the document title and dropped its heading
surface: agents
component: web-fetch-summarizer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/summarize.py format_page_metadata / summarize_and_filter_links (HTML <title> forwarded under the bare label "title")
symptoms:
  - 'Declared evaluator smoke_rfc_semantics failed: The first unmet requirement is the exact document titles in the final structured output'
  - 'The title fields are "RFC 9110: HTTP Semantics" and "RFC 9111: HTTP Caching", rather than the required "HTTP Semantics" and "HTTP Caching"'
  - 'web_fetch summary "Title: RFC 9111: HTTP Caching" with no document heading'
  - background-agent-message-smoke intermittent FAIL (cloud job r001-j0005)
tags:
  - web-fetch
  - summarize-web-fetch
  - page-metadata
  - background-agent-message-smoke
  - provenance
sources:
  - agent 7b2a1efe-fff1-4147-a691-b4d69c25c5a7 (cloud smoke run 20261107-111844-1927539, Hub run 20261107-111844-1927539-m53c903592667)
  - PR #1749 (head 56bf43fe2b2dc8a09dbcfe2600f5122d6d11deef; follows case 2026-10-26-web-fetch-summarizer-dropped-head-only-page-metadata)
  - hub run 20261107-111844-1927539-m53c903592667
repro: agents/tests/blackbox/summarize.blackbox.py (test_summarize_page_metadata_labels_html_title_apart_from_document_title)
status: fixed
---

## Problem

background-agent-message-smoke failed its `smoke_rfc_semantics` judge: the
final structured output titled the documents "RFC 9110: HTTP Semantics" and
"RFC 9111: HTTP Caching" instead of "HTTP Semantics" and "HTTP Caching". Hub
transcript of agent 7b2a1efe: the RFC 9111 web_fetch result was only
`Title: RFC 9111: HTTP Caching`, with no document heading. The explore agent
then cited `title "RFC 9110: HTTP Semantics"` as official-page evidence, and
the root copied those quoted values into `title`. 1 of 45 retrievable Hub runs
of this task on 2026-11-07 failed this way. The other 44 passed, although many
of their summaries also had an unqualified `Title: RFC …` line.

## Diagnosis

The RFC Editor HTML page has `<title>RFC 9111: HTTP Caching</title>` and
`<h1 id="title">HTTP Caching</h1>`. Firecrawl returns the first as
`metadata.title` and the heading as `# HTTP Caching` in the markdown. Since
2026-10-26, `select_page_metadata` forwards that `title` to the summarizer as a
bare `title:` line under "PAGE METADATA (declared by the page, e.g. <meta>
tags)". The summarizer rule "Start with the source URL and page title" made the
model report that value as the unqualified "Title". Sometimes it also dropped
the document's own heading. The only remaining title evidence was then the
prefixed `<title>`, and the explore and root agents relayed it as the official
title.

Live replay (`summarize_and_filter_links`, the real Firecrawl scrapes of
rfc9110.html and rfc9111.html, the failing run's objective,
gpt-5.6-luna-foundry, 25 calls per page):

- **Pre-fix:** 12 of 50 summaries never stated the document's own title, and
  37 of 50 had an unqualified `Title: RFC …` line.
- **Post-fix:** 0 of 50 for both.

The deepest owned cause is provenance loss at the tool boundary: a head-only
fact was forwarded without saying which element it came from. The summary
format therefore could not keep a browser-tab label separate from the
content's title. Task-level gap: at about a 2% task failure rate, the
unchanged task was not run enough times on the buggy revision to fail locally.
The causal fail/pass pair is at the summarizer boundary. The exact task passed
locally on the fixed revision (agent 39a138b6-80d2-4343-a8a0-2d28351b5795);
its summaries labelled the value "declared HTML title" / "HTML page title".

## Solution

`format_page_metadata` renders the provider `title` as `html_title`. The block
header now reads "declared in the page's <head>, not its visible content;
html_title is the <title> element; report it as such, apart from the title the
document itself states". Only the excluded PAGE METADATA block changed. The
summarizer rules text is byte-identical, and the demo-cache regex accepts the
old and new headers. Recorded summarize_web_fetch rows, including
test-mass-agent-run-0, therefore keep their content keys; the key-parity
blackbox now also asserts that for an old-header prompt. The same change
prevents prefixed or suffixed site titles (`… | Site`) from replacing article,
paper or product headings on any web_fetch.

At 10k agents: the block grows by a constant 5 bytes per line plus the header.
There is no new state, query or call.

Golden reference:

- `openclaw/src/agents/tools/web-fetch-utils.ts:181-207` takes the title from
  the `<title>` token. `openclaw/src/agents/tools/web-fetch.ts:465-507` returns
  it as its own wrapped `title` field next to the body text.
- `hermes-agent/tools/web_tools_truncate.py:185-188` keeps `title` separate
  from `content`.
- `kimi-code/packages/agent-core-v2/src/app/web/providers/local-fetch-url.ts:138-146`
  keeps the article title apart from the `<title>` element.
- `claude-code-src/src/tools/WebFetchTool/prompt.ts:23-45` gives its secondary
  model only the page content, with no head title.

None of them merges the head `<title>` into the content's own title. Rose keeps
it as an explicitly labelled separate field.

## Human feedback

None recorded.

## Reusable lesson

When a tool forwards page metadata to a summarizing model, name each field by its source element so the model cannot present a browser label as the document's own content.
