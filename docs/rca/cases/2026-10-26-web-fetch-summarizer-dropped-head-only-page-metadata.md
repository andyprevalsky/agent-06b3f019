---
id: 2026-10-26-web-fetch-summarizer-dropped-head-only-page-metadata
date: 2026-10-26
title: web_fetch dropped head-only page facts before the summarizer; first fix forwarded an unbounded denylist
surface: agents
component: web-fetch-summarizer
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/web_fetch/handler.py WebFetchManager.execute_tool (scrape metadata not passed to summarize_and_filter_links)
symptoms:
  - background-agent-message-smoke timed out (185s > 180s)
  - explore agent reported the RFC publication month unverifiable
  - citation_publication_date only in <meta>, beyond the 40k summarizer window
  - PAGE METADATA block carried extract_id / session_id / og:* / citation_reference
  - title missing from PAGE METADATA on metadata-heavy scholarly pages
tags:
  - web-fetch
  - summarize-web-fetch
  - firecrawl
  - parallel-extract
  - demo-cache
sources:
  - commit b541b1767 (first fix, NOT_GROUNDED review)
repro: agents/tests/blackbox/summarize.blackbox.py and agents/tests/blackbox/web_fetch.blackbox.py (page_metadata tests)
status: open
---

## Problem

background-agent-message-smoke timed out because the RFC Editor declares the
RFC 9110 publication date only in `<meta name="citation_publication_date">`.
Firecrawl returned it in `metadata`, but web_fetch dropped metadata before the
summarizer, so the explore agent needed a second run. The first fix
(b541b1767) forwarded every metadata key except a 12-key denylist. A
golden-reference review found three problems: og:/twitter:/citation_reference
and verification keys reached the prompt, Parallel Extract's extract_id,
session_id and warnings were labelled as page tags, and alphabetical ordering
with a stop at the first overflow dropped `title` on scholarly pages.

## Diagnosis

The handler passed the whole provider `metadata` dict to the activity, and
`format_page_metadata` used a denylist, sorted keys and a 4,000-character
budget that stopped at the first overflow. A scholarly page whose citation_*
keys came first alphabetically used up the budget before `title`. This was
reproduced by the new blackbox tests, which fail on fcf75dcff.

## Solution

`select_page_metadata` keeps an explicit allowlist. It returns the title first,
then one publication date that parses as a date, picked from well-known keys
(no modified date: no reference shows one, and it could be misreported as the
publication month). Values are limited to 256 characters each and 512 in
total, with control characters removed. The handler sends only this subset.
The prompt is byte-identical when no listed field exists. The
summarize_web_fetch demo-cache content key leaves out the PAGE METADATA block,
so test-mass-agent-run-0 rows recorded earlier still hit: 821 of its 873
exact rows would otherwise miss. Each prompt adds at most 512 characters and
one small dict per fetch, with no shared state, so the cost stays the same at
10k agents. Outcome is still pending: neither the unchanged
background-agent-message-smoke nor test-mass-agent-run-0 has been rerun on this
revision.

## Human feedback

The golden-reference review (NOT_GROUNDED) required named-field allowlisting
that matches Hermes and OpenClaw, no provider IDs, explicit title-first
ordering, and a check for demo-cache misses. It ruled out a broad denylist.

## Reusable lesson

When forwarding provider metadata to an LLM, allowlist named validated fields with reference-sized caps and keep demo-cache keys stable for derived blocks.
