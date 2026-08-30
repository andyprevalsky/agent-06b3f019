"""July OAi-demo for_each creator list + GP execute_loop namespace map.

Scoped to test-mass-agent-run-0. Live for_each must spawn these 50 creators and
child goal_hash must resolve to the July execute_loop namespaces — otherwise
Fast Mode cold-passthroughs a 24s traj-end stub.
"""

from __future__ import annotations

import json
import re
from typing import Any

JULY_FOR_EACH_ITEMS: list[dict[str, Any]] = json.loads(r"""[
  {
    "rank": 1,
    "name": "Andrew Huberman"
  },
  {
    "rank": 2,
    "name": "Bryan Johnson"
  },
  {
    "rank": 3,
    "name": "Peter Attia"
  },
  {
    "rank": 4,
    "name": "Rhonda Patrick"
  },
  {
    "rank": 5,
    "name": "Tim Ferriss"
  },
  {
    "rank": 6,
    "name": "Dave Asprey"
  },
  {
    "rank": 7,
    "name": "Gary Brecka"
  },
  {
    "rank": 8,
    "name": "Siim Land"
  },
  {
    "rank": 9,
    "name": "Ben Greenfield"
  },
  {
    "rank": 10,
    "name": "Nick Norwitz"
  },
  {
    "rank": 11,
    "name": "Lex Fridman"
  },
  {
    "rank": 12,
    "name": "Ali Abdaal"
  },
  {
    "rank": 13,
    "name": "Chris Williamson"
  },
  {
    "rank": 14,
    "name": "Steven Bartlett"
  },
  {
    "rank": 15,
    "name": "Mark Hyman"
  },
  {
    "rank": 16,
    "name": "David Sinclair"
  },
  {
    "rank": 17,
    "name": "Casey Means"
  },
  {
    "rank": 18,
    "name": "Gabrielle Lyon"
  },
  {
    "rank": 19,
    "name": "Molly Maloof"
  },
  {
    "rank": 20,
    "name": "Max Lugavere"
  },
  {
    "rank": 21,
    "name": "Thomas DeLauer"
  },
  {
    "rank": 22,
    "name": "Michael Lustgarten"
  },
  {
    "rank": 23,
    "name": "Matt Kaeberlein"
  },
  {
    "rank": 24,
    "name": "Eric Topol"
  },
  {
    "rank": 25,
    "name": "Sahil Bloom"
  },
  {
    "rank": 26,
    "name": "Dan Koe"
  },
  {
    "rank": 27,
    "name": "Justin Welsh"
  },
  {
    "rank": 28,
    "name": "Greg Isenberg"
  },
  {
    "rank": 29,
    "name": "Lenny Rachitsky"
  },
  {
    "rank": 30,
    "name": "Gergely Orosz"
  },
  {
    "rank": 31,
    "name": "Ethan Mollick"
  },
  {
    "rank": 32,
    "name": "Allie K. Miller"
  },
  {
    "rank": 33,
    "name": "Rowan Cheung"
  },
  {
    "rank": 34,
    "name": "Matt Wolfe"
  },
  {
    "rank": 35,
    "name": "Roberto Nickson"
  },
  {
    "rank": 36,
    "name": "Tina Huang"
  },
  {
    "rank": 37,
    "name": "Pieter Levels"
  },
  {
    "rank": 38,
    "name": "Brett Adcock"
  },
  {
    "rank": 39,
    "name": "Andrew Wilkinson"
  },
  {
    "rank": 40,
    "name": "Naval Ravikant"
  },
  {
    "rank": 41,
    "name": "Sam Parr"
  },
  {
    "rank": 42,
    "name": "Codie Sanchez"
  },
  {
    "rank": 43,
    "name": "Marques Brownlee"
  },
  {
    "rank": 44,
    "name": "Khe Hy"
  },
  {
    "rank": 45,
    "name": "Thomas Frank"
  },
  {
    "rank": 46,
    "name": "Matt D'Avella"
  },
  {
    "rank": 47,
    "name": "Joey Schweitzer / Better Ideas"
  },
  {
    "rank": 48,
    "name": "Nathaniel Drew"
  },
  {
    "rank": 49,
    "name": "Wes Roth"
  },
  {
    "rank": 50,
    "name": "Ranveer Allahbadia"
  }
]""")

JULY_GP_GOAL_HASHES: dict[str, str] = json.loads(r"""{
  "Andrew Huberman": "5e1731f836723fb1",
  "Bryan Johnson": "2ffa1fbe4843a00f",
  "Peter Attia": "65d4e0248f84bef8",
  "Rhonda Patrick": "2f47e3eca2f296ff",
  "Tim Ferriss": "308533b0687c42f1",
  "Dave Asprey": "705d208b550fabf9",
  "Gary Brecka": "822459b31c94bebd",
  "Siim Land": "5b50a433ea00553e",
  "Ben Greenfield": "90b0a43f90f89a32",
  "Nick Norwitz": "822212860717c80f",
  "Lex Fridman": "d587ab24de079872",
  "Ali Abdaal": "5872737e678bfc65",
  "Chris Williamson": "7499abccb0ac6254",
  "Steven Bartlett": "3389a431c3c428c2",
  "Mark Hyman": "cf733069e1f8e594",
  "David Sinclair": "1eb48490335b5913",
  "Casey Means": "918974d8c4516a50",
  "Gabrielle Lyon": "bfd8e1b50f417841",
  "Molly Maloof": "a9edd0c280965a52",
  "Max Lugavere": "870aa798f805d115",
  "Thomas DeLauer": "da9ab880f5cf47b0",
  "Michael Lustgarten": "764c4fee3d3cf4a3",
  "Matt Kaeberlein": "e77071601a788aad",
  "Eric Topol": "a33288f6c3a3e484",
  "Sahil Bloom": "3fd2fec61970ac83",
  "Dan Koe": "b5db973bb7c104af",
  "Justin Welsh": "ebdf32d4d67cb7b8",
  "Greg Isenberg": "b47929301a17dd66",
  "Lenny Rachitsky": "185ab81fcd1829e7",
  "Gergely Orosz": "4f1e222cdd445fa8",
  "Ethan Mollick": "92db2b751402e7f7",
  "Allie K. Miller": "122bf1458146116c",
  "Rowan Cheung": "c1a89807a217bd39",
  "Matt Wolfe": "9bd2ac19e313b421",
  "Roberto Nickson": "5c1c1e4873818cfd",
  "Tina Huang": "c97f6411e974f999",
  "Pieter Levels": "2a5047c41ade580c",
  "Brett Adcock": "cd0f862fb5fc3094",
  "Andrew Wilkinson": "3abe247e3d0191bf",
  "Naval Ravikant": "4685e8b287fb3986",
  "Sam Parr": "de9db95dc0ccc267",
  "Codie Sanchez": "07bda83296ad43be",
  "Marques Brownlee": "ceefe41146c9aefc",
  "Khe Hy": "754e78c9cadc9979",
  "Thomas Frank": "df7ecb881efd0d2d",
  "Matt D'Avella": "83865d527880b2b7",
  "Joey Schweitzer / Better Ideas": "ed289c2a0fcc45e6",
  "Nathaniel Drew": "74732a761f790f81",
  "Wes Roth": "934c2b9720294e60",
  "Ranveer Allahbadia": "8490ce582e612e06"
}""")

_CREATOR_PATTERNS = (
    re.compile(r'"creator_name"\s*:\s*"([^"]+)"'),
    re.compile(r'"name"\s*:\s*"([^"]+)"'),
    re.compile(r"Creator:\s*([^\n]+)"),
    re.compile(r"creator\s+([^(\n]+?)\s*\(\s*rank\s+\d+", re.IGNORECASE),
)

# July explore_agent namespaces (p:1 is web_search/web_fetch). Used only as a
# get-position fallback when a GP-spawned explore goal is cold — do not remap
# warm unique explore hashes. Keep smallest dedicated July rows.
JULY_EXPLORE_GOAL_HASHES: dict[str, str] = json.loads(r"""{
  "Andrew Huberman": "6dee23173fe18533",
  "Rhonda Patrick": "a8189709726b0cb1",
  "Tim Ferriss": "23f5095f4949772c",
  "Dave Asprey": "cb212730b54d95e6",
  "Gary Brecka": "408b1a3052d03321",
  "Siim Land": "7af1dab03b97f2c3",
  "Ben Greenfield": "c6327dbb90173c96",
  "Nick Norwitz": "1336d2b95eea0501",
  "Lex Fridman": "c93e942dad7752fd",
  "Ali Abdaal": "c44100b7facbb2e6",
  "Chris Williamson": "bb8a2942042a15d7",
  "Steven Bartlett": "dc667d4b8a9dc770",
  "Mark Hyman": "c93f89310e3a9ea2",
  "David Sinclair": "588fa4bf5517a5ec",
  "Casey Means": "0931c308d4db5d54",
  "Gabrielle Lyon": "14b6d48a20a8ac6f",
  "Molly Maloof": "1e80caff3f0e8008",
  "Max Lugavere": "0d7edbde270b905a",
  "Thomas DeLauer": "af9949d3125dd2eb",
  "Michael Lustgarten": "e27dcd2a65fe1a01",
  "Matt Kaeberlein": "017d2771a41d8352",
  "Eric Topol": "e795d5b635fd77a9",
  "Sahil Bloom": "21896113300f5724",
  "Dan Koe": "05729a030af3214a",
  "Justin Welsh": "e4c9681bbd189219",
  "Greg Isenberg": "16e383309e905a76",
  "Lenny Rachitsky": "124ad1117dd02c75",
  "Gergely Orosz": "c8f769e9e8181ec4",
  "Ethan Mollick": "5f78b4367be90373",
  "Allie K. Miller": "aad1d53f28a9d568",
  "Rowan Cheung": "ed75f77e7d7793e3",
  "Matt Wolfe": "6c051c250b826d32",
  "Roberto Nickson": "7afbcbea56c426a2",
  "Pieter Levels": "7bfffd4b69a39f0a",
  "Brett Adcock": "3d724132767e176e",
  "Andrew Wilkinson": "ae5ad4e2ffb5bb53",
  "Naval Ravikant": "efae66fbd731b771",
  "Sam Parr": "3065a9b253bfee62",
  "Codie Sanchez": "1d0ba06372d97ec4",
  "Marques Brownlee": "8f2de8f066dbf3a9",
  "Khe Hy": "29c78203b1b737a3",
  "Thomas Frank": "0c89720b69731e80",
  "Matt D'Avella": "65f18b44a37cb38c",
  "Joey Schweitzer": "4857d4d2290141b3",
  "Nathaniel Drew": "f2d4669880a84caa",
  "Wes Roth": "79be645b45e61cc9",
  "Ranveer Allahbadia": "2da854102a82f475"
}""")


def normalize_oai_demo_creator_key(name: str) -> str:
    text = (name or "").strip().lower()
    text = re.sub(r"^dr\.?\s+", "", text)
    text = text.split(" / ", 1)[0].strip()
    return re.sub(r"\s+", " ", text)


_JULY_GP_HASH_BY_KEY = {
    normalize_oai_demo_creator_key(name): goal_hash
    for name, goal_hash in JULY_GP_GOAL_HASHES.items()
}

_JULY_EXPLORE_HASH_BY_KEY = {
    normalize_oai_demo_creator_key(name): goal_hash
    for name, goal_hash in JULY_EXPLORE_GOAL_HASHES.items()
}

_JULY_CREATOR_NAMES_BY_LEN = sorted(JULY_GP_GOAL_HASHES.keys(), key=len, reverse=True)


def extract_oai_demo_creator_name(goal: str) -> str | None:
    blob = goal or ""
    for pattern in _CREATOR_PATTERNS:
        match = pattern.search(blob)
        if match:
            name = match.group(1).strip().rstrip(".").strip()
            if name:
                return name
    lowered = blob.lower()
    for name in _JULY_CREATOR_NAMES_BY_LEN:
        if name.lower() in lowered:
            return name
    return None


def july_gp_goal_hash_for_goal(goal: str) -> str | None:
    name = extract_oai_demo_creator_name(goal)
    if not name:
        return None
    return _JULY_GP_HASH_BY_KEY.get(normalize_oai_demo_creator_key(name))


def july_explore_goal_hash_for_goal(goal: str) -> str | None:
    """July explore_agent namespace for a GP-spawned research prompt, if any."""
    name = extract_oai_demo_creator_name(goal)
    if not name:
        return None
    return _JULY_EXPLORE_HASH_BY_KEY.get(normalize_oai_demo_creator_key(name))


def apply_oai_demo_july_for_each(
    base_goal: str,
    items: list[Any],
    *,
    enabled: bool,
) -> tuple[str, list[Any]]:
    """Replace live for_each items with the July OAi-demo creator set."""
    if not enabled:
        return base_goal, items
    return base_goal, [dict(item) for item in JULY_FOR_EACH_ITEMS]
