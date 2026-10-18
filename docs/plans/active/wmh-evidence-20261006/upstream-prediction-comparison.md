# Current upstream prompt and architecture comparison

Checked October 6, 2026, on `codex/wmh-continuation-20261006`. This is a
diagnostic continuation, with no production dependency, prompt, artifact,
evaluator, timeout or model change and no new full fundraising benchmark.

## Measured predictions

Twenty-four isolated predictions used the original actual `gpt-6-sol-gpt`
model, Rose GPT OAuth transport, `rose-1-ultra`, default xhigh reasoning and
16,384 output tokens. Every call completed without execution errors. Browser
goals are unchanged; their complete text is in
[browser-goals-and-simulation-policy.md](browser-goals-and-simulation-policy.md).

| Input variant | Founders Fund concrete routes / submissions | Precursor concrete routes / submissions |
| --- | --- | --- |
| Original July prompt, prior control | 0/3 / 0/3 | 0/3 / 0/3 |
| Current upstream instructions, adapted legacy response contract | 0/3 / 0/3 | 0/3 / 0/3 |
| Exact upstream system and response protocol, legacy evidence layout | 0/3 / 0/3 | 0/3 / 0/3 |
| Exact upstream protocol, history and current notes removed | 0/3 / 0/3 | 0/3 / 0/3 |
| Actual upstream request builder, captured-data adapter, full context | 0/3 / 0/3 | 0/3 / 0/3 |

Two of the cleared-context Precursor predictions described a homepage-linked
pitch application without its destination or concrete fields. Both declined
submission because required company information was unknown, an accepted
blocker. These are partial route descriptions, not demonstrated usable forms.
All predictions retained $0 commitments/transfers. No-route results are not
automatically errors, and this diagnostic does not force every site to offer
an application or every application to succeed.

The latest upstream instructions did **not demonstrate improved concrete
forms or submissions in these captured browser cases**. Three calls per firm
and arm are not a reliability estimate. The exact v3 system retains realistic
results and consistency instructions but does not explicitly define how to
instantiate previously unseen public page contents. This source observation,
together with the earlier policy/context controls, supports keeping the
simulation-policy question separate from a package migration; it does not
prove a single literal prompt line causes the negative results.

Portable trial outputs, hashes, identities and limitations are in
[upstream-prediction-comparison.json](upstream-prediction-comparison.json).
Only each generated tool response's Extracted Output is included, excluding
hidden model reasoning and the synthetic Agent Reasoning section.

## Exact scope and adaptation

The policy-only arm preserves the original full user input byte for byte and
appends the old response contract to upstream's simulation instructions. It
is not the unchanged upstream system. The next two arms use the exact full
upstream system and remove the contradictory old contract footer; they retain
the old evidence layout. Clearing context removes both history and scratchpad,
so that comparison does not isolate either individually.

The fourth arm imports and calls upstream's actual `build_world_model_request`
from the checked commit in a separate Python 3.12 environment. It supplies the
same root task, complete candidate action and browser goal, initial/current
state, 69 prior actions and observation content strings, and five exact source
demonstrations. The builder emits the native JSON evidence frame with tools,
visible conversation and content-addressed grounding contexts. The adapter
derives a minimal canonical-envelope tool schema from the observed arguments;
it does not recover the real tool declarations. Its schema lacks required-field
and array-item constraints and reflects observed null values. Legacy rows lack
true episode initial context, so their prior state is explicitly labeled
`source_state_before` within demo `initial_context`. Adapter provenance IDs
are metadata, not recovered upstream artifact identities. Per-history prior
states and observation metadata are not repeated in the visible conversation.
This is a framing comparison with explicit conversion limits.

All v3 raw replies are retained privately. After completion only, a bridge
passes the single result to the old local Rose provider validator. The model
never sees that bridge. Actual upstream `parse_world_model_transition` and
`validate_transition_action` passed for all 18 native-protocol replies. New
retrieval, packing, artifact admission, continuation state and full rollout
machinery were not executed; the experiment cannot establish native engine
performance or state-consistency improvements.

Private reproduction scripts, using the existing Rose venv for model calls:

```bash
WMH_REPLAY_OUT=wmh-upstream-policy WMH_REPLAY_VARIANTS=upstream_policy python3 .context/wmh-upstream-policy-replay.py
python3 .context/wmh-upstream-protocol-replay.py
python3 .context/wmh-upstream-framed-replay.py
```

The native input extraction, frame construction and protocol validation are
`.context/wmh-upstream-native-inputs.py`,
`.context/wmh-upstream-native-build.py` and
`.context/wmh-upstream-validate.py`. The latter two use the separate
`.context/wmh-upstream-native-venv` and `PYTHONPATH=.context/wmh-upstream-audit/repo`.

## Architectural differences

Rose pins `world-model-harness` 0.1.0 at July 3 commit
`8e6d55ddc4b846d6a4e5a141983cbdfc0c22c364`. The installed base prompt,
original artifact prompt and original captured prompt exactly match that pin.
Upstream is now [Experiential](https://github.com/experientiallabs/experiential),
package 0.7.158, commit `bf75987eac5e8c984d8f3868249f84e4095d1733`.
The repository is 747 commits ahead; this is not a count of WMH-only changes.
Its v3 prompt last changed October 2 at
`bea8075f29d8563a52218a1c031a80a97d41b13a`.

- **Complete state:** upstream replaces a private JSON environment state each
  turn; the July engine appends `state_note` to a scratchpad while its structured
  seed remains static. This could represent page/form mutations more clearly,
  but generated state is not a deterministic semantic verifier. The source
  transition path is in [recording.py](https://github.com/experientiallabs/experiential/blob/bf75987eac5e8c984d8f3868249f84e4095d1733/exp/simulation/engines/text/recording.py).
- **Explicit call and evidence contracts:** schemas, candidate actions,
  ordered parallel call IDs and full demo task/context references are separate
  fields. Native validation checks correlation and termination rules. It does
  not validate the truth of generated page contents or side effects.
  See [prompt.py](https://github.com/experientiallabs/experiential/blob/bf75987eac5e8c984d8f3868249f84e4095d1733/exp/simulation/engines/text/prompt.py).
- **Provenance and frozen retrieval:** immutable source/model/prompt identities
  and lineage exclusions are enforced. Rose already prevents generated
  observations entering retrieval through its `RetrievalAuditRetriever.add`
  no-op; this is not a newly missing safeguard here. Upstream adds broader
  artifact identity checks. See [artifact.py](https://github.com/experientiallabs/experiential/blob/bf75987eac5e8c984d8f3868249f84e4095d1733/exp/simulation/world_model/artifact.py)
  and [retriever.py](https://github.com/experientiallabs/experiential/blob/bf75987eac5e8c984d8f3868249f84e4095d1733/exp/simulation/retrieval/retriever.py).
- **Capacity handling:** packing drops whole optional examples and their
  contexts, preserving required history. It does not compact the large
  conversation automatically. See [packing.py](https://github.com/experientiallabs/experiential/blob/bf75987eac5e8c984d8f3868249f84e4095d1733/exp/simulation/engines/text/packing.py).
- **Migration boundary:** APIs now use `exp` and Python >=3.12; Rose uses
  `wmh` and Python 3.11.9. The public upstream application has different
  session limits, serialized per-session completion and a 1,024-token output
  reservation. Those defaults were not used in these controlled replays.
  See [pyproject.toml](https://github.com/experientiallabs/experiential/blob/bf75987eac5e8c984d8f3868249f84e4095d1733/pyproject.toml)
  and [application.py](https://github.com/experientiallabs/experiential/blob/bf75987eac5e8c984d8f3868249f84e4095d1733/exp/simulation/world_model/application.py).

A package-pin update is insufficient. Current corpus refresh intentionally
preserves the saved optimized prompt, and the loader prefers that artifact
prompt to the package base prompt. A migration would need explicit API,
artifact, prompt and runtime adaptation followed by matching conformance and
full benchmark/replay verification. None is claimed by these diagnostics.
