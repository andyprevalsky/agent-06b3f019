---
id: 2026-10-30-it26-bu092-retained-city-claim
date: 2026-10-30
title: BU092 returns a supported year after an incorrect city-list claim
surface: agents
component: browser-actor-and-declared-evaluation
classification: unresolved
problem_class: other
first_bad_boundary: Captured actor response lists Mostar among the top four cities and is persisted unchanged before later evidence identifies Zenica
symptoms:
  - Native COMPLETED with progress 1 and final year 1942
  - Declared C3 rejects an earlier city-list claim
  - C1 C2 C4 pass while the original benchmark fails
tags:
  - r110
  - it26
  - bu092
  - retained-claim
sources:
  - commit 7e557a39083db505203e9e9bdf697e6c1a3f5a98
  - agent cd76b7df-aa6b-4e8b-af49-de5079b11399
  - plan:.context/r110/proof.json
repro: original sealed packet and captured actor/verifier records only
status: open
---

## Problem

It26 BU092r1/r001-j0002 asks the year of the event commemorated by a pre-1970
monument in a top-four Bosnian city, designed by an artist born in 1928.
The original native task completes in 503.7 seconds with progress 1 and final
answer 1942. The independent evaluator passes C1, C2 and C4 but fails C3 for
an earlier city-list claim. The canonical benchmark is FAILED, producer
infra FALSE, cleanup_failure absent. These outcomes remain unchanged.

## Diagnosis

Archive SHA c82230263af03d47c1cce5fa71a10c352058ddbe0865a1ed461133e743272cb4
and every normal manifest member's size/SHA independently verify. Manifest
SHA 64e8cf6a8a96c06acfc2e57c1beb0fc14dc2dacc89357fff9eccc9773f7e1b8a;
run SHA 0e136fbbc70a568702abf9873036a5c7b10605f977393ce30586f5962e7698a3.
Executed source is 7e557a, patch none. Supplemental driver/provenance records
are distinct from the seven-member normal manifest.

Captured browser step14 response, dump83a9abb12d94 at worker16898, states that
the top four cities are Mostar, Sarajevo, Banja Luka and Tuzla, and claims to
have noted census counts. Its action.thinking and reasoning are exactly equal
to the persisted assistant message at zero-based index68 (judge step69).
The full captured application dump SHA is
7081c9b7cf963b788a127fd9ab97d1919a9aef8d3b43d37748712bd387de2841.
No observed parser, transport or persistence transformation introduced this
claim. The captured actor input includes earlier searches using Zenica and
later a monument table containing Mostar; this does not establish why the
model substituted the city. No raw provider-wire parity or model replay is
claimed from the application dump alone.

The schema author required only event_year as an integer and retained the
user's top-four-city condition without inserting Mostar. Its explanatory
reasoning lists Zenica. Raw schema-output dump SHA is
169b30781e89d4def70300c70ae02d988e3909e1e314b46578393569114932e1.
Thus the observed incorrect city assertion is not a schema-required answer
or an output-field conversion failure.

Later captured Monumentalism observation at message79 explicitly describes
Zenica as the fourth-largest city. Spomenik Database at message88 identifies
the Zenica monument, designer Arfan Hozić, 1968 completion and the fatal event
on May 8, 1942. The final verifier uses those retained sources and the artist's
1928 birth year. Input SHA
e0f6eb7b819920eb17f7ee9eb1874905219c21b7351c75755488e75673afd4dd;
output SHA 698e48983d6748ad3724421a941158cd2a6fa4e4880261a7c9fa6056e4c5319a.
It returns event_year 1942, task_completed true, score 1.0. Final response is
1942. This validates a final output field; it does not erase earlier claims
from the trajectory assessed by the independent C3 criterion.

Two archive searches and the complete prior Solution/Human feedback sections
for BU087 unsupported distance and BU072 earlier contradictory date were
read after the original trace. They are comparator patterns of an earlier
claim surviving a supported final answer, not proof of a shared runtime bug.
Cleanup independently records Tilion DELETE204, no errors or warnings.
No positive operational infrastructure failure was established.

## Solution

OPEN: no general causal runtime repair established from these records.
Do not replace the historical claim, weaken C3, suppress all intermediate
responses, force the year, or treat final native score1 as the original
benchmark result. A claim-generation/revision mechanism would need separate
causal evidence and compatibility proof; this bounded intake does not justify
a new prompt, schema, model, budget or transport patch. No live calls or
replay were made.

## Human feedback

Parent requested original actor/input/schema/verifier evidence before family
assignment, preserved native-versus-benchmark axes, and required no answer
hack. This is a docs-only future child of e01233d; active source7e remains
unchanged. R106/R108 qualified code is preserved without new runtime changes.

## Reusable lesson

A supported final answer and a truthful final extraction do not establish that
every earlier actor claim was grounded. Preserve the original claim and its
later contrary evidence before proposing a transport or schema repair.
