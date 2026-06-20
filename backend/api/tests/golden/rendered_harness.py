"""Rendered-CV regression harness.

Runs the DETERMINISTIC post-processing chain (everything after the LLM
call in run_tailored_cv) on frozen raw-markdown fixtures and compares the
per-section output against committed snapshots.

Deterministic chain under test:
  _enforce_structure(markdown, jd_job_title, cv_text)
  _inject_missing_skills(markdown, feasibility)

The LLM call itself is frozen via the raw markdown fixture — we never call
the AI in this harness.

Usage:
  # Record / update snapshots (run once after changing fixtures or chain):
  cd backend/api
  python tests/golden/rendered_harness.py --record

  # Check all corpus JDs match their snapshots (same as the test):
  python tests/golden/rendered_harness.py
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

RENDERED_DIR = Path(__file__).parent / "rendered"
RAW_DIR = RENDERED_DIR / "raw"
FEASIBILITY_DIR = RENDERED_DIR / "feasibility"
SNAPSHOTS_DIR = RENDERED_DIR / "snapshots"

CORPUS_IDS: List[str] = [
    "nursing-residential-ain",
    "nursing-home-care-pcw",
    "tech-backend-engineer",
    "cleaning-commercial",
]

# ---------------------------------------------------------------------------
# Markdown section parser
# ---------------------------------------------------------------------------


def parse_sections(markdown: str) -> Dict[str, str]:
    """Split rendered markdown into {section_heading: content}.

    Everything before the first '## ' heading is stored under 'header'.
    """
    sections: Dict[str, str] = {}
    lines = markdown.split("\n")
    current_key = "header"
    current_lines: List[str] = []

    for line in lines:
        if line.startswith("## "):
            sections[current_key] = "\n".join(current_lines).strip()
            current_key = line[3:].strip()
            current_lines = []
        else:
            current_lines.append(line)

    sections[current_key] = "\n".join(current_lines).strip()
    return sections


# ---------------------------------------------------------------------------
# Fixture loaders
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RawFixture:
    jd_id: str
    markdown: str
    jd_job_title: str
    cv_text: str


def _parse_frontmatter(text: str) -> Tuple[Dict[str, str], str]:
    """Parse minimal key: value frontmatter and return (meta, body)."""
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    fm_text, body = parts[1], parts[2].lstrip("\n")
    meta: Dict[str, str] = {}
    for line in fm_text.splitlines():
        stripped = line.strip()
        if stripped and ":" in stripped and not stripped.startswith("#"):
            key, _, val = stripped.partition(":")
            meta[key.strip()] = val.strip()
    return meta, body


def load_raw(jd_id: str) -> RawFixture:
    path = RAW_DIR / f"{jd_id}.md"
    if not path.exists():
        raise FileNotFoundError(f"Raw fixture missing: {path}")
    text = path.read_text(encoding="utf-8")
    meta, body = _parse_frontmatter(text)
    return RawFixture(
        jd_id=jd_id,
        markdown=body,
        jd_job_title=meta.get("jd_job_title", ""),
        cv_text=meta.get("cv_text", ""),
    )


def load_feasibility(jd_id: str) -> Dict:
    path = FEASIBILITY_DIR / f"{jd_id}.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def load_snapshot(jd_id: str) -> Optional[Dict[str, str]]:
    path = SNAPSHOTS_DIR / f"{jd_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_snapshot(jd_id: str, sections: Dict[str, str]) -> None:
    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOTS_DIR / f"{jd_id}.json"
    path.write_text(json.dumps(sections, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------------------
# Deterministic chain runner
# ---------------------------------------------------------------------------


def run_deterministic_chain(jd_id: str) -> Dict[str, str]:
    """Load fixtures and run the deterministic render chain.

    Returns the rendered CV split into named sections.
    """
    from app.services.pipeline.steps.tailored_cv import (
        _enforce_structure,
        _inject_missing_skills,
    )

    raw = load_raw(jd_id)
    feasibility = load_feasibility(jd_id)

    md = _enforce_structure(
        raw.markdown,
        jd_job_title=raw.jd_job_title,
        cv_text=raw.cv_text,
    )
    md = _inject_missing_skills(md, feasibility)
    return parse_sections(md)


# ---------------------------------------------------------------------------
# Evaluate: run chain and diff against snapshot
# ---------------------------------------------------------------------------


@dataclass
class DiffResult:
    jd_id: str
    is_new: bool
    changed: List[Tuple[str, str, str]]  # (section, old, new)
    unchanged: List[str]


def evaluate(jd_id: str) -> DiffResult:
    sections = run_deterministic_chain(jd_id)
    snapshot = load_snapshot(jd_id)

    if snapshot is None:
        save_snapshot(jd_id, sections)
        return DiffResult(jd_id=jd_id, is_new=True, changed=[], unchanged=list(sections))

    changed: List[Tuple[str, str, str]] = []
    unchanged: List[str] = []
    all_keys = sorted(set(sections) | set(snapshot))
    for key in all_keys:
        actual = sections.get(key, "")
        expected = snapshot.get(key, "")
        if actual == expected:
            unchanged.append(key)
        else:
            changed.append((key, expected, actual))

    return DiffResult(jd_id=jd_id, is_new=False, changed=changed, unchanged=unchanged)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Bootstrap dummy env vars so app.config validates without real secrets.
    import os
    os.environ.setdefault("SUPABASE_URL", "http://localhost")
    os.environ.setdefault("SUPABASE_ANON_KEY", "test")
    os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
    os.environ.setdefault("SUPABASE_DB_URL", "postgresql+asyncpg://u:p@localhost/db")
    os.environ.setdefault("JOBTRACKR_HMAC_SECRET", "test-secret")

    record = "--record" in sys.argv

    if record:
        for jd_id in CORPUS_IDS:
            p = SNAPSHOTS_DIR / f"{jd_id}.json"
            if p.exists():
                p.unlink()
        print("Deleted existing snapshots — re-recording...\n")

    all_ok = True
    for jd_id in CORPUS_IDS:
        try:
            result = evaluate(jd_id)
            if result.is_new:
                print(f"[RECORDED] {jd_id} — {len(result.unchanged)} sections")
            elif result.changed:
                print(f"[CHANGED]  {jd_id} — {len(result.changed)} section(s) differ:")
                for sec, old, new in result.changed:
                    print(f"  ▸ {sec!r}")
                    old_preview = old[:120].replace("\n", "↵")
                    new_preview = new[:120].replace("\n", "↵")
                    print(f"    WAS: {old_preview!r}")
                    print(f"    NOW: {new_preview!r}")
                all_ok = False
            else:
                print(f"[OK]       {jd_id} — {len(result.unchanged)} sections unchanged")
        except Exception as exc:
            print(f"[ERROR]    {jd_id} — {exc}")
            all_ok = False

    sys.exit(0 if all_ok else 1)
