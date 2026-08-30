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
  "Bryan Johnson": "d5ca1a36cddc02e8",
  "Peter Attia": "65d4e0248f84bef8",
  "Rhonda Patrick": "2f47e3eca2f296ff",
  "Tim Ferriss": "a40f6dd9ace06b6c",
  "Dave Asprey": "115e7be730aed584",
  "Gary Brecka": "1f60137116da569c",
  "Siim Land": "0bbe6c23b5474687",
  "Ben Greenfield": "90b0a43f90f89a32",
  "Nick Norwitz": "d04510d762923977",
  "Lex Fridman": "76cb88bce8d5601e",
  "Ali Abdaal": "5872737e678bfc65",
  "Chris Williamson": "7499abccb0ac6254",
  "Steven Bartlett": "d1468d3a9902a441",
  "Mark Hyman": "c03723fa4f8d0a16",
  "David Sinclair": "fc5ce39ab0a4a623",
  "Casey Means": "7248e1394c92f55a",
  "Gabrielle Lyon": "3810fb0b74874b94",
  "Molly Maloof": "7eb95b8370d708bf",
  "Max Lugavere": "a0b13ab93bd09046",
  "Thomas DeLauer": "7a3c645db605a7ef",
  "Michael Lustgarten": "764c4fee3d3cf4a3",
  "Matt Kaeberlein": "cd80f8c386e7d757",
  "Eric Topol": "a33288f6c3a3e484",
  "Sahil Bloom": "5b7a30a3a6457ba2",
  "Dan Koe": "b5db973bb7c104af",
  "Justin Welsh": "ebdf32d4d67cb7b8",
  "Greg Isenberg": "dd1a526203fdf1fe",
  "Lenny Rachitsky": "b5d6d367be511c8d",
  "Gergely Orosz": "4f1e222cdd445fa8",
  "Ethan Mollick": "92db2b751402e7f7",
  "Allie K. Miller": "122bf1458146116c",
  "Rowan Cheung": "c859f0437a780aa9",
  "Matt Wolfe": "9bd2ac19e313b421",
  "Roberto Nickson": "5c1c1e4873818cfd",
  "Tina Huang": "c97f6411e974f999",
  "Pieter Levels": "2a5047c41ade580c",
  "Brett Adcock": "cd0f862fb5fc3094",
  "Andrew Wilkinson": "8cac2a39243299c3",
  "Naval Ravikant": "9ddf1e01d959def4",
  "Sam Parr": "2be5e2ad477bd394",
  "Codie Sanchez": "07bda83296ad43be",
  "Marques Brownlee": "ceefe41146c9aefc",
  "Khe Hy": "754e78c9cadc9979",
  "Thomas Frank": "df7ecb881efd0d2d",
  "Matt D'Avella": "0bbf025f0cced030",
  "Joey Schweitzer / Better Ideas": "ed289c2a0fcc45e6",
  "Nathaniel Drew": "74732a761f790f81",
  "Wes Roth": "934c2b9720294e60",
  "Ranveer Allahbadia": "8490ce582e612e06"
}""")

_CREATOR_PATTERNS = (
    re.compile(r'"creator_name"\s*:\s*"([^"]+)"'),
    re.compile(r'"name"\s*:\s*"([^"]+)"'),
    re.compile(r"Creator:\s*([^\n]+)"),
)


def normalize_oai_demo_creator_key(name: str) -> str:
    text = (name or "").strip().lower()
    text = re.sub(r"^dr\.?\s+", "", text)
    text = text.split(" / ", 1)[0].strip()
    return re.sub(r"\s+", " ", text)


_JULY_GP_HASH_BY_KEY = {
    normalize_oai_demo_creator_key(name): goal_hash
    for name, goal_hash in JULY_GP_GOAL_HASHES.items()
}


def extract_oai_demo_creator_name(goal: str) -> str | None:
    blob = goal or ""
    for pattern in _CREATOR_PATTERNS:
        match = pattern.search(blob)
        if match:
            name = match.group(1).strip().rstrip(".").strip()
            if name:
                return name
    return None


def july_gp_goal_hash_for_goal(goal: str) -> str | None:
    name = extract_oai_demo_creator_name(goal)
    if not name:
        return None
    return _JULY_GP_HASH_BY_KEY.get(normalize_oai_demo_creator_key(name))


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
