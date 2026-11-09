#!/usr/bin/env python3
"""Read, search, validate, and extend the checked-in RCA case archive.

The archive lives in `docs/rca/cases/*.md`. Every completed `/RCA` writes one
case file: problem, diagnosis, solution, human feedback. `/RCA` searches the
archive BEFORE forming a hypothesis so a bug we have already root-caused is
recognized in seconds instead of re-diagnosed from scratch.

Commands
--------
  search <terms...>   Rank cases against free-text terms (symptoms, tags, body).
  show <id>           Print one case in full.
  list                One line per case (id, date, class, title).
  validate            Enforce the case schema; refuse a committed INDEX.md. Exit 1 on drift.
  reindex             Write the local, git-ignored docs/rca/INDEX.md from the case files.
  new <slug>          Scaffold a new case file from the template.
  stats               Aggregate counts by classification / problem class / surface.

Frontmatter schema (all keys required unless marked optional):
  id, date, title, surface, component, classification, problem_class,
  first_bad_boundary, symptoms[], tags[], sources[], repro, status
  superseded_by (optional)
"""

from __future__ import annotations

import argparse
import math
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ARCHIVE_DIR = REPO_ROOT / "docs" / "rca"
CASES_DIR = ARCHIVE_DIR / "cases"
INDEX_PATH = ARCHIVE_DIR / "INDEX.md"

SCALAR_KEYS = (
    "id",
    "date",
    "title",
    "surface",
    "component",
    "classification",
    "problem_class",
    "first_bad_boundary",
    "repro",
    "status",
)
LIST_KEYS = ("symptoms", "tags", "sources")
OPTIONAL_KEYS = ("superseded_by",)

REQUIRED_SECTIONS = (
    "Problem",
    "Diagnosis",
    "Solution",
    "Human feedback",
    "Reusable lesson",
)

# Step 4 (Classify) of .claude/commands/rca.md.
CLASSIFICATIONS = {
    "undetermined",
    "our-bug",
    "third-party-failure",
    "input-error",
    "configuration-error",
    "test-bug",
    "model-intelligence-limitation",
    "unresolved",
}

# Problem buckets from .claude/commands/rca.md (Hypothesis), plus `other`.
PROBLEM_CLASSES = {
    "timeout-too-aggressive",
    "logical-inconsistency-in-harness-contracts",
    "uncaptured-user-preference",
    "new-tool-or-capability-required",
    "concurrency-inefficiency",
    "fixture-environment-data-mismatch",
    "observability-trace-capture-gap",
    "model-intelligence-limitation",
    "other",
}

STATUSES = {"fixed", "open", "mitigated", "wontfix", "superseded"}
SURFACES = {"back-end", "front-end", "agents", "mac-app", "infra", "harness", "cross"}
SOURCE_PREFIXES = (
    "PR #",
    "commit ",
    "memory:",
    "plan:",
    "agent ",
    "fleet run ",
    "hub run ",
    "benchmark run ",
    "task ",
)
TAG_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]*")

STOPWORDS = {
    "the", "a", "an", "is", "are", "was", "were", "of", "to", "in", "on", "for",
    "and", "or", "but", "it", "its", "we", "our", "that", "this", "with", "at",
    "by", "from", "as", "be", "been", "not", "no", "has", "have", "had", "why",
    "when", "what", "how", "does", "did", "do", "i", "you", "if", "then",
}

TEMPLATE = """---
id: {id}
date: {date}
title: TODO one-line title — what broke, at which boundary
surface: TODO back-end | front-end | agents | mac-app | infra | harness | cross
component: TODO narrowest owning module (e.g. prisma-migrations, rose-client)
classification: TODO {classifications}
problem_class: TODO {problem_classes}
first_bad_boundary: TODO file/function where data first went wrong
symptoms:
  - TODO the exact string a future engineer would grep for
tags:
  - TODO
sources:
  - TODO PR #N | commit <sha> | agent <id>
repro: TODO path to the checked-in test that fails pre-fix and passes post-fix
status: open
---

## Problem

TODO observed wrong behavior, with the runtime evidence that proved it.

## Diagnosis

TODO the causal chain to the first-bad boundary, and the deepest owned cause
(Step 5a ladder). Cite the log line / query / span that proves each rung.

## Solution

TODO the generalizable fix and where it landed. Note what sibling failures it
also prevents, and the 10k-agent behavior of the change.

## Human feedback

TODO what the human corrected, rejected, or insisted on during this RCA. Write
"None recorded." if there was none. Never invent feedback.

## Reusable lesson

TODO the one-sentence rule a future RCA should apply on seeing these symptoms.
"""


@dataclass
class Case:
    path: Path
    meta: dict = field(default_factory=dict)
    body: str = ""
    sections: dict = field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.meta.get("id", self.path.stem)

    def haystack(self) -> str:
        parts = [self.path.stem, self.body]
        for key in SCALAR_KEYS:
            parts.append(str(self.meta.get(key, "")))
        for key in LIST_KEYS:
            parts.extend(str(v) for v in self.meta.get(key, []))
        return "\n".join(parts).lower()


def parse_frontmatter(text: str, path: Path) -> tuple[dict, str]:
    """Parse the constrained frontmatter dialect used by case files.

    Supports `key: scalar` and `key:` followed by `  - item` lines. Deliberately
    dependency-free so the archive stays readable by any runtime (python, node
    structural tests, plain grep).
    """
    if not text.startswith("---\n"):
        raise ValueError(f"{path}: missing opening `---` frontmatter fence")
    end = text.find("\n---\n", 3)
    if end == -1:
        raise ValueError(f"{path}: missing closing `---` frontmatter fence")
    raw = text[4:end]
    body = text[end + 5 :]

    meta: dict = {}
    current_list: str | None = None
    for lineno, line in enumerate(raw.split("\n"), start=2):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith(("  - ", "- ")):
            if current_list is None:
                raise ValueError(f"{path}:{lineno}: list item outside of a list key")
            meta[current_list].append(line.split("- ", 1)[1].strip())
            continue
        match = re.match(r"^([a-z_]+):\s*(.*)$", line)
        if not match:
            raise ValueError(f"{path}:{lineno}: unparseable frontmatter line: {line!r}")
        key, value = match.group(1), match.group(2).strip()
        if value == "":
            meta[key] = []
            current_list = key
        else:
            meta[key] = value
            current_list = None
    return meta, body


def split_sections(body: str) -> dict:
    sections: dict = {}
    current = None
    buf: list[str] = []
    for line in body.split("\n"):
        heading = re.match(r"^##\s+(.*?)\s*$", line)
        if heading:
            if current is not None:
                sections[current] = "\n".join(buf).strip()
            current = heading.group(1)
            buf = []
        elif current is not None:
            buf.append(line)
    if current is not None:
        sections[current] = "\n".join(buf).strip()
    return sections


def load_cases(strict: bool = False) -> list[Case]:
    cases: list[Case] = []
    if not CASES_DIR.exists():
        return cases
    for path in sorted(CASES_DIR.glob("*.md")):
        text = path.read_text(encoding="utf-8")
        try:
            meta, body = parse_frontmatter(text, path)
        except ValueError:
            if strict:
                raise
            continue
        cases.append(Case(path=path, meta=meta, body=body, sections=split_sections(body)))
    return cases


def validate() -> list[str]:
    errors: list[str] = []
    if not CASES_DIR.exists():
        return [f"missing archive directory: {CASES_DIR.relative_to(REPO_ROOT)}"]

    seen_ids: dict[str, Path] = {}
    for path in sorted(CASES_DIR.glob("*.md")):
        rel = path.relative_to(REPO_ROOT)
        text = path.read_text(encoding="utf-8")
        try:
            meta, body = parse_frontmatter(text, path)
        except ValueError as exc:
            errors.append(str(exc))
            continue

        for key in SCALAR_KEYS:
            value = meta.get(key)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"{rel}: frontmatter `{key}` is missing or not a scalar")
        for key in LIST_KEYS:
            value = meta.get(key)
            if not isinstance(value, list) or not value:
                errors.append(f"{rel}: frontmatter `{key}` must be a non-empty list")

        unknown = set(meta) - set(SCALAR_KEYS) - set(LIST_KEYS) - set(OPTIONAL_KEYS)
        if unknown:
            errors.append(f"{rel}: unknown frontmatter keys: {sorted(unknown)}")

        case_id = meta.get("id")
        if isinstance(case_id, str):
            if case_id != path.stem:
                errors.append(f"{rel}: `id` ({case_id}) must equal the filename stem")
            if case_id in seen_ids:
                errors.append(f"{rel}: duplicate id, also in {seen_ids[case_id]}")
            seen_ids[case_id] = rel

        date = meta.get("date")
        if isinstance(date, str) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
            errors.append(f"{rel}: `date` must be YYYY-MM-DD, got {date!r}")
        if (
            isinstance(case_id, str)
            and isinstance(date, str)
            and not case_id.startswith(f"{date}-")
        ):
            errors.append(f"{rel}: `id` must start with its `date` ({date})")

        surface = meta.get("surface")
        if isinstance(surface, str) and surface not in SURFACES:
            errors.append(f"{rel}: `surface` {surface!r} not in {sorted(SURFACES)}")
        classification = meta.get("classification")
        if isinstance(classification, str) and classification not in CLASSIFICATIONS:
            errors.append(
                f"{rel}: `classification` {classification!r} not in {sorted(CLASSIFICATIONS)}"
            )
        problem_class = meta.get("problem_class")
        if isinstance(problem_class, str) and problem_class not in PROBLEM_CLASSES:
            errors.append(
                f"{rel}: `problem_class` {problem_class!r} not in {sorted(PROBLEM_CLASSES)}"
            )
        status = meta.get("status")
        if isinstance(status, str) and status not in STATUSES:
            errors.append(f"{rel}: `status` {status!r} not in {sorted(STATUSES)}")
        if classification == "undetermined" and status != "open":
            errors.append(
                f"{rel}: `classification` 'undetermined' requires `status` 'open'"
            )
        if classification == "unresolved" and status != "open":
            errors.append(f"{rel}: `unresolved` classification requires `status: open`")

        symptoms = meta.get("symptoms")
        if isinstance(symptoms, list) and not 2 <= len(symptoms) <= 5:
            errors.append(f"{rel}: `symptoms` must contain 2–5 literal search strings")
        tags = meta.get("tags")
        if isinstance(tags, list):
            for tag in tags:
                if not isinstance(tag, str) or not TAG_PATTERN.fullmatch(tag):
                    errors.append(
                        f"{rel}: tag {tag!r} must be lowercase kebab-case"
                    )
        sources = meta.get("sources")
        if isinstance(sources, list):
            for source in sources:
                if not isinstance(source, str) or not source.startswith(SOURCE_PREFIXES):
                    errors.append(
                        f"{rel}: source {source!r} must use a documented provenance prefix"
                    )

        sections = split_sections(body)
        for name in REQUIRED_SECTIONS:
            if name not in sections:
                errors.append(f"{rel}: missing required `## {name}` section")
            elif not sections[name].strip():
                errors.append(f"{rel}: `## {name}` section is empty")
        if "TODO" in text:
            errors.append(f"{rel}: contains an unfilled TODO placeholder")

    render_index(load_cases())  # the index must still render from the cases
    if index_is_tracked():
        errors.append(
            "docs/rca/INDEX.md is committed. It is generated locally and git-ignored: every PR "
            "that added a case rewrote it, so concurrent PRs conflicted on GitHub and forced a "
            "sync plus a full gate rerun. Run `git rm --cached docs/rca/INDEX.md`."
        )
    return errors


def index_is_tracked() -> bool:
    """Whether INDEX_PATH is in the git index of the repository that holds it.

    The index is derived from `cases/`, so committing it adds a shared line that
    every case-adding PR rewrites (its case count and newest-first entries). Only
    distinct case files may be committed; outside a git repository nothing is
    tracked."""
    try:
        result = subprocess.run(
            ["git", "-C", str(INDEX_PATH.parent), "ls-files", "--error-unmatch", "--", INDEX_PATH.name],
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def render_index(cases: list[Case]) -> str:
    lines = [
        "# RCA case index",
        "",
        "Generated locally by `python3 scripts/rca_archive.py reindex` (git-ignored) — do not hand-edit.",
        "",
        f"{len(cases)} cases. Search with `python3 scripts/rca_archive.py search \"<symptom terms>\"`.",
        "",
    ]
    for case in sorted(cases, key=lambda c: (c.meta.get("date", ""), c.id), reverse=True):
        lines.extend(
            [
                f"- [{case.id}](cases/{case.path.name})",
                f"  - `{case.meta.get('date','')}` · "
                f"`{case.meta.get('classification','')}` · "
                f"`{case.meta.get('problem_class','')}`",
                f"  - {case.meta.get('title','')}",
            ]
        )
    lines.append("")
    return "\n".join(lines)


def tokenize(text: str) -> list[str]:
    # Single characters ("0" from "0%", "s" from "5s") match indiscriminately and
    # only add noise, so drop them along with stopwords.
    return [
        t
        for t in re.split(r"[^a-z0-9_./-]+", text.lower())
        if len(t) > 1 and t not in STOPWORDS
    ]


def search(terms: list[str], limit: int) -> int:
    raw_query = " ".join(terms).strip().lower()
    query = list(dict.fromkeys(tokenize(raw_query)))
    if not query:
        print("no searchable terms after stopword removal", file=sys.stderr)
        return 2
    cases = load_cases()
    haystacks = {case.id: case.haystack() for case in cases}
    haystack_tokens = {case_id: set(tokenize(hay)) for case_id, hay in haystacks.items()}

    # Inverse document frequency: a term present in nearly every case ("agent",
    # "prod", "fix") carries almost no signal, so weight it down instead of
    # letting it drag in the whole archive as false positives.
    total = max(len(cases), 1)
    idf: dict[str, float] = {}
    for term in set(query):
        df = sum(1 for tokens in haystack_tokens.values() if term in tokens)
        idf[term] = math.log((total + 1) / (df + 1)) + 0.05

    scored: list[tuple[float, Case, list[str]]] = []
    for case in cases:
        hay = haystacks[case.id]
        hay_tokens = haystack_tokens[case.id]
        tags = {str(t).lower() for t in case.meta.get("tags", [])}
        symptoms = " ".join(str(s) for s in case.meta.get("symptoms", [])).lower()
        symptom_tokens = set(tokenize(symptoms))
        title = str(case.meta.get("title", "")).lower()
        title_tokens = set(tokenize(title))
        score = 0.0
        matched: list[str] = []
        for term in query:
            weight = 0.0
            if term in tags:
                weight += 4.0
            if term in title_tokens:
                weight += 3.0
            if term in symptom_tokens:
                weight += 3.0
            if term in hay_tokens:
                weight += 1.0
            if weight:
                score += weight * idf[term]
                matched.append(term)
        if len(query) > 1:
            if raw_query in title:
                score += 12.0
            elif raw_query in symptoms:
                score += 9.0
            elif raw_query in hay:
                score += 3.0
        if score:
            scored.append((score, case, matched))
    scored.sort(key=lambda row: (-row[0], row[1].meta.get("date", "")))

    # Drop the long tail of cases that only matched on weak, common terms. They
    # are noise, and noise trains agents to skip the search step.
    if scored:
        cutoff = max(scored[0][0] * 0.15, 1.0)
        scored = [row for row in scored if row[0] >= cutoff]

    if not scored:
        print("No prior RCA cases matched. This looks novel — diagnose from evidence,")
        print("then write the case with `python3 scripts/rca_archive.py new <slug>`.")
        return 0

    print(f"{len(scored)} matching case(s) of {len(cases)}; showing top {min(limit, len(scored))}.\n")
    for score, case, matched in scored[:limit]:
        print(f"[{score:.0f}] {case.id}  ({case.meta.get('date','')})")
        print(f"      {case.meta.get('title','')}")
        print(
            f"      class={case.meta.get('classification','')} "
            f"problem={case.meta.get('problem_class','')} "
            f"boundary={case.meta.get('first_bad_boundary','')}"
        )
        lesson = case.sections.get("Reusable lesson", "").split("\n")[0]
        if lesson:
            print(f"      lesson: {lesson}")
        print(f"      matched: {', '.join(sorted(set(matched)))}")
        print(f"      read: docs/rca/cases/{case.path.name}")
        print()
    return 0


def show(case_id: str) -> int:
    for case in load_cases():
        if case.id == case_id or case.path.stem == case_id:
            print(case.path.read_text(encoding="utf-8"))
            return 0
    print(f"no case with id {case_id!r}", file=sys.stderr)
    return 1


def list_cases() -> int:
    cases = load_cases()
    for case in sorted(cases, key=lambda c: c.meta.get("date", ""), reverse=True):
        print(
            f"{case.meta.get('date','')}  {case.meta.get('classification',''):<28} "
            f"{case.id}  {case.meta.get('title','')}"
        )
    print(f"\n{len(cases)} cases in docs/rca/cases/")
    return 0


def stats() -> int:
    cases = load_cases()
    for key in ("classification", "problem_class", "surface", "status"):
        counts: dict[str, int] = {}
        for case in cases:
            counts[str(case.meta.get(key, "?"))] = counts.get(str(case.meta.get(key, "?")), 0) + 1
        print(f"\n{key}:")
        for name, count in sorted(counts.items(), key=lambda kv: -kv[1]):
            print(f"  {count:4d}  {name}")
    tag_counts: dict[str, int] = {}
    for case in cases:
        for tag in case.meta.get("tags", []):
            tag_counts[str(tag)] = tag_counts.get(str(tag), 0) + 1
    print("\ntop tags:")
    for name, count in sorted(tag_counts.items(), key=lambda kv: -kv[1])[:25]:
        print(f"  {count:4d}  {name}")
    print(f"\n{len(cases)} cases total")
    return 0


def today() -> str:
    override = os.environ.get("RCA_ARCHIVE_DATE")
    if override:
        return override
    out = subprocess.run(["date", "+%Y-%m-%d"], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def new_case(slug: str) -> int:
    slug = re.sub(r"[^a-z0-9-]+", "-", slug.lower()).strip("-")
    if not slug:
        print("slug must contain at least one alphanumeric character", file=sys.stderr)
        return 2
    date = today()
    case_id = f"{date}-{slug}"
    path = CASES_DIR / f"{case_id}.md"
    if path.exists():
        print(f"{path.relative_to(REPO_ROOT)} already exists", file=sys.stderr)
        return 1
    CASES_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(
        TEMPLATE.format(
            id=case_id,
            date=date,
            classifications=" | ".join(sorted(CLASSIFICATIONS)),
            problem_classes=" | ".join(sorted(PROBLEM_CLASSES)),
        ),
        encoding="utf-8",
    )
    print(path.relative_to(REPO_ROOT))
    print("Fill every TODO, then run `python3 scripts/rca_archive.py reindex`.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_search = sub.add_parser("search", help="rank prior cases against free-text terms")
    p_search.add_argument("terms", nargs="+")
    p_search.add_argument("--limit", type=int, default=8)

    p_show = sub.add_parser("show", help="print one case in full")
    p_show.add_argument("id")

    sub.add_parser("list", help="one line per case")
    sub.add_parser("validate", help="enforce schema; refuse a committed INDEX.md")
    sub.add_parser("reindex", help="write the local, git-ignored docs/rca/INDEX.md")
    sub.add_parser("stats", help="aggregate counts")

    p_new = sub.add_parser("new", help="scaffold a new case file")
    p_new.add_argument("slug")

    def do_reindex(args: argparse.Namespace) -> int:
        INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
        INDEX_PATH.write_text(render_index(load_cases()), encoding="utf-8")
        print(f"wrote {INDEX_PATH.relative_to(REPO_ROOT)}")
        return 0

    def do_validate(args: argparse.Namespace) -> int:
        errors = validate()
        if errors:
            for error in errors:
                print(f"ERROR {error}", file=sys.stderr)
            print(f"\n{len(errors)} archive error(s)", file=sys.stderr)
            return 1
        print(f"RCA archive OK ({len(load_cases())} cases)")
        return 0

    # Keyed by subcommand so "registered but never dispatched" is impossible.
    # The if-chain this replaced silently omitted `new`, so it exited 2 with no
    # output while still passing a structural test that only greps the docs.
    dispatch = {
        "search": lambda args: search(args.terms, args.limit),
        "show": lambda args: show(args.id),
        "list": lambda args: list_cases(),
        "stats": lambda args: stats(),
        "new": lambda args: new_case(args.slug),
        "reindex": do_reindex,
        "validate": do_validate,
    }
    undispatched = set(sub.choices) - set(dispatch)
    if undispatched:
        raise AssertionError(f"subcommands registered but not dispatched: {sorted(undispatched)}")

    args = parser.parse_args()
    return dispatch[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
