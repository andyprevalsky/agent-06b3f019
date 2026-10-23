---
id: 2026-10-23-canonical-bench-user-missing-profile-name-signup-handoff
date: 2026-10-23
title: Canonical bench user has no profile name, so a required sign-up "Full name" sent the browser to human auth assistance and the root waited until the tree-stall kill
surface: harness
component: canonical-seed-fixture
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: canonical base fixture victoria-prod-sync-v1-whatsapp-v2 — public."User" row for 1f85ff25 has name NULL (and no address), so agents/helpers/user_profile.py build_user_profile_sections renders no "Full Name" line and no context source can fill a required name field
symptoms:
  - "first run did not complete (status=ACTIVE, reason=tree stalled — newest-active root silent for 514s (threshold=510s"
  - "Browser agent requested user authentication assistance"
  - "'validationMessage': 'Please fill out this field.'"
tags:
  - benchmark
  - fixture
  - auth-test-site
  - browser-auth
  - signup
  - tree-stall
  - user-profile
sources:
  - agent b27a099b-6510-411d-9cea-63f3222dc28f (sharded run original600-1792795636260090257, job r001-j0008, source 7eb275b1b)
repro: .context/descend/descend-full69-20261023/rca-Q3/ab.sh (local exact-call replay A/B; not yet a checked-in test — fix is approval-gated)
status: open
---

## Problem

`browser-auth-created-account-reused` (first run: "Create an account for me at
{auth_test_site_url} and tell me my member number") failed on 1 of 5 copies with
"tree stalled — newest-active root b27a099b silent for 514s". Worker log: the
browser child typed the minted email and `{{secret:pwd:new}}` (backend
`[MintedAccountPassword] Saved minted account password` 23:17:39), clicked
Create account, and its evaluate at 23:18:12 showed the required `name` field
invalid (`valueMissing: true`, "Please fill out this field."). No
`POST /api/rose-shop/<id>/signup` ever reached the backend. At 23:18:20 the
browser LLM (`browser_use_step_8`, gpt-6.1-sol) called
`request_user_assistance_for_authentication`. The spawn_browser_agent handler
(`handler.py` awaiting_auth_assistance branch) then set root
`workflow_instance.is_paused=True` and waited for a human response that a
benchmark never sends. The root's `wait_for(/root/create_account, 600s)` returned
at 23:26:28, and run_agent then sat in "Agent paused, waiting..." until the
stall threshold. The root has no `bus_id`, so `_update_tree_state(status="PAUSED")`
returned early and the DB status stayed ACTIVE.

## Diagnosis

The browser context's "## Personal Information" contained only `Phone:`. The
Auth Options "Minted account" line offers email, phone and a sign-up password
ref, but no name. So no truthful source existed for the site's required
"Full name". The canonical seed dump
(`ab8771435449173ffa885364692a9d24a2d718b0-victoria-prod-sync-v1-whatsapp-v2`,
pg_restore of public."User") holds bench user 1f85ff25 with name `\N`,
addressLine1 `\N` and country `United States`. The prod-synced local `victoria`
holds `Andy Prevalsky` with an address. The fixture is therefore less complete
than the prod user it stands for. All 5 copies had identical inputs; the
4 passing copies made a different model choice on the same missing fact.

Causal proof, with model, messages, tools and config held constant: the exact
`browser_use_step_8` dump was replayed through `scripts/replicate_llm_dump.py
--mode exact`. As captured, 10/11 trials called
`request_user_assistance_for_authentication` and 1/11 called
`attempt_completion`; none filled the field. With only
`Full Name: Andy Prevalsky` added to Personal Information (what
`build_user_profile_sections` renders for the prod row), 10/10 trials
`input_text(index=53, "Andy Prevalsky")`.

Not the P9 class (escaping FailureError leaves the leaf ACTIVE) or P9b (hung
explore FE post). This is a deliberate, unanswered human handoff. Relative of
2026-08-05-delivery-address-null-recipient-only-half-block: the same bench
user's profile lacks facts that tasks need.

## Solution

Proposed, approval-gated (benchmark fixture/environment): restore the bench
user's prod profile name in the canonical base. Republish the reviewed PG15
fixture with `User.name` set, per CLAUDE.md's seed procedure. Extend
`scripts/validate-canonical-seed-dump.sh` in the same change so that a
nameless bench user fails publication and restore. Adding that invariant alone
would fail every guest restore of the current dump, so the two must ship
together. Alternative narrower option: a task `db_fixtures` delta setting the
name for auth_test_site tasks (30 tasks use that service). No harness/prompt
change is proposed: asking the user for a genuinely missing fact is correct
behaviour (see the golden reference: claude-code-src/cli.js:1700, the
AskUserQuestion tool). 10k-agent behaviour: fixture data only, neutral.

Open observability gap: a root awaiting human auth assistance without a bus
keeps DB status ACTIVE. The fleet stall classifier therefore reports "tree
stalled" instead of "awaiting user authentication assistance".

## Human feedback

None recorded.

## Reusable lesson

When a benchmark agent asks the user for a fact, first check whether the canonical fixture's user row is missing that fact compared with prod, before blaming the model or the harness.
