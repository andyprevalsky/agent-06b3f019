---
id: 2026-07-13-inbound-sms-persisted-after-async-supervisor-work
date: 2026-07-13
title: Inbound SMS was persisted after asynchronous supervisor work, so later turns superseded or read incomplete history
surface: back-end
component: sms-supervisor
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: SMS supervisor entry path — the inbound message row was written after async work instead of atomically before it
symptoms:
  - SMS replies reference an incomplete conversation history
  - a later inbound SMS turn supersedes an earlier one still being processed
  - outbound SMS missing from the persisted thread after delivery
tags:
  - sms
  - supervisor
  - persistence-ordering
  - race
  - conversation-history
sources:
  - PR #764
repro: none-recorded
status: fixed
---

## Problem

SMS conversations lost or reordered context: the supervisor could run against a
thread that did not yet contain the message that triggered it, and a subsequent
inbound turn could supersede an in-flight one. Outbound messages were likewise
not visible in the thread immediately after being delivered.

## Diagnosis

Inbound persistence happened _after_ the asynchronous supervisor work rather than
before it. That ordering opens a window in which two things go wrong: a
concurrently arriving turn can supersede the earlier one, and any read of the
conversation during that window observes incomplete history. Nothing about the
supervisor logic was wrong — the write ordering around it made a correct
supervisor produce incoherent replies. The same ordering gap existed on the
outbound side, where the sent message was not persisted immediately after
delivery.

## Solution

Inbound SMS messages are now persisted **atomically before** supervisor execution,
and outbound SMS is persisted immediately after delivery. Durable regression
coverage for SMS supervisor ordering and continuation was added and cemented in
the recurring suite; the change also removes the class of bug where any future
consumer of the thread (search, context builders, the UI) reads a half-written
conversation.

## Human feedback

The same PR codified RCA local-repro and post-fix verification requirements —
i.e. a diagnosis of this class of ordering bug is not acceptable without a repro
that fails pre-fix and the exact same command passing post-fix.

## Reusable lesson

Persist the triggering record atomically before any asynchronous work reads or
extends it — deferring the write until after the work makes every concurrent turn
a lost-update race.
