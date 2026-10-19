"""Per-run WMH context insertion for one simulated world.

The returned state is a normal ``--wmh-initial-state-file`` override. Native
sessions copy their seed into ``initial_context``, so inserted context sits in the
session-constant task evidence of every world-model request (the cached system
prefix on Azure). Nothing is inserted into any agent's trajectory.

Three kinds of world context:

* ``structured.base_rates`` (default: the user's canonical fundraiser set in
  ``fixtures/wmh/fundraiser-base-rates.json``). Under policy
  ``rose-outcome-distribution-v4`` these keyed rates are the default probability
  distribution for a matching result, and the simulator validates declared
  distributions against them.
* ``structured.network.derived_warmth``: a warmth signal derived from the
  network's own message counts, contact frequency and email domains, labeled as
  derived rather than source-verified.
* ``structured.outcome_distribution_examples`` (optional): researched reference
  examples that the model reasons from; never inserted by default.
"""

from __future__ import annotations

import argparse
import json
import math
from copy import deepcopy
from pathlib import Path
from typing import Any

from benchmarks.long_horizon import validate_wmh_initial_state

OUTCOME_EXAMPLES_KEY = "outcome_distribution_examples"
EXAMPLES_TEXT = (
    "Outcome distribution examples for this run (researched base rates with their sources, listed in "
    f"structured.{OUTCOME_EXAMPLES_KEY}): when a candidate action resembles an example, use its "
    "distribution as a reference and reason from there about the current state and evidence. They are "
    "examples, not constraints; every outcome still requires its causal preconditions."
)
_EXAMPLE_KEYS = {"action", "applies_when", "typical_time", "outcomes", "sources"}

BASE_RATES_KEY = "base_rates"
CANONICAL_BASE_RATES_PATH = Path(__file__).resolve().parent / "fixtures" / "wmh" / "fundraiser-base-rates.json"
BASE_RATES_TEXT = (
    f"Base rates for this world (structured.{BASE_RATES_KEY}): each keyed rate is the default probability "
    "that its event happens when an action can cause it. Use it for the matching result unless the state gives "
    "a concrete reason otherwise."
)
_BASE_RATE_KEYS = {"key", "probability", "event", "applies_when"}
# Optional structured applicability: the exact candidate tools whose calls must declare the rate.
_BASE_RATE_OPTIONAL_KEYS = {"applies_to", "applies_to_outreach", "group", "precondition"}
_APPLIES_TO_KEYS = {"category", "tool", "argument"}
_PRECONDITION_KEYS = {"counterparty_argument", "delivered_base_rate_keys", "present"}
_RATE_KEY_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789_")

WARMTH_KEY = "derived_warmth"
WARMTH_SCHEMA = "rose.network_derived_warmth.v1"
# Domain tokens that mark an investor-like email domain (fund, venture, angel platforms).
INVESTOR_DOMAIN_TOKENS = ("vc", "venture", "capital", "partners", "fund", "invest", "angel")
WARMTH_DERIVATION = (
    "Derived by Rose from this network's own messagesExchanged and communicationFrequency (strong: daily or "
    "weekly contact, or at least 50 messages; warm: monthly contact or at least 10 messages; light: yearly contact "
    "or at least 3 messages; otherwise cold) and from investor-like email domain tokens ("
    + ", ".join(INVESTOR_DOMAIN_TOKENS)
    + "). A derived signal, not a source-verified relationship, introduction or investor role; rows list "
    "strong/warm contacts and every investor-like-domain contact."
)


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value.strip()


def _example(entry: Any) -> dict[str, Any]:
    if not isinstance(entry, dict) or set(entry) - _EXAMPLE_KEYS or not {"action", "outcomes", "sources"} <= set(entry):
        raise ValueError("Each example needs action, outcomes and sources, with optional applies_when and typical_time")
    action = _text(entry["action"], "Example action")
    sources = entry["sources"]
    if not isinstance(sources, list) or not sources:
        raise ValueError(f"{action}: cite at least one research source")
    outcomes, seen = [], set()
    if not isinstance(entry["outcomes"], list) or not entry["outcomes"]:
        raise ValueError(f"{action}: outcomes must be a nonempty list")
    for outcome in entry["outcomes"]:
        if not isinstance(outcome, dict) or set(outcome) != {"outcome", "probability"}:
            raise ValueError(f"{action}: each outcome needs exactly outcome and probability")
        name = _text(outcome["outcome"], f"{action}: outcome")
        probability = outcome["probability"]
        if isinstance(probability, bool) or not isinstance(probability, (int, float)):
            raise ValueError(f"{action}: {name} probability must be a number")
        if not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError(f"{action}: {name} probability must be between 0 and 1")
        if name.casefold() in seen:
            raise ValueError(f"{action}: duplicate outcome {name}")
        seen.add(name.casefold())
        outcomes.append({"outcome": name, "probability": float(probability)})
    if not math.isclose(math.fsum(o["probability"] for o in outcomes), 1.0, rel_tol=0, abs_tol=1e-6):
        raise ValueError(f"{action}: outcome probabilities must sum to 1")
    example = {"action": action}
    for key in ("applies_when", "typical_time"):
        if entry.get(key) is not None:
            example[key] = _text(entry[key], f"{action}: {key}")
    example["outcomes"] = outcomes
    example["sources"] = [_text(source, f"{action}: source") for source in sources]
    return example


def validated_outcome_examples(examples: list[Any]) -> list[dict[str, Any]]:
    """Normalize sourced outcome examples; each action once, each distribution summing to 1."""
    if not isinstance(examples, list) or not examples:
        raise ValueError("Outcome examples must be a nonempty list")
    validated = [_example(entry) for entry in examples]
    actions = [example["action"].casefold() for example in validated]
    if len(set(actions)) != len(actions):
        raise ValueError("Each action may have only one outcome example")
    return validated


def insert_outcome_examples(state: dict[str, Any], examples: list[Any], *, item_id: str) -> dict[str, Any]:
    """Return a copy of ``state`` carrying the validated, sourced outcome examples once."""
    validated = validated_outcome_examples(examples)
    result = deepcopy(validate_wmh_initial_state(state, item_id))
    if OUTCOME_EXAMPLES_KEY in result["structured"] or EXAMPLES_TEXT in result["scratchpad"]:
        raise ValueError(f"{item_id}: outcome examples were already inserted")
    result["structured"][OUTCOME_EXAMPLES_KEY] = validated
    result["scratchpad"] = (result["scratchpad"].rstrip() + "\n\n" + EXAMPLES_TEXT).strip()
    return validate_wmh_initial_state(result, item_id)


def validated_base_rates(rates: Any) -> list[dict[str, Any]]:
    """Normalize keyed base rates: unique snake_case keys, probabilities strictly between 0 and 1."""
    if isinstance(rates, dict) and isinstance(rates.get("base_rates"), list):
        rates = rates["base_rates"]
    if not isinstance(rates, list) or not rates:
        raise ValueError("Base rates must be a nonempty list")
    validated, keys = [], set()
    for rate in rates:
        if not isinstance(rate, dict) or not _BASE_RATE_KEYS <= set(rate) <= _BASE_RATE_KEYS | _BASE_RATE_OPTIONAL_KEYS:
            raise ValueError("Each base rate needs key, probability, event and applies_when (plus optional applicability)")
        key = _text(rate["key"], "Base rate key")
        if not set(key) <= _RATE_KEY_CHARS or key in keys:
            raise ValueError(f"{key}: base rate keys must be unique snake_case")
        keys.add(key)
        probability = rate["probability"]
        if isinstance(probability, bool) or not isinstance(probability, (int, float)) or not 0 < probability < 1:
            raise ValueError(f"{key}: base rate probability must be strictly between 0 and 1")
        entry = {
            "key": key,
            "probability": float(probability),
            "event": _text(rate["event"], f"{key}: event"),
            "applies_when": _text(rate["applies_when"], f"{key}: applies_when"),
        }
        entry.update(_validated_applicability(rate, key))
        validated.append(entry)
    for entry in validated:
        listed = (entry.get("precondition") or {}).get("delivered_base_rate_keys", ())
        if not set(listed) <= keys:
            raise ValueError(f"{entry['key']}: precondition names an unlisted base rate")
    return validated


def _validated_applicability(rate: dict[str, Any], key: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    if "applies_to" in rate:
        targets = rate["applies_to"]
        if not isinstance(targets, list) or not targets:
            raise ValueError(f"{key}: applies_to must be a nonempty list")
        for target in targets:
            if not isinstance(target, dict) or set(target) != _APPLIES_TO_KEYS:
                raise ValueError(f"{key}: applies_to entries need exactly category, tool and argument")
            for field in _APPLIES_TO_KEYS:
                _text(target[field], f"{key}: applies_to {field}")
        result["applies_to"] = deepcopy(targets)
    if "applies_to_outreach" in rate:
        target = rate["applies_to_outreach"]
        if not isinstance(target, dict) or set(target) != {"warm"} or not isinstance(target["warm"], bool):
            raise ValueError(f"{key}: applies_to_outreach must be exactly {{warm: bool}}")
        result["applies_to_outreach"] = dict(target)
    if "group" in rate:
        result["group"] = _text(rate["group"], f"{key}: group")
    if "precondition" in rate:
        condition = rate["precondition"]
        if (
            not {"applies_to", "applies_to_outreach"} & set(rate)
            or not isinstance(condition, dict)
            or set(condition) != _PRECONDITION_KEYS
            or not isinstance(condition["present"], bool)
            or not isinstance(condition["delivered_base_rate_keys"], list)
            or not condition["delivered_base_rate_keys"]
        ):
            raise ValueError(f"{key}: precondition needs applies_to(_outreach) plus counterparty_argument, keys and present")
        _text(condition["counterparty_argument"], f"{key}: precondition counterparty_argument")
        result["precondition"] = deepcopy(condition)
    return result


def load_canonical_base_rates(path: Path = CANONICAL_BASE_RATES_PATH) -> list[dict[str, Any]]:
    """The user's canonical fundraiser base-rate set, the default inserted set."""
    return validated_base_rates(json.loads(Path(path).read_text(encoding="utf-8")))


def insert_base_rates(state: dict[str, Any], rates: Any, *, item_id: str) -> dict[str, Any]:
    """Return a copy of ``state`` carrying the validated keyed base rates once."""
    validated = validated_base_rates(rates)
    result = deepcopy(validate_wmh_initial_state(state, item_id))
    if BASE_RATES_KEY in result["structured"] or BASE_RATES_TEXT in result["scratchpad"]:
        raise ValueError(f"{item_id}: base rates were already inserted")
    result["structured"][BASE_RATES_KEY] = validated
    result["scratchpad"] = (result["scratchpad"].rstrip() + "\n\n" + BASE_RATES_TEXT).strip()
    return validate_wmh_initial_state(result, item_id)


def _domains(row: dict[str, Any]) -> list[str]:
    addresses = list(row.get("emailAddresses") or [])
    if row.get("email"):
        addresses.append(row["email"])
    return sorted({a.rsplit("@", 1)[-1].lower() for a in addresses if isinstance(a, str) and "@" in a})


def warmth_tier(messages_exchanged: Any, frequency: Any) -> str:
    count = messages_exchanged if type(messages_exchanged) is int else 0
    if frequency in {"daily", "weekly"} or count >= 50:
        return "strong"
    if frequency == "monthly" or count >= 10:
        return "warm"
    if frequency == "yearly" or count >= 3:
        return "light"
    return "cold"


def derive_network_warmth(state: dict[str, Any], *, item_id: str) -> dict[str, Any]:
    """Add a labeled, derived warmth packet for the columnar static network, if present."""
    result = deepcopy(validate_wmh_initial_state(state, item_id))
    network = result["structured"].get("network")
    packet = network.get("static_full_network") if isinstance(network, dict) else None
    if not isinstance(packet, dict) or not isinstance(packet.get("rows"), list):
        return result
    if WARMTH_KEY in network:
        raise ValueError(f"{item_id}: derived warmth was already inserted")
    columns = packet.get("row_columns")
    shared = packet.get("shared_fields") if isinstance(packet.get("shared_fields"), dict) else {}
    if not isinstance(columns, list):
        raise ValueError(f"{item_id}: static network rows need row_columns")
    rows, tiers, investor_like = [], {"strong": 0, "warm": 0, "light": 0, "cold": 0}, 0
    for values in packet["rows"]:
        row = {**shared, **dict(zip(columns, values))}
        tier = warmth_tier(row.get("messagesExchanged"), row.get("communicationFrequency"))
        tiers[tier] += 1
        domains = _domains(row)
        investor = any(token in domain for domain in domains for token in INVESTOR_DOMAIN_TOKENS)
        investor_like += investor
        if tier in {"strong", "warm"} or investor:
            name = " ".join(str(row.get(k) or "").strip() for k in ("firstName", "lastName")).strip()
            rows.append(
                [
                    row.get("id"),
                    name or None,
                    domains,
                    row.get("messagesExchanged"),
                    row.get("communicationFrequency"),
                    tier,
                    investor,
                ]
            )
    network[WARMTH_KEY] = {
        "schema": WARMTH_SCHEMA,
        "source_verified": False,
        "derivation": WARMTH_DERIVATION,
        "contacts": len(packet["rows"]),
        "tier_counts": tiers,
        "investor_like_domain_contacts": investor_like,
        "columns": [
            "id",
            "name",
            "email_domains",
            "messages_exchanged",
            "communication_frequency",
            "derived_warmth",
            "investor_like_domain",
        ],
        "rows": rows,
    }
    return validate_wmh_initial_state(result, item_id)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, help="Catalog task whose wmh_initial_state is the base")
    parser.add_argument(
        "--base-state",
        type=Path,
        help="Start from this prepared state (for example one with a static network) instead of the catalog seed",
    )
    parser.add_argument(
        "--base-rates",
        type=Path,
        default=CANONICAL_BASE_RATES_PATH,
        help="Keyed base rates (default: the user's canonical fundraiser set)",
    )
    parser.add_argument(
        "--examples",
        type=Path,
        help="Optional JSON list of {action, outcomes: [{outcome, probability}], sources[, applies_when, typical_time]}",
    )
    parser.add_argument("--out", required=True, type=Path, help="Per-run --wmh-initial-state-file to write")
    args = parser.parse_args(argv)
    if args.base_state is not None:
        state = json.loads(args.base_state.read_text(encoding="utf-8"))
    else:
        from benchmarks.benchmark_tasks import get_task_by_name

        task = get_task_by_name(args.task)
        if task is None or not task.wmh_initial_state:
            raise SystemExit(f"{args.task}: no catalog wmh_initial_state to extend")
        state = task.wmh_initial_state
    state = insert_base_rates(state, json.loads(args.base_rates.read_text(encoding="utf-8")), item_id=args.task)
    state = derive_network_warmth(state, item_id=args.task)
    if args.examples is not None:
        state = insert_outcome_examples(state, json.loads(args.examples.read_text(encoding="utf-8")), item_id=args.task)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
