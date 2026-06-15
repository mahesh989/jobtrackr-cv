"""Inspect a round of extraction_loop outputs and surface issues.

Heuristics — each flags a CLASS of problem (one we have a fix for or one
we want to detect):

  • SECTOR LEAK — sector/setting label in a Skills bucket
  • CREDENTIAL LEAK — credential phrase / cert / unit code in Skills
  • CRED-COMPONENT — bare cert-fragment in Skills (individual support / ageing support)
  • COMPOUND — "X and Y" style 2-head compound in domain_knowledge
  • BOILERPLATE — known noise phrase still in Skills
  • SOFT-UNGROUNDED — soft skill whose token does not appear in jd_text
  • SOFT-INANIMATE — soft skill grounded only by "reliable {vehicle|car|...}"
  • DESIRABLE-REQ — JD says Desirable: but skill ended up in Required
  • DUP-CROSS — same canonical lowered in required AND preferred
  • EMPTY — required.domain_knowledge empty on a JD > 500 chars (recall miss)

Usage:
  ./.venv/bin/python scripts/realtest_inspect.py --round 1
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from app.services.skills.post_process import (
    _CREDENTIAL_COMPONENT_LABELS,
    _SECTOR_SETTING_LABELS,
)
from app.services.skills.classifier import is_noise

OUT_DIR = ROOT / "docs" / "realtest" / "extraction_loop"

# Common noise compounds we expect to be stripped.
COMPOUND_RE = re.compile(
    r"^[a-z][a-z\- ]+\s+(?:and|&)\s+[a-z][a-z\- ]+$"
)

INANIMATE_RE = re.compile(
    r"\breliab[a-z]*\s+(vehicle|car|transport|insurance|equipment|internet|broadband|wifi|service)\b",
    re.IGNORECASE,
)

DESIRABLE_HEADER_RE = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?\**\s*(desirable|preferred|nice\s+to\s+have|highly\s+desirable)\s*[:\-]?\s*\**\s*$",
)
INLINE_DESIRABLE_RE = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?(?:desirable|preferred|nice\s+to\s+have|highly\s+desirable)\s*[:\-]\s*(.+)$",
)


def _desirable_blob(jd_text: str) -> str:
    """Same logic as post_process._collect_section_bodies, scoped."""
    parts = []
    current = None
    for line in jd_text.splitlines():
        b = line.strip()
        if not b:
            continue
        m = INLINE_DESIRABLE_RE.match(b)
        if m:
            parts.append(m.group(1).lower())
            current = "d"
            continue
        if DESIRABLE_HEADER_RE.match(b):
            current = "d"
            continue
        # End of desirable section: blank or essential header
        if re.match(r"(?im)^\s*\**\s*(essential|required|must\s+have)", b):
            current = None
            continue
        if current == "d" and len(b) <= 200:
            parts.append(b.lower())
    return " | ".join(parts)


def _content_tokens(phrase):
    return [t for t in re.findall(r"[a-z][a-z\-]+", phrase.lower()) if len(t) > 3]


def inspect_one(data: dict, name: str) -> list[str]:
    issues = []
    ja = data.get("jd_analysis") or {}
    jd_text = data.get("jd_text", "")
    jd_lower = jd_text.lower()

    req = ja.get("required_skills") or {}
    pref = ja.get("preferred_skills") or {}
    desirable_blob = _desirable_blob(jd_text)

    all_in_skills_with_loc = []  # (side, cat, phrase)
    for side, block in (("required", req), ("preferred", pref)):
        for cat in ("technical", "soft_skills", "domain_knowledge"):
            for s in block.get(cat) or []:
                if isinstance(s, str):
                    all_in_skills_with_loc.append((side, cat, s))

    # SECTOR LEAK
    for side, cat, s in all_in_skills_with_loc:
        if s.lower() in _SECTOR_SETTING_LABELS:
            issues.append(f"[SECTOR LEAK]   {side}.{cat}: '{s}'")

    # CREDENTIAL COMPONENT
    for side, cat, s in all_in_skills_with_loc:
        if s.lower() in _CREDENTIAL_COMPONENT_LABELS:
            issues.append(f"[CRED-COMPONENT] {side}.{cat}: '{s}'")

    # CREDENTIAL LEAK — anything is_noise -> credential still in Skills.
    for side, cat, s in all_in_skills_with_loc:
        nt = is_noise(s)
        if nt is not None:
            issues.append(f"[NOISE LEAK]    {side}.{cat}: '{s}' (type={nt})")

    # COMPOUND ("X and Y") — 2-head domain_knowledge entry
    for side, cat, s in all_in_skills_with_loc:
        if cat == "domain_knowledge" and COMPOUND_RE.match(s.lower()):
            # Skip if the lexicon canonical IS the compound (e.g. "policies and procedures")
            issues.append(f"[COMPOUND]      {side}.{cat}: '{s}'")

    # SOFT-UNGROUNDED — soft skill whose content tokens don't appear in JD
    for side, cat, s in all_in_skills_with_loc:
        if cat != "soft_skills":
            continue
        toks = _content_tokens(s)
        if not toks:
            continue
        # Special: skill "compassion" might be grounded by "compassionate"
        grounded = False
        for t in toks:
            if t in jd_lower:
                grounded = True
                break
            # 5-char prefix match for adjective ↔ noun pairs
            if len(t) > 5 and re.search(r"\b" + re.escape(t[:5]), jd_lower):
                grounded = True
                break
        if not grounded:
            issues.append(f"[SOFT-UNGROUNDED] {side}.{cat}: '{s}' (no token in JD)")

    # SOFT-INANIMATE — JD says "reliable vehicle" and "reliability" is a soft skill
    if INANIMATE_RE.search(jd_lower):
        for side, cat, s in all_in_skills_with_loc:
            if cat == "soft_skills" and s.lower() in {"reliability", "flexibility"}:
                if "reliab" in s.lower() and not re.search(r"\breliab[a-z]*\s+(person|team|carer|worker|staff|member|shift|attendance|presence)\b", jd_lower):
                    issues.append(f"[SOFT-INANIMATE] {side}.{cat}: '{s}' (only inanimate anchor in JD)")

    # DESIRABLE-REQ — required item only mentioned in Desirable section
    if desirable_blob:
        for side, cat, s in all_in_skills_with_loc:
            if side != "required":
                continue
            toks = _content_tokens(s)
            if not toks:
                continue
            in_des = any(t in desirable_blob for t in toks)
            essential_lower = jd_lower.replace(desirable_blob, "")
            in_ess = any(t in essential_lower for t in toks)
            if in_des and not in_ess:
                issues.append(f"[DESIRABLE-REQ] {side}.{cat}: '{s}' (only in Desirable section)")

    # DUP-CROSS — same canonical in required AND preferred
    req_lower = {s.lower() for cat in ("technical", "soft_skills", "domain_knowledge")
                 for s in (req.get(cat) or []) if isinstance(s, str)}
    pref_lower = {s.lower() for cat in ("technical", "soft_skills", "domain_knowledge")
                  for s in (pref.get(cat) or []) if isinstance(s, str)}
    for dup in req_lower & pref_lower:
        issues.append(f"[DUP-CROSS]     '{dup}' in BOTH required and preferred")

    # EMPTY domain_knowledge
    if not (req.get("domain_knowledge") or []) and len(jd_text) > 500:
        issues.append(f"[EMPTY-DK]      required.domain_knowledge empty on a {len(jd_text)}-char JD")

    return issues


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", type=int, required=True)
    args = ap.parse_args()

    round_dir = OUT_DIR / f"round_{args.round}"
    if not round_dir.exists():
        print(f"No such round dir: {round_dir}")
        sys.exit(1)

    total_issues = 0
    by_class = {}
    for fp in sorted(round_dir.glob("*.json")):
        data = json.load(open(fp))
        title = data.get("title", "?")[:50]
        company = data.get("company", "?")
        issues = inspect_one(data, fp.stem)
        print(f"\n=== {fp.stem[:8]} — {title} @ {company} ===")
        ja = data.get("jd_analysis") or {}
        req = ja.get("required_skills") or {}
        pref = ja.get("preferred_skills") or {}
        for side, block in (("required", req), ("preferred", pref)):
            for cat in ("technical", "soft_skills", "domain_knowledge"):
                items = block.get(cat) or []
                if items:
                    print(f"  {side}.{cat}: {items}")
        if not issues:
            print("  ✓ no issues")
        else:
            for i in issues:
                print(f"  {i}")
                total_issues += 1
                klass = i.split("]")[0].lstrip("[")
                by_class[klass] = by_class.get(klass, 0) + 1

    print(f"\n=== SUMMARY round {args.round} ===")
    print(f"Total issues: {total_issues}")
    for k, n in sorted(by_class.items(), key=lambda x: -x[1]):
        print(f"  {k}: {n}")


if __name__ == "__main__":
    main()
