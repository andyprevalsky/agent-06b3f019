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
  - agent e0c401c1-3d19-4933-a43d-61448f9b9779 (local outcome run 2026-10-24, source 2a7a0479e)
repro: scripts/tests/canonical-seed-whatsapp-content.test.sh
status: mitigated
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

Shipped (2026-10-24, directed by Andy: "the fixture should be providing my
name" / "the base fixture should have this data"). Provenance: not a producer
scrub. `seed-local-helpers.ts` REMOTE_USER_SELECT copies name and address. The
reviewed canonical fixture is the ~Aug-5 prod snapshot, migrated forward. Prod's
User row for 1f85ff25 was then `3d946550` (created 2026-07-28, blank). Prod
replaced it on 2026-09-01 with `50db24c7` (name, email, address, recipient,
systemName). The frozen fixture kept the blank row, and the validator never
checked the profile.

1. Patched only that User row in isolated restores of both current objects. The
   pg15 object used a `pgvector/pgvector:pg15` container and the pg16 object the
   local PG16 server. Both went through `scripts/restore-seed-dump.sh` and
   `scripts/save-seed-dump.sh`. The patched fields are name, email,
   deliveryRecipientName, addressLine1/2, city, state, postalCode, country and
   systemName, copied from prod read-only. Every agent-read profile field now
   equals prod. 91/92 tables have identical row count and content md5, the other
   204 User rows are identical, and the bench row's other columns are identical.
2. Republished under the same keys, following the 2026-10-19 precedent, with no
   controllers running. Read-back hashes match.
   `ab877…-pg15-victoria-prod-sync-v1-whatsapp-v2`: 6172ffc1… → e17d9b76…
   `ab877…-pg16-victoria-prod-sync-v1-whatsapp-v2`: 387cc044… → bfafdc09…
   The originals and receipt are retained under
   `.context/descend/descend-full69-20261023/rca-Q3/seed/`.
3. `scripts/validate-canonical-seed-dump.sh` now requires a non-blank name,
   email and addressLine1 on the bench User row. It exits 1 on both old objects
   and 0 on both new round-trips. `scripts/tests/canonical-seed-whatsapp-content.test.sh`
   (deploy structural gates) gained blank-profile, whitespace-name, missing-email
   and missing-address cases: red before the validator change, 11/11 green after.

Step-8 replay against the new fixture context: 5/5 `input_text(index=53)`.
Before: 0/11. The local exact run then typed the name. A separate follow-on
failure is recorded as open below.

10k-agent behaviour: fixture data only, neutral.

Open follow-on (2026-10-24 local run, agent e0c401c1): with the profile email
present, the browser first signed up with the user's own inbox, although
Auth Options says that inbox's codes are unavailable. The code was withheld. It
then succeeded with the minted email (member page showed the name and member
number), but switched back to the abandoned verify tab and called
request_user_assistance_for_authentication. The exact local run still FAILED
(tree stalled, 512s), now for this new reason. Separate model-decision RCA needed.

## Human feedback

Andy (2026-10-24): "the fixture should be providing my name, what's the issue" and "the base fixture should have this data, ensure it does, u can update the fixture as needed". He directed fixing the fixture at its source and bringing every agent-read profile field up to prod, instead of the earlier proposal (a task-level db_fixtures delta or awaiting approval).

## Reusable lesson

When a benchmark agent asks the user for a fact, first check whether the canonical fixture's user row is missing that fact compared with prod, before blaming the model or the harness.
