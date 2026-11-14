---
id: 2026-10-30-r111-it26-exact-owner-cleanup
date: 2026-10-30
title: It26 twelve retained owners recovered through canonical guest and runtime checks
surface: infra
component: cloudbench-exact-owner-recovery
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Twelve original cleanup lifecycles retained guest and runtime latches after the It26 stop
symptoms:
  - guest-cleanup-unconfirmed
  - runtime-evidence-unconfirmed
  - FAILED lifecycle with retained ownership
tags:
  - r111
  - it26
  - cleanup
sources:
  - commit 7e557a39083db505203e9e9bdf697e6c1a3f5a98
  - plan:.context/descend-k3/k2-it26/retained-recovery-r001-j0001
repro: none-recorded; original custody and authorized canonical recovery receipts
status: open
---

## Problem

It26 left twelve exact owners with guest-cleanup-unconfirmed and
runtime-evidence-unconfirmed latches, while five other original cleanup
lifecycles were already verified. The original task summary remains
**1 PASS, 3 FAIL, 16 CANCELLED**; original cleanup history remains
**5 verified, 12 FAILED**. Later recovery does not rewrite either history.
The causes of the interrupted original cleanup remain separate and OPEN.

## Diagnosis

All twelve plans were bound to original source
`7e557a39083db505203e9e9bdf697e6c1a3f5a98`. Independent PREP review verified
all 301 supplied custody file sizes and SHA256 values, then joined registry,
audit/fresh, expected-fresh, by-machine-id, task `.cid`, primary IDs and status
ports. Each owner had one fresh primary and no pool or child worker in the
actual planner output. Donor `683e47df5094d8` was provenance, not a selected
recovery target.

The exact `run-bench-fleet` embedded planner was executed against relocated
scratch copies of the twelve original records: all twelve produced exactly
one matching guest; all twelve invalid-port controls refused. Four source
helper hashes were checked, including controller
`f7888e22e75b8079040e790e1c38f7112bd10104e3714b0642a7d235d69b1098`.
Only filesystem prefixes in scratch metadata were relocated. No native or
host-liveness operation was performed by the reviewer. These checks establish
mapping validity, not current guest readiness or authorization to recover.

PREP also documented the limits: absent locks and dead PIDs were owning-host
observations; the initial reviewer did not locate the named before-pin files.
The parent verified their original bytes in a dedicated bundle and rechecked
all twelve before-pin snapshots and
fresh owning-host predicates before the separately authorized operations.
`--ref` alone does not authenticate the executing controller: its snapshotted
helper bytes must match the reviewed source.

The R98 cleanup record was read as a procedural comparison, not evidence of
this run's cause or proof of release. Existing canonical recovery keeps guest
ACK and runtime evidence as separate obligations. A failed runtime transfer can
retain its evidence latch and volume even after guest ACK; no missing evidence
may be manufactured from an empty registry or a successful subprocess exit.

## Solution

No runtime change, manual latch/ACK mutation, timeout override, new benchmark,
or model replay. The coordinator authorized exact-owner recovery after review,
and the launch owner executed the canonical command for each listed token:

```text
bash scripts/run-bench-fleet --ref 7e557a39083db505203e9e9bdf697e6c1a3f5a98 --recover-stale-owner <exact owner>
```

All twelve recorded commands exited `0`. Their stdout records authenticated
cleanup acknowledgement, sealed runtime recapture, owned-clone teardown and
successful ownership reconciliation. The reviewer performed no recovery,
provider query, guest operation or additional capture.

| Job | Exact owner | Canonical/mirror SHA256 |
| --- | --- | --- |
| r001-j0001 | b075964a13fa41d78a2ae27d624110d6 | f3cec618dfeaa39b2e916e5a6b2f1415ee3a258dcaef4656530e15af14435c87 |
| r001-j0003 | a21d884e77424a64806050fa54b227b0 | 59d64148b374fe5ca3a3eb7639d92135be7ebf456d6609c49169cbc92c26619b |
| r001-j0004 | 1e650b50d79445a9b77d72ca9852cf76 | 5a06e112adb51d561f5b240205a9388d91e1d7e4b34ea8070ff1b407bb5b9d52 |
| r001-j0005 | 0bd14d6ba9e94f169f4da059a4c38081 | 46e4bae1f30db5297e4457e6b7c53a5ac51a1d35c08a029f371adc7caa367340 |
| r001-j0006 | cba0eef5e533404695d8a1e6c8b75030 | fab698c867f5bcee8f36e7caa49e2c37cb086a5e1e638539e2929cce466b88e4 |
| r001-j0008 | a68c4916e140465fbb779be528fcbe80 | 795fdf21f93a12457801d6c4cc02e15ca82b53cf571e214501a37aada93976ae |
| r001-j0009 | 86e68262313b4c44a4f28029702e4075 | 8a200dc2eee85dac584c7c91a4c2ee1032a9adc82c202cf7773e506676cee8c3 |
| r001-j0010 | 995192c44b4946e3b13276046883c4db | 8de9dd741edeabf8dc7f843cc1ab0a4dfff651f4658ff321c2fc0065a4cc262a |
| r002-j0011 | 988b1a38410c4c37be6bb1a3a5d6038a | 09bb87bb34c5ada7f8b95170209f88c8a2df85012d9a4f9abc3f493c183b3762 |
| r002-j0014 | a726a489176c4bb2a72dc5fe892e460b | c452af19b09a89a1166d498431d733dc3725f1204c0452577f66a5f31c9466d0 |
| r002-j0015 | 9077826cd5f34d289982e59061511a92 | c060bf002676ff93e5e9f5ec4162c4adbf4bf33f510c51d73a564fb6de742088 |
| r002-j0016 | 5d56bd48d9404726ad83b5f351f2fe93 | bbaec32d3f855a9d93d79acca1cc31aae532512c1ac10824963c85c32bb29a60 |

## Verification

The reviewer independently reopened all **twelve full 20-file canonical trees**
and their twelve mirrors, recomputed the canonical length-prefixed
path-and-payload digest, compared every corresponding file, and checked each
mirror's `source-audit` path/hash binding. Every digest equals the table and its
aggregate row. Terminal records match each exact owner, original source,
command and `exit_code: 0`. All twelve original FAILED lifecycle files were
reopened from the initial custody and still match their original hashes.
All seventeen lifecycle hashes in the supplied before maps agree with the
aggregate. The prior five full terminal trees were independently verified by
the parent, not reopened by this reviewer in the twelve-tree archive.

Aggregate17 has SHA256
`d4e8c8e0113760fc4f1bf0b25d0a505baf24c74fe8ce8f4cfed6c17ee2b5ea45`.
It records sequence session43920 exit `0`, twelve recovered owners and five
previously verified owners. The original summary digest remains
`30333cb2b1c910c2b6a8f02750a3905085bce3b5f0f4886cd5e90abe1449eaf8`.
Summary byte preservation and all seventeen complete terminal trees are also
reported in the parent's separate final verification; they are not substituted
for this reviewer's narrower raw twelve-tree checks.

Every recovered fresh-audit record uses disposition
`destroyed-provider-retained`. The provider-teardown marker and matching
canonical/mirror custody establish scoped post-recovery operational release;
they do **not** prove universal object absence. Current registry absence is an
owning-host observation, not an independent host or account-wide query by this
reviewer. Guest ACK and runtime capture are recorded in the recovery logs;
the reviewer did not call their endpoints again.

There is no original-finish release credit, new task PASS, or causal runtime
fix. R109's upstream CDP close and unknown initiating cause remain separate.

## Human feedback

The coordinator required per-owner planning, separately authorized canonical
operations, verification of preceding outcomes, and complete recovered custody
plus aggregate comparison before documentation. Original grades, lifecycles,
and provider-retained limitations must remain explicit. This reviewer was not
authorized to operate on resources and did not do so. Tokens UNMETERED.

## Reusable lesson

Verify exact recovered custody while keeping later operational release separate
from original failed cleanup history, task grades and unproven resource absence.
