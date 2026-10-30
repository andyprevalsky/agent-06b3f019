---
id: 2026-10-30-it27-bu094-unacknowledged-reload-blocks-alternate-navigation
date: 2026-10-30
title: BU094 empty-response credential reload blocks alternate navigation
surface: agents
component: browser-navigation-admission
classification: unresolved
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: A native empty-response error at the mandatory reload result leaves credential acknowledgement pending and exhausts recovery before the actor can select another destination
symptoms:
  - "Navigation failed: net::ERR_EMPTY_RESPONSE"
  - "credential_reload_error:RuntimeError"
  - "Browser supervisor recovery budget exhausted"
  - "Empty DOM tree (you might have to wait for the page to load)"
tags:
  - polar
  - it27
  - bu094
  - r115
  - credential-reload
  - navigation
sources:
  - commit 98c8668b47b5e9b2fd2b807c2f083f2e46a04733
  - agent f9aca2aa-420a-4308-a9a8-c607aa7e8d66
  - plan:.context/r114-r115/deeper-proof.json
  - plan:.context/r115-candidate/manifest.json
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py test_native_failed_navigation_restriction_and_escape
status: open
---

## Problem

Original It27 BU094r2/r002-j0014 asks for the publication containing a 2010s
paper about a census-derived employment sample. The browser clicks a candidate
PDF, then calls `read_browser_state`. Native execution ultimately fails after
2045.9s with progress1; the canonical task is FAILED, producerinfraFALSE and no
declared semantic judge. A correct requested `publication_name` schema is
present; no captured verifier invocation establishes a rejected final answer.

Archive569c44fb227225c5049e5d86f030b9389657c38d2f7942def667d2bc58642da8 and all
seven member SHA/bytes were verified. Normal manifest
9be85ac67ab0c411d9e367a302ea6910ad33b5e7bf51adfca922c41bb884355f binds run
9db7af0a3dd6de20dfd069ebcefb99dfd5f66558fd8acf5f872dd1b1e44f1907 and worker
3112d071461024e32c469a36abb8302bf8a60a3684bdf278962e30269f56027b to source98c,
patchnone. Fleet20261030-064104-854333 is distinct from the two R114 deadlines.

## Diagnosis

Worker20335 records click index8973 at07:16:16.640429Z. DOM snapshot, tree and
AX reads then time out; worker20357 says the watchdog returns minimal state.
The actual next actor request at20383 chooses `read_browser_state`. Persisted
result77 explicitly contains zero elements and an empty-DOM/wait-for-load
message. Its success label describes capture; it does not establish usable PDF
contents. Relabeling that result alone cannot repair the subsequent admission.

The read's authentication callback prepares the observed PDF realm. Worker20412
at07:17:01.829449Z records password_count1, passkey_count0,
passkeys_newly_injected0, cookie_source none and cookies_injected false. One
saved password is not zero credentials; zero injected state is not proof that
the outstanding realm acknowledgement can be dropped. The actual98c callback
sets `pending_credential_reload_realm` after preparation. The next iteration
must acknowledge its native reload before requesting another actor decision.

The PDF URL is
`http://www.revistadestatistica.ro/wp-content/uploads/2015/07/RRS3_2015_A08.pdf`.
Worker20451 at07:17:36.254153Z reports the native NavigateToUrlEvent failure
`Navigation failed: net::ERR_EMPTY_RESPONSE`. The recovery snapshot contains
`chrome-error://chromewebdata/` and the browser's didn't-send-data error page.
Network body metadata records status null, not HTTP200. The named body sidecars
and original raw Page.navigate response are not in this normal packet, so the
exact HTTP/network cause and usable PDF content remain unknown.

The unchanged activity keeps the credential debt and repeats the same failed
reload before any model turn. Worker20719 exhausts the existing eight-recovery
budget;20720 propagates RuntimeError at handler10467. That mandatory-admission
dead end is reproduced locally. It does not prove that another source would
have answered the task or that the underlying site/provider was defective.

Two archive searches covered ERR_EMPTY_RESPONSE/credential reload and failed
navigation/recovery. R107's typed nonpublic-policy barrier and R86/R95's HTTP
failure cases were compared. R107's classifier correctly rejects this error;
this is not a nonpublic-address denial. R114's separate StartToClose episodes
are not a shared-cause claim.

## Solution

OPEN for the original benchmark outcome. The exact candidate received an
independent GROUNDED review and was applied on the descent branch. Its patch SHA is
28ff498ccb8bd264c39f9dd9e2eb5246d64e85d89645b3521630843d4133457f against98c.
It wraps only the original exact native error at event_result, then retains
credential debt in a separate durable failed-navigation barrier. Only a
different public destination can execute; its credential preparation, native
navigation and readiness ACK must complete before normal actions or completion.
The same text raised by readiness, other exceptions, HTTP failures and policy
denials are not reclassified as this error.

Delete/unify rationale: do not add a second general recovery loop or copy the
security-sensitive dispatch state machine. Reuse R107's existing bounded
alternate-navigation admission, target/session/binding checks, batch discard,
privacy restrictions and ACK lifecycle. Distinguish failure kind, feedback and
durable key; preserve the existing policy-denial classifier and feedback bytes.
No removal of credential obligations, no generic catch-and-continue, no URL or
PDF heuristic, and no timeout, retry or model-route change is proposed.

Exact reproducible commands from the portable packet:

```bash
agents/venv/bin/python .context/r115-candidate/run_red.py
agents/venv/bin/python .context/r115-candidate/run_green.py
agents/venv/bin/python .context/r115-candidate/measure_owning.py
agents/venv/bin/python .context/r115-candidate/run_gates.py
```

The unchanged registered full-activity test fails on original98c with the native
RuntimeError before an actor decision (exit1,2.744s) and passes on the candidate
(exit0,7.834s). Its15 scenarios cover refused current-page actions, same URL,
private and secret-bearing destinations, coalesced calls, alternate ACK,
preparation failure, repeated failure, stale target/schema, session replacement,
resume/drain, user takeover, budget, cancellation and sealed generation. It also
checks exact error provenance, conflicting/foreign/null checkpoint rejection
and three post-prepare native-dispatch guards. The actual run_all_tests selector
passes11/11, including R107's12 scenarios, R35 and R106 collateral. Pinned
Python3.11 compilation passes for all four candidate files.

These are deterministic source-level controls with inert network/model/native
adapters, not a live benchmark rerun. They neither reconstruct missing raw CDP
frames nor qualify the original task as PASS. Early setup before restored
barrier hydration retains R107's existing continuity limit; rollback/adoption
must preserve or explicitly handle the new durable key. Parent composition
with R118 preserves the exact reviewed patch: reversing it restores all four
parent files byte-for-byte. On the composed checkout, the registered R115
selector passed 11/11, the R118 selector passed 3/3, and pinned compilation of
all four changed Python files passed. This verifies the code composition, not
a successful rerun of the original benchmark. Independent review receipt:
`independent-review--f49fc3d97a62fa7c2fbf.md`. Parent commands:

```bash
agents/venv/bin/python /tmp/r115-root-gates.py /home/boxes/rose
agents/venv/bin/python /tmp/r118-review-parent/run_registered.py /home/boxes/rose
```

Original normal cleanup records session
sess_c3d0ebb57bba494b9709b91bc632fdff DELETE204, root sealing, no cleanup error.
No replay, model/provider/DB/native call, grade change or live source mutation
was performed during this RCA.

## Human feedback

The coordinator required a deeper owning-boundary pass after the first OPEN
floor: distinguish empty/minimal state from usable page evidence, preserve
credential inventory versus actual injection, and never feed ERR_EMPTY_RESPONSE
into R107's nonpublic-policy classifier. It then authorized a separate typed
barrier candidate with unchanged debt/identity/cancellation guards and required
independent review before application. The original task outcome stays OPEN
regardless of the local routing result.

## Reusable lesson

Preserve an unacknowledged credential obligation while exposing a narrowly
classified native navigation failure to guarded alternate navigation; do not
turn an unreachable document into either successful evidence or a policy denial.

## R120 — It28 BU094r1 native connection-closed failure

This original executes d0663f361a1118ce6776d1ab8aaa0987dcf252a5, which already
contains the reviewed R115 empty-response barrier. It is a proved coverage gap
at the same mandatory navigation result boundary, not evidence that d066 ran
unqualified future code or that all Chromium errors should be treated alike.

The canonical campaign row is CANCELLED after the later operational stop.
The separately sealed diagnostic run records nativeFAILED792.8s/progress1 and
benchmark_statusFAILED/producerinfraFALSE. Preserve both axes; this diagnostic
is not promoted to a scored campaign failure. Root566087d1-dd77-4c68-bed4-c7486baaf0e3
has archive8bde70d74315497f6d6fef75cb9eeae9e62681b86d3f14b3187627810a197020,
normal manifest669c64d762456db11ea355208d81f58ac1c98250db2f63408e05531d57500bb6;
all seven original member sizes/hashes were verified.

It requests the same publication from the census-paper clues. Author output139
SHAed45e8d3a445e4a21f50ed33402c043a4aa1824337ed5177ce36475893ed6e9b declares a
required nonempty publication_name string and matching value/text presentation.
No verifier call appears among the15 captured native context dumps. Last read
result48 explicitly shows zero elements/empty DOM for the HTTPS PDF; this is not
proof of usable source content or a completed answer.

Worker17672 at19:09:35.405732Z prepares revistadestatistica.ro with password_count1,
passkey_count0, cookies_injectedfalse and passkeys_newly_injected0;17673 reports
the state-read result. The callback creates the pending reload obligation.
Worker20191 at19:10:11.374362Z records native
`Navigation failed: net::ERR_CONNECTION_CLOSED`; repeated event_result failures
reach54212 eight-recovery exhaustion, then54213 fatal at19:18:21.297168Z. The
manager fails at55133. Exactd066 handler10497 awaits that native result; its
classifier recognizes only ERR_EMPTY_RESPONSE, so this other observed native
transport code goes through generic recovery instead of restricted alternate
navigation. Neither code assigns vendor/local blame or proves whole-CDP loss.

The R120 candidate unifies the two evidenced machine-code identities in the
same narrow typed transport-failure classifier. It adds no error-specific state
machine and changes no handler, checkpoint or ACK contract. Abort/cancellation,
policy denial, HTTP failure, parser errors and the same text from readiness stay
outside this classifier. Feedback describes transport failure without claiming
an empty response for the connection-closed case. The exact reviewed code and
original task outcome remain separate; no live calls, grade or timeout changes.

Parent owns independent review and application. This remains OPEN until the
exact original task outcome is proved; local continuation controls are not a
benchmark rerun. Original normal cleanup records Tilion session
sess_98241c121df74e3c9366ad5cf25aaeab DELETE204, root_deleted/tree_sealed and no
cleanup error. The two archive searches and prior R115/R86/R35 comparison are
retained in the private evidence packet.

Parent integration: independent review found the exact `3560f36c` patch grounded. The composed checkout preserves all three reviewed output hashes and the unchanged handler. Actual registered 11-selector collateral run and pinned Python 3.11 compilation of three changed Python files passed. These checks establish the bounded routing repair, not the original task outcome or upstream transport cause.
