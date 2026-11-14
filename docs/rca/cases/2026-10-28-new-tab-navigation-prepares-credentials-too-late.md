---
id: 2026-10-28-new-tab-navigation-prepares-credentials-too-late
date: 2026-10-28
title: New-tab navigation prepared the target realm only after a TLS action failure
surface: agents
component: browser-agent-navigation-credentials
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: service_actions._execute_navigation_action open_new_tab omitted the pre-navigation preparation used by goto
symptoms:
  - Navigation failed net::ERR_SSL_PROTOCOL_ERROR
  - Prepared credentials for browser realm transition after Browser action failed
  - pending credential reload raised at handler reload_event.event_result
tags:
  - browser-auth
  - navigation
  - tls
  - new-tab
sources:
  - agent 3940a4d4-93cc-4fa7-91a7-d34352c4fda7
  - agent 95edbc00-7521-4a29-9caa-0e7cc1cf5b07
  - commit 4c6861dcd2a9aacf22e3937cea27fae904727349
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_activity_open_new_tab_prepares_realm_before_failed_navigation
status: open
---

## Problem

It6 polar-bu-025 run 2 failed after 749.9 seconds. At step 40 the browser tried
open_new_tab to https://paste.rs/ and got net::ERR_SSL_PROTOCOL_ERROR at
00:34:01.664Z. The action layer caught the real navigation error, but its
post-action realm observation prepared paste.rs credentials at 00:34:03.328Z.
That armed an automatic credential reload. At 00:34:06.502Z the reload hit the
same TLS error outside the action error boundary and terminated the activity at
handler.py reload_event.event_result. The original task FAIL is preserved.
The sibling run passed, but used a different trajectory. The cause of the first
TLS protocol failure remains unknown; no live site or provider query was made.

## Diagnosis

Goto prepares the requested realm before dispatching navigation. Open-new-tab
used the same browser context and credential callback, but skipped preparation.
The subsequent observation therefore treated the known requested realm as a
new redirect and armed a reload after the failed action. A local full-activity
fixture reproduces the identical terminal RuntimeError at the reload boundary.
Reusing goto preparation before open-new-tab makes the same fixture return the
actual action failure to the next model turn, with no repeat of the failed URL.

An earlier experiment simply cleared the pending reload on failed actions. It
was rejected: a failed action may have partially navigated to another realm,
so failure alone cannot establish that the credential barrier is unnecessary.
That approach was never applied. The final candidate preserves unexpected
redirect reloads, including failure propagation when that barrier cannot run.

## Solution

Extract the existing optional goto credential-preparation block into a shared
helper, keeping its source priority, exception handling and returned summary.
Call it after the existing new-tab navigation guard and before its native event.
Credential injection is browser-context scoped: cookies are applied through
context.addCookies and origin storage through owned exact-origin temporary
pages. It is not limited to the former foreground tab.

The exact producer/test patch SHA256
04d70ed29b8ece66da180f3cad17a0aa5f8328e89f56f307195694961e05bb3f
was independently reviewed GROUNDED before application.
Permanent full-activity controls cover direct TLS failure, failure retaining
the old page, successful new-tab navigation, optional preparation failure,
and unexpected redirect success/failure. Existing goto controls remain.
No TLS checks are weakened, no extra retry or task-specific URL logic is added,
and no task, output schema, grade or timeout is changed. The underlying TLS
cause and unchanged task outcome remain unproven, so this case remains open.

## Human feedback

The parent required no blind retry, TLS validation weakening or unsupported
infra reclassification. The independent reviewer rejected failure-only barrier
clearing and required actual observed identity and redirect safety controls.

## Reusable lesson

Every navigation surface must prepare its known target before navigation; a
post-failure observation must not be mistaken for an unforeseen redirect that
requires repeating the same failed request.
