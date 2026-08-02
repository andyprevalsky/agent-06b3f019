---
id: 2026-07-13-agent-reply-routing-without-sms-intent-binding
date: 2026-07-13
title: Agent reply routing had no current-SMS intent binding, so a stale agent in the tree could answer the user
surface: back-end
component: sms-supervisor
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agent reply routing — replies were dispatched without binding to the current inbound SMS intent
symptoms:
  - user receives an SMS reply from a stale agent in the tree
  - reply does not correspond to the message the user just sent
tags:
  - sms
  - reply-routing
  - agent-tree
  - stale-agent
  - intent-binding
sources:
  - PR #764
repro: none-recorded
status: fixed
---

## Problem

Users received SMS replies that did not answer their current message: an older
agent in the same agent tree could emit a reply that got routed to the user,
producing a stale response to a superseded intent.

## Diagnosis

Reply routing resolved a destination without any binding to the _current_ inbound
SMS intent. Any agent in the tree was therefore an eligible replier, including one
whose work belonged to an earlier turn. Because agent trees outlive individual SMS
turns, "which agent may speak for this message" has to be an explicit property of
the turn — without it, routing degenerates to "whoever finishes next", which is
non-deterministic from the user's point of view.

## Solution

Reply routing now carries a current-SMS intent binding, so only the agent bound to
the live inbound message can reply to the user; stale agent-tree replies are
suppressed. A stale-agent regression test was added to durable coverage together
with the other SMS-path fixes in the PR.

## Human feedback

The same PR codified RCA local-repro and post-fix verification requirements for
this class of fix.

## Reusable lesson

Bind every outbound user reply to the specific inbound turn that authorized it —
otherwise any long-lived agent in the tree can answer a question the user already
moved past.
