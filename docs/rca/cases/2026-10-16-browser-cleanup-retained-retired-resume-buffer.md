---
id: 2026-10-16-browser-cleanup-retained-retired-resume-buffer
date: 2026-10-16
title: Merged browser cleanup retained an undefined retired resume buffer
surface: agents
component: browser-activity-cleanup
classification: our-bug
problem_class: other
first_bad_boundary: merged finally mutable_buffers tuple loaded resume_user_messages after upstream removed that buffer
symptoms:
  - NameError name resume_user_messages is not defined in handler finally
  - auth-handoff-verification canonical domain failed all five activity cases
tags:
  - merge-integration
  - cleanup
  - retired-state
sources:
  - commit b6b2773fe2d7c045d3963410643f4d6a83125017
  - commit f0fe35fbb9ccbbb426fdbc49d46b36d0454c26f2
  - commit f3315c787a142c63cbe42c7f72aedc5542e44c0d
repro: agents/tests/blackbox/auth_handoff_verification.blackbox.py
status: open
---

## Problem

The actual merged b6 activity raised NameError in finally at handler11857. The normal full coverage lane recorded auth-handoff-verification 0 PASS/5 FAIL and two browser deploy-resume failures with the same exception. An independent private owning run also reproduced all five activity failures. This exception could replace otherwise successful or deliberately sealed activity results.

## Diagnosis

Upstream replaced synthetic resume messages with durable user_instruction_messages. The combined source had zero stores and one load of resume_user_messages, retained only in the cleanup tuple. f0 still defined the old buffer, so this is a new merge defect and not a cause of the separate f0 no-code native failure. Static symbol auditing of the five inspected production modules identified this sole unresolved global; that bounded audit does not certify arbitrary code paths.

## Solution

Separate private prerequisite patch 90a60ae37a3210d4e55c0f9f3231ec60a38ed1499542ac645067e99ab06640cf removes only the obsolete tuple element. It preserves current instruction handling, credential buffers, exact resource cleanup and secret context. The SAME five actual activity cases fail before and pass after the one-line change. New contract and late-input assertions use this explicitly declared prerequisite rather than concealing the baseline failure. Full final-source coverage and native outcomes are still pending; all original failures remain retained.

## Human feedback

The user requested fixing failures and approval only at deployment. No cleanup or failure gate was waived.

## Reusable lesson

Remove retired state from cleanup when composing a replacement owner, and exercise real finally paths so cleanup cannot mask the original result.
