---
id: 2026-11-06-logical-provider-skipped-config-normalization
date: 2026-11-06
title: Logical browser rows stored Steel for a normalized Tilion configuration
surface: back-end
component: browser-logical-session
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: logical session configuration reached storedBrowserProvider without the trimming and lowercase conversion used by selectedBrowserProvider
symptoms:
  - "logical selection normalizes the provider"
  - "steel !== tilion"
tags:
  - browser
  - tilion
  - logical-session
  - kill-switch
sources:
  - PR #1708
  - PR #1708 CodeRabbit review 5795469123
  - commit c22e3dbff544cbc5aa100ea308c1ad756adf2419
repro: back-end/src/tests/blackbox/browser-fresh-provider.blackbox.ts
status: open
---

## Problem

A fresh logical browser created with BROWSER_PROVIDER=" TILION " stored Steel, although actual session selection normalized that value to Tilion. Disabling Tilion also failed to redirect this logical row to Kernel. Review found the mismatch while validating the requested fresh-session default.

## Diagnosis

Gate: NOT_INTRODUCED for the normalization omission: both baseline d16c934b7 and browser repair 7c43796a1 pass the configured environment string directly to storedBrowserProvider; the repair changed only its absent-value default. This remains owned because consistency of fresh Tilion selection is part of the assigned repair. selectedBrowserProvider trims and lowercases the configuration, while the storage helper maps an unrecognized value to Steel before the logical-session kill-switch check. The permanent new assertion fails on the pre-fix repair with actual Steel and expected Tilion. The unchanged command passes after normalization, including an independent assertion that disabled normalized Tilion selects Kernel. No remote browser is allocated by the mock transaction.

## Solution

Normalize only the configured logical-session provider before conversion and kill-switch evaluation. Existing row upserts retain empty updates, preserving resumed-session bindings. The change adds no polling, network calls or shared fan-in at 10k agents. The current fresh-session regression still covers saved cross-provider preferences, logical defaults, account-connect defaults and existing Steel/Kernel dispatch. Original failure and passing logs are retained privately in the deploy closeout archive. Deployment verification is pending; no production success is claimed. Golden reference: not applicable (no approval-gated hunk).

## Human feedback

The user requires Tilion for fresh sessions while preserving resumed sessions.

## Reusable lesson

Normalize configuration consistently before every provider selection boundary, including durable placeholder creation and disabled-provider fallbacks.
