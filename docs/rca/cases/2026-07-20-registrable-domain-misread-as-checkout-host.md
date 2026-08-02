---
id: 2026-07-20-registrable-domain-misread-as-checkout-host
date: 2026-07-20
title: Host-level checkout detection matched the registrable domain, so order.online was always treated as a checkout page
surface: agents
component: browser-agent
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: request_payment_card host-level checkout-route detection — matched any label of the hostname, including the registrable domain
symptoms:
  - request_payment_card refuses to run on order.online ordering pages
  - payment validator reports a checkout route on a non-checkout page
  - prod pickup order on order.online cannot collect card details
tags:
  - browser-agent
  - request-payment-card
  - domain-parsing
  - order-online
  - payment-validator
sources:
  - PR #816
repro: agents request_payment_card.blackbox.py
status: fixed
---

## Problem

RCA of prod agent `53feac08` (a Blue Bottle pickup order via order.online) found
that `request_payment_card` was unusable on the site: the payment validator's
host-level checkout-route detection flagged the page as a checkout page, so the tool
refused to proceed and the order could not be completed.

## Diagnosis

Checkout detection inspected the hostname for checkout-ish labels without
distinguishing subdomain labels from the registrable domain. Ordering platforms
whose registrable domain _is_ the word being matched — `order.online`, `orders.co` —
therefore matched unconditionally, on every page of the site. The heuristic was
correct in intent (block card entry on a real checkout host) but applied at the
wrong granularity, so it produced a permanent false positive for an entire class of
merchant platform.

## Solution

Host-level detection now only inspects **subdomain** labels, so a registrable domain
like `order.online` is no longer misread while `checkout.example.com` is still
rejected — and order.online _checkout paths_ continue to be rejected by the path
rules. The failure was reproduced and cemented in
`request_payment_card.blackbox.py`, which also protects the sibling case of any
future ordering platform whose domain collides with a checkout keyword.

## Human feedback

None recorded.

## Reusable lesson

Match host heuristics against subdomain labels only — a keyword check over the whole
hostname permanently misclassifies every site whose registrable domain contains the
keyword.
