"""Exit 0 when the running interpreter satisfies every line of a requirements file.

A venv built before a requirements bump still imports every package, so an
import probe cannot tell it is stale. Callers run this with the venv's own
python and reinstall when it exits non-zero.
"""

from __future__ import annotations

import sys
from importlib import metadata

try:
    from packaging.requirements import InvalidRequirement, Requirement
except ImportError:
    from pip._vendor.packaging.requirements import InvalidRequirement, Requirement


# Options that only say where packages come from; they name no distribution, and
# every requirement after them is still checked. Others (-e, -r, -c) stay unchecked.
_LOCATION_OPTIONS = ("--find-links", "-f", "--index-url", "-i", "--extra-index-url", "--no-index", "--trusted-host")


def _location_option(line: str) -> bool:
    option = line.split("=", 1)[0].split(None, 1)[0]
    return option in _LOCATION_OPTIONS


def unsatisfied(requirements_path: str) -> list[str]:
    problems: list[str] = []
    with open(requirements_path, encoding="utf-8") as handle:
        for raw in handle:
            line = raw.split(" #", 1)[0].strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("-") and _location_option(line):
                continue
            if line.startswith("-"):
                problems.append(f"{line}: pip option lines are not checked")
                continue
            try:
                requirement = Requirement(line)
            except InvalidRequirement as error:
                problems.append(f"{line}: {error}")
                continue
            if requirement.marker is not None and not requirement.marker.evaluate():
                continue
            try:
                installed = metadata.version(requirement.name)
            except metadata.PackageNotFoundError:
                problems.append(f"{requirement.name}: not installed")
                continue
            if requirement.url is None and not requirement.specifier.contains(
                installed, prereleases=True
            ):
                problems.append(
                    f"{requirement.name}: {installed} does not satisfy {requirement.specifier}"
                )
    return problems


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: agents_venv_satisfied.py <requirements.txt>", file=sys.stderr)
        return 2
    problems = unsatisfied(argv[1])
    for problem in problems:
        print(f"agents venv: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
