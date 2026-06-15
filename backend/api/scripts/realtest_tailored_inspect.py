"""Inspect tailored CV output for honesty + hygiene issues.

Checks the tailored markdown + writer extras for:

  • IDENTITY LEAK — name/email in CV header doesn't match contact_details
  • SECTOR-IN-SKILLS — Skills section contains a known sector/setting label
    (despite JD-extraction strip — would mean writer reintroduced it)
  • NOISE-IN-SKILLS — universal-noise phrase still in Skills
  • APPROVED-MISSED — feasibility approved a keyword but writer omitted it
  • FILTERED-NON-SKILL — writer's enforce.py stripped a kw the feasibility
    plan had approved (the 'mobile app usage' shape — possibly over-broad)
  • HONESTY-GUARD — non-empty notes from honesty_guard rewrites
  • DROPPED-ROLE — pre-filter removed a CV role
  • CV-SKILL-NOT-IN-SOURCE — Skills-section entry has no support in cv_text
  • COMPOUND-IN-SKILLS — boilerplate-shape compound in Skills section

Usage:
  cd backend/api
  ./.venv/bin/python scripts/realtest_tailored_inspect.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from app.services.skills.classifier import is_noise
from app.services.skills.post_process import (
    _CREDENTIAL_COMPONENT_LABELS,
    _SECTOR_SETTING_LABELS,
)

OUT_DIR = ROOT / "docs" / "realtest" / "tailored_loop"


_SKILLS_SECTION_RE = re.compile(
    r"(?ims)^##\s+skills\s*\n(.+?)(?=^##\s|\Z)",
)
_CONTACT_LINE_RE = re.compile(
    r"(?im)^#\s+(.+?)$\s+(.+?)$",
)


def _extract_skills_section(md: str) -> str:
    m = _SKILLS_SECTION_RE.search(md)
    return m.group(1) if m else ""


def _extract_header(md: str) -> tuple[str, str]:
    """Return (name, contact_line) from the H1 + line below."""
    m = re.search(r"(?m)^#\s+(.+?)$", md)
    if not m:
        return "", ""
    name = m.group(1).strip()
    rest_lines = md[m.end():].lstrip().splitlines()
    contact = rest_lines[0] if rest_lines else ""
    return name, contact


def _skill_items(skills_section: str) -> list[tuple[str, str]]:
    """Return [(category, kw), ...] from a Skills section."""
    out = []
    for line in skills_section.splitlines():
        m = re.match(r"^\s*(?:[-*•]\s+)?\*\*([^*]+?):\*\*\s*(.*)$", line)
        if not m:
            continue
        cat = m.group(1).strip()
        rest = m.group(2)
        for kw in re.split(r"\s*[,|]\s*", rest):
            kw = kw.strip().rstrip(".")
            if kw:
                out.append((cat, kw))
    return out


def inspect_one(data: dict, expected_contact: dict) -> list[str]:
    issues = []
    md = data.get("tailored_md") or ""
    extras = data.get("writer_extras") or {}

    name, contact_line = _extract_header(md)
    skills_md = _extract_skills_section(md)
    skill_items = _skill_items(skills_md)
    cv_text_lower = (data.get("jd_text") or "").lower()  # JD context for sanity
    # CV source text isn't saved in the harness output — would need the ledger
    # for full source verification. The header check still works on what we have.

    # 1. IDENTITY LEAK
    expected_email = (expected_contact.get("email") or "").lower()
    expected_phone = re.sub(r"\D", "", expected_contact.get("phone") or "")
    if expected_email and expected_email not in (md or "").lower():
        issues.append(f"[IDENTITY] Expected email '{expected_email}' missing from tailored CV")
    if name and expected_contact.get("first_name"):
        if expected_contact["first_name"].lower() not in name.lower():
            issues.append(f"[IDENTITY] CV header '{name}' lacks expected first name '{expected_contact['first_name']}'")

    # 2-3. SECTOR / NOISE in Skills
    for cat, kw in skill_items:
        kwl = kw.lower()
        if kwl in _SECTOR_SETTING_LABELS:
            issues.append(f"[SECTOR-IN-SKILLS] {cat}: '{kw}'")
        if kwl in _CREDENTIAL_COMPONENT_LABELS:
            issues.append(f"[CRED-IN-SKILLS] {cat}: '{kw}'")
        nt = is_noise(kw)
        if nt is not None:
            issues.append(f"[NOISE-IN-SKILLS] {cat}: '{kw}' (type={nt})")

    # 4. APPROVED-MISSED — keywords approved by feasibility plan that didn't land
    approved_missed = extras.get("approved_but_missed") or []
    for kw in approved_missed:
        issues.append(f"[APPROVED-MISSED] '{kw}'")

    # 5. FILTERED-NON-SKILL — writer's filter stripped an approved keyword
    filtered = extras.get("filtered_non_skill") or []
    for kw in filtered:
        # Only flag if the keyword does NOT look like a sector/credential
        kwl = (kw if isinstance(kw, str) else str(kw)).lower()
        if (kwl in _SECTOR_SETTING_LABELS or kwl in _CREDENTIAL_COMPONENT_LABELS
                or is_noise(kwl) is not None):
            continue  # legitimately filtered
        issues.append(f"[FILTERED-NON-SKILL] '{kw}' — writer filter may be over-broad")

    # 6. HONESTY-GUARD — non-empty notes indicate the guard rewrote something
    notes = extras.get("honesty_guard_notes") or []
    for note in notes:
        issues.append(f"[HONESTY-GUARD] {note}")

    # 7. DROPPED-ROLE — pre-filter removed a CV role
    dropped = extras.get("pre_filter_dropped_roles") or []
    for role in dropped:
        issues.append(f"[DROPPED-ROLE] {role}")

    # 8. honesty_risk flag
    risk = extras.get("honesty_risk") or {}
    if risk.get("flag"):
        issues.append(f"[HONESTY-RISK] {risk}")

    # 9. Feasibility-plan groundedness audit — every inject_directly entry
    # MUST have evidence whose word family matches the keyword AND be a
    # literal substring of the source CV (loaded by caller). This catches
    # any inject_directly that the new gate failed to downgrade.
    fp = (data.get("feasibility") or {}).get("feasibility_plan") or {}
    cv_text_full = _LEDGER_CACHE.get("cv_text") or ""
    if cv_text_full:
        for entry in fp.get("inject_directly") or []:
            kw = entry.get("keyword") or ""
            ev = entry.get("evidence") or ""
            if not _ev_grounds_kw(kw, ev, cv_text_full):
                issues.append(
                    f"[FEASIBILITY-UNGROUNDED] inject_directly '{kw}' "
                    f"— evidence does not contain keyword's word family"
                )

    return issues, name, contact_line, skill_items


_LEDGER_CACHE: dict = {}


def _load_ledger_once():
    if not _LEDGER_CACHE:
        ledger = json.load(open(ROOT / "docs" / "realtest" / "ledger.json"))
        _LEDGER_CACHE["cv_text"] = ledger.get("cv_text") or ""
        _LEDGER_CACHE["contact_details"] = ledger.get("contact_details") or {}
    return _LEDGER_CACHE


def _ev_grounds_kw(kw: str, ev: str, cv_text: str) -> bool:
    """Mirror of _evidence_grounds_keyword_verbatim in keyword_feasibility.py."""
    if not kw or not ev:
        return False
    cv_norm = re.sub(r"\s+", " ", cv_text).lower()
    ev_norm = re.sub(r"\s+", " ", ev).lower()
    if ev_norm not in cv_norm:
        head = " ".join(ev_norm.split()[:6])
        if head not in cv_norm:
            return False
    kw_t = [t for t in re.findall(r"[a-z][a-z\-]+", kw.lower()) if len(t) >= 4]
    ev_t = [t for t in re.findall(r"[a-z][a-z\-]+", ev.lower()) if len(t) >= 4]
    for kt in kw_t:
        for et in ev_t:
            short, long_ = (kt, et) if len(kt) <= len(et) else (et, kt)
            if long_.startswith(short[:4]):
                return True
    return False


def main():
    if not OUT_DIR.exists():
        print(f"No output dir: {OUT_DIR}")
        sys.exit(1)

    # expected contact from ledger
    _load_ledger_once()
    expected_contact = _LEDGER_CACHE["contact_details"]
    cv_first_line = (_LEDGER_CACHE["cv_text"]).splitlines()[0].strip()

    print(f"Expected: CV-source first line = '{cv_first_line}'")
    print(f"Expected: contact email = '{expected_contact.get('email')}'")
    print(f"Expected: phone = '{expected_contact.get('phone')}'")
    print()

    total_issues = 0
    by_class: dict = {}

    for fp in sorted(OUT_DIR.glob("*.json")):
        data = json.load(open(fp))
        print(f"\n==== {fp.stem[:8]} — {data.get('title','?')[:55]} @ {data.get('company','?')} ====")
        issues, name, contact_line, skill_items = inspect_one(data, expected_contact)
        print(f"  Header: name='{name}'  contact='{contact_line[:100]}'")
        print(f"  Skills section ({len(skill_items)} items):")
        for cat, kw in skill_items:
            print(f"    {cat}: {kw}")
        if not issues:
            print("  ✓ no issues")
        else:
            for i in issues:
                print(f"  {i}")
                total_issues += 1
                klass = i.split("]")[0].lstrip("[")
                by_class[klass] = by_class.get(klass, 0) + 1

    print(f"\n==== SUMMARY ====")
    print(f"Total issues: {total_issues}")
    for k, n in sorted(by_class.items(), key=lambda x: -x[1]):
        print(f"  {k}: {n}")


if __name__ == "__main__":
    main()
