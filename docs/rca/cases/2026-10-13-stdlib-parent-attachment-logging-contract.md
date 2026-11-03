---
id: 2026-10-13-stdlib-parent-attachment-logging-contract
date: 2026-10-13
title: Parent attachment extraction passed unsupported fields to stdlib logging
surface: agents
component: helpers.attachments.fetch_parent_attachments_activity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/attachments.py fetch_parent_attachments_activity success logger.info call
symptoms:
  - "Failed to fetch parent attachments: Logger._log() got an unexpected keyword argument 'parent_agent_id'"
  - "Extracted parent attachments"
tags:
  - attachments
  - stdlib-logging
  - wmh
sources:
  - PR #1453
  - commit c9af1843a80823465b2249449d8194c6e1525ded
  - agent a2185bc7-9e95-4ee8-8b34-e704bc72f9a6
repro: agents/tests/blackbox/attachments.blackbox.py test_parent_attachment_success_preserves_metadata_and_logs
status: open
---

## Problem

Run15 emitted two parent attachment failure warnings, at 22:03:54.718088Z and
22:04:15.483975Z. The corresponding parent GETs returned HTTP 200. The warning
reported unsupported `parent_agent_id` arguments to `Logger._log`, rather than
an HTTP or extraction failure. Exact responses and attachment counts were not
captured at those boundaries; attachment loss is not established.

## Diagnosis

The activity reads the parent, extracts file pointers and populates both result
maps before logging success. Its logger is `logging.getLogger`, but the INFO
call passed fields as structlog keyword arguments. At INFO level the actual
stdlib logger rejects them before the worker's formatter can add fields. The
activity's existing broad catch labels that logging exception a fetch failure,
then returns the populated maps. The first bad boundary is the logging API;
message batch 401s and the fundraising timeout have separate unresolved causes.

The delegated RCA reproduced the exact TypeError using the production logging
expression. Root then registered a regression that invokes the actual async
activity with HTTP MockTransport, checks the original request/header, exact
empty and nonempty file-pointer maps, one structured INFO event and no warning.
With the corrected API `filePointer` fixture, the identical test failed on the
buggy call and passed after changing field transport, without weakening any
assertion. The first extended mock mistakenly used metadata attachments; that
verification failure was retained and the fixture corrected before repeating
both sides. No source behavior was changed to accommodate that fixture.

Commands, from `agents/`, using Python 3.11.9:

```bash
venv/bin/python -B - <<'PY'
import asyncio,sys,importlib.util
sys.path.insert(0,'tests/blackbox')
s=importlib.util.spec_from_file_location('attachment_case','tests/blackbox/attachments.blackbox.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
asyncio.run(m.test_parent_attachment_success_preserves_metadata_and_logs())
PY
venv/bin/python -B scripts/run_blackbox_tests.py attachments
```

Pre-fix: exit 1, `Successful parent attachment extraction emitted a failure
warning`. Post-fix: exit 0; registered attachments domain passed all 34 cases
in 0.2s. The blackbox runner discovers this domain and the agents deploy gate
runs that runner. These controls establish the logging mechanism only.

Archive searches used the literal logger exception and parent attachment
retrieval failure. The related case
`2026-08-22-stdlib-logger-kwargs-crash-passkey-target-follow` fixes the same
contract class at another owner; this is not a demonstrated recurrence there.
Golden reference: `claude-code-src/src/utils/claudeInChrome/mcpServer.ts:277`
formats arguments through `util.format` before passing them to its debug sink.
That illustrates respecting the logger contract, not a universal `extra` API.
Other reference trees were absent; no citations were fabricated.

## Solution

Pass the existing three fields through stdlib's `extra` dictionary, which the
existing worker ExtraAdder already supports. The HTTP request, returned maps,
exception handling, activity timeout, prompts, schemas and retry rules stay
unchanged. No new branch or concurrency owner is added; the same constant-size
log operation applies per activity. Delegated adversarial source review passed:
the actual activity regression passes for both payloads, the existing worker
formatter preserves its fields and the test patches restore correctly. Method
and host are not separately asserted; both are unchanged by this fix.

The incident's logging mechanism is repaired locally. The case remains OPEN
because Run15's exact unchanged fundraising benchmark failed at its 60-minute
window, and attachment loss or a causal financing-outcome repair has not been
proved. No merge or deploy is authorized. Complete private controls and all
original failure records are authenticated in the Run15 preservation receipts.

## Human feedback

The user requires independent RCA workers, evidence-backed fixes, 60-minute
DEMO-on iterations, and scorecards or RCA approval requests. Preserve Freedom
and protected instructions. Changes to WHM timeout/recovery behavior must not
alter ordinary harness runs. This logging change adds no timeout/recovery or
LLM-visible behavior. The user did not approve the separate goal-filter or
HTTP-body-capture proposals; both remain unapplied.

## Reusable lesson

Use the actual logger's structured-field contract and distinguish log emission
failure from successful data retrieval.
