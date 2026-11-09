---
id: 2026-11-07-web-fetch-summarizer-reported-html-title-as-document-title
date: 2026-11-07
title: web_fetch summarizer reported the page's HTML <title> as the document title and dropped its heading
surface: agents
component: web-fetch-summarizer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/summarize.py select_page_metadata (HTML <title> forwarded to summarize_web_fetch as a bare "title" metadata fact)
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
repro: agents/tests/blackbox/summarize.blackbox.py (test_summarize_page_metadata_omits_html_title)
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
gpt-5.6-luna-foundry, 25 calls per page; script and outputs retained in
`.context/bams-rca/` on devbox 9c4f8215):

- **Pre-fix:** 12 of 50 summaries never stated the document's own title, and
  37 of 50 had a `Title: RFC NNNN: …` line.
- **Renaming the line to `html_title` under a provenance header:** 9 of 50
  still missed the title, so labelling alone does not fix it.
- **With the head title omitted (committed 7abbdee87):** 0 of 50 missed it,
  and 0 of 50 had a `Title: RFC NNNN:` line. An identical earlier run missed it
  in 1 of 50.

The deepest owned cause: a head-only browser label went into the summarizer as
though it were a page fact, beside an instruction to lead with the page title.
That made the summarizer more likely to replace the content's own heading.

Task-level gap: the task fails about 2% of the time, and it was not run often
enough on the buggy revision to fail locally. The causal fail/pass pair is at
the summarizer boundary. The exact unchanged task passed locally three times
on the fix's first revision (agents 39a138b6-80d2-4343-a8a0-2d28351b5795,
50254ed8-f689-4a5f-ae1d-e4542aaea889 and 67a40c33-8ef2-4344-99c4-f5443f9a8335), and passes again in the
deploy smoke gate on the final revision.

## Solution

`select_page_metadata` now forwards only one validated publication date, which
was the original 2026-10-26 need. The HTML `<title>` no longer reaches the
summarizer, so the summarizer reads the title from the page content, as Claude
Code's WebFetch secondary model does. The summarizer rules and the PAGE
METADATA header are byte-identical. Pages with only a title now produce the
prompt they produced before the metadata block existed.

The block is still excluded from the demo-cache key, so summarize_web_fetch
replays, including test-mass-agent-run-0, keep their keys. The same change
stops prefixed or suffixed site titles (`… | Site`) from replacing article,
paper or product headings on any web_fetch.

At 10k agents, each prompt shrinks by at most 256 characters. There is no new
state, query or call.

Golden reference:

- `claude-code-src/src/tools/WebFetchTool/prompt.ts:23-45`, the closest analog,
  gives its secondary summarizer only the page content: no head metadata, no
  title.
- `openclaw/src/agents/tools/web-fetch-utils.ts:181-207` and
  `openclaw/src/agents/tools/web-fetch.ts:465-507` capture the `<title>` and
  return it to the agent as a separate `title` field beside the body, with no
  instruction.
- `hermes-agent/tools/web_tools_truncate.py:184-191` keeps `title` separate
  from `content` and has no summarizer.
- Contrary: `kimi-code/packages/agent-core-v2/src/app/web/providers/local-fetch-url.ts:138-146`
  prepends Readability's `<title>`-derived title to the body as `# <title>`.
  That is the conflation this RCA measured; Rose does not follow it.

No reference feeds the `<title>` into a summarizer prompt.

A first candidate relabelled the line as `html_title`, with a header telling
the summarizer to report it separately. The golden review rejected it
(NOT_GROUNDED): no reference instructs a model this way, and the Kimi citation
was mis-stated. It was replaced by the deletion above.

## Human feedback

None recorded.

## Reusable lesson

Do not feed a page's HTML <title> to a summarizer as a page fact: summarizers echo it as the document title, so let them read titles from the content and forward only head facts the content lacks.
