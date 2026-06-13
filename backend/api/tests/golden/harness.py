"""Golden-JD regression harness — shared library.

Provides the deterministic, AI-free machinery the Phase 4 harness uses to
evaluate the post-process pipeline against a hand-labelled corpus.

Two callers:

  • ``tests/test_golden_jd_mock.py`` — the in-suite pytest wrapper. Runs
    the full deterministic chain (verify_skill_evidence → recall floor →
    post_process_jd_analysis incl. subsumption) over RECORDED LLM-output
    fixtures and asserts precision/recall thresholds. No live AI calls.

  • ``scripts/golden_jd_eval.py`` — the on-demand CLI. Can run in mock
    mode (same fixtures, suitable for CI) or live mode (real AI call,
    BYOK key required). Writes a JSON report.

The corpus lives under ``tests/golden/jds/<id>.md`` — one Markdown file
per JD, with YAML frontmatter naming the vertical / role_family and the
hand-labelled ``expected`` skill set. Fixtures live under
``tests/golden/fixtures/<id>.json`` — the recorded raw-LLM jd_analysis
shape (pre-post-process) used for mock-mode evaluation.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.services.skills.post_process import (
    enrich_required_skills_from_jd_body,
    post_process_jd_analysis,
    verify_skill_evidence,
)


GOLDEN_DIR = Path(__file__).parent
JDS_DIR = GOLDEN_DIR / "jds"
FIXTURES_DIR = GOLDEN_DIR / "fixtures"

_CATEGORIES: Tuple[str, ...] = ("technical", "soft_skills", "domain_knowledge")


# ---------------------------------------------------------------------------
# Frontmatter parser (no PyYAML dep — minimal subset)
# ---------------------------------------------------------------------------
#
# The corpus uses a small, predictable subset:
#   ---
#   id: nursing-jesmond-ain-night
#   vertical: nursing
#   role_family: nursing
#   subtype: care
#   expected:
#     required:
#       domain_knowledge: [aged care, food handling, mobility support]
#       soft_skills: [reliability, teamwork, empathy]
#   ---
#
# Format support: scalar `key: value` and nested mappings with one bracketed
# list of strings per leaf. The parser is intentionally narrow: anything more
# expressive should be done with PyYAML, but adding a dep for a 4-file corpus
# isn't worth it.

_LIST_RE = re.compile(r"^\[(.*)\]$")


def _parse_frontmatter(text: str) -> Tuple[Dict[str, Any], str]:
    """Return ``(meta, body)``. Raises ValueError if frontmatter is missing
    or malformed."""
    if not text.startswith("---"):
        raise ValueError("missing frontmatter — file must start with '---'")
    parts = text.split("---", 2)
    if len(parts) < 3:
        raise ValueError("frontmatter must be closed with a second '---'")
    fm_text, body = parts[1], parts[2].lstrip("\n")

    meta: Dict[str, Any] = {}
    # Stack of (indent, container) — container is the dict at that depth.
    stack: List[Tuple[int, Dict[str, Any]]] = [(-1, meta)]

    for raw in fm_text.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        # Pop deeper frames
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if not stack:
            raise ValueError("unbalanced indentation in frontmatter")
        parent = stack[-1][1]
        line = raw.strip()
        if ":" not in line:
            raise ValueError(f"expected 'key: value' line, got: {line!r}")
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if not value:
            # New mapping container
            child: Dict[str, Any] = {}
            parent[key] = child
            stack.append((indent, child))
            continue
        m = _LIST_RE.match(value)
        if m:
            inner = m.group(1).strip()
            parent[key] = [s.strip() for s in inner.split(",") if s.strip()] if inner else []
        else:
            parent[key] = value
    return meta, body


# ---------------------------------------------------------------------------
# Corpus model
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class GoldenJd:
    id: str
    vertical: str
    role_family: str
    subtype: Optional[str]
    expected: Dict[str, Dict[str, List[str]]]
    body: str

    @property
    def expected_required(self) -> Dict[str, List[str]]:
        return (self.expected or {}).get("required") or {}


def load_corpus(jds_dir: Path = JDS_DIR) -> List[GoldenJd]:
    """Load every ``*.md`` file from ``jds_dir`` into a GoldenJd."""
    out: List[GoldenJd] = []
    for path in sorted(jds_dir.glob("*.md")):
        meta, body = _parse_frontmatter(path.read_text(encoding="utf-8"))
        out.append(GoldenJd(
            id=str(meta["id"]),
            vertical=str(meta["vertical"]),
            role_family=str(meta["role_family"]),
            subtype=meta.get("subtype"),
            expected=meta.get("expected") or {},
            body=body,
        ))
    return out


def load_fixture(jd_id: str, fixtures_dir: Path = FIXTURES_DIR) -> Dict[str, Any]:
    """Load the recorded raw-LLM jd_analysis fixture for one JD id."""
    path = fixtures_dir / f"{jd_id}.json"
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class EvalResult:
    jd_id: str
    vertical: str
    expected: Dict[str, List[str]]
    actual: Dict[str, List[str]]
    precision: float          # macro across the buckets in expected
    recall: float             # macro across the buckets in expected
    hallucinations: List[Tuple[str, str]]   # (bucket, skill) — actual ∖ expected
    missed: List[Tuple[str, str]]           # (bucket, skill) — expected ∖ actual


def _normalise_set(items: List[str]) -> set:
    return {(s or "").strip().lower() for s in items if isinstance(s, str) and s.strip()}


def evaluate(jd: GoldenJd, raw_jd_analysis: Dict[str, Any]) -> EvalResult:
    """Run the deterministic post-process chain on the recorded LLM output
    and compare against the JD's hand-labelled expected set.

    Precision = |actual ∩ expected| / |actual|, recall = |actual ∩ expected| /
    |expected|. Both are averaged macro across the categories that have any
    expected item — empty expected buckets are skipped (we don't gate on them
    because their ground truth is "none expected" and precision is trivially
    1.0).
    """
    # Make sure jd_text and role_family are wired correctly for the chain.
    jd_text = jd.body

    chained = verify_skill_evidence(
        raw_jd_analysis, jd_text, role_family_id=jd.role_family,
    )
    chained = enrich_required_skills_from_jd_body(
        chained, jd_text, role_family_id=jd.role_family,
    )
    chained = post_process_jd_analysis(chained, role_family_id=jd.role_family)

    actual_required = chained.get("required_skills") or {}

    expected_required = jd.expected_required
    precisions: List[float] = []
    recalls: List[float] = []
    hallucinations: List[Tuple[str, str]] = []
    missed: List[Tuple[str, str]] = []

    actual_for_report: Dict[str, List[str]] = {}

    for cat in _CATEGORIES:
        exp_set = _normalise_set(expected_required.get(cat) or [])
        act_set = _normalise_set(actual_required.get(cat) or [])
        actual_for_report[cat] = sorted(act_set)
        if not exp_set:
            continue
        tp = exp_set & act_set
        fp = act_set - exp_set
        fn = exp_set - act_set
        prec = (len(tp) / (len(tp) + len(fp))) if (tp or fp) else 1.0
        rec = (len(tp) / (len(tp) + len(fn))) if (tp or fn) else 1.0
        precisions.append(prec)
        recalls.append(rec)
        hallucinations.extend((cat, s) for s in sorted(fp))
        missed.extend((cat, s) for s in sorted(fn))

    precision = (sum(precisions) / len(precisions)) if precisions else 1.0
    recall = (sum(recalls) / len(recalls)) if recalls else 1.0

    return EvalResult(
        jd_id=jd.id,
        vertical=jd.vertical,
        expected={cat: sorted(_normalise_set(expected_required.get(cat) or [])) for cat in _CATEGORIES},
        actual=actual_for_report,
        precision=precision,
        recall=recall,
        hallucinations=hallucinations,
        missed=missed,
    )


def evaluate_all_mock() -> List[EvalResult]:
    """Run every corpus JD through the mock-mode evaluation. Used by both
    the pytest wrapper and the CLI when ``--mock`` is selected."""
    results: List[EvalResult] = []
    for jd in load_corpus():
        fixture = load_fixture(jd.id)
        results.append(evaluate(jd, fixture))
    return results
