"""Read /tmp/audit_40/*.md and report on the 6 quality dimensions."""
import re, sys
from pathlib import Path

OUT = Path("/tmp/audit_40")
SHANTI_SRC = Path("/tmp/shanti_source.md").read_text()
RASHMI_SRC = Path("/tmp/rashmi_source.md").read_text()

# Known-truth dates for each candidate (verbatim from source)
SHANTI_TRUE = {
    "dimeo": None,  # no dates in source
    "akala": "Jan 2024 – May 2025",
    "rfbi": "Dec 2025 – Feb 2026",
    "bba":  "Completed 2021",
}
RASHMI_TRUE = {
    "uniting":   "Mar 2026 – Present",
    "jesmond":   "May 2025 – June 2026",
    "anglicare": "Sept 2024",
    "bsc":       "Sept 2019 – June 2022",
    "cert":      "May 2025",
}

ROLE_LINE_RE = re.compile(r"^\*([^|*\n]+)(?:\|\s*([^*\n]+?))?\s*\*\s*$", re.MULTILINE)
YEARS_CLAIM_RE = re.compile(r"\b\d+\+? *years?(?:'|’)? *experience\b", re.I)
PLACEHOLDER_RE = re.compile(r"\[Dates\]|Dates not specified", re.I)
SKILLS_LABEL_RE = re.compile(r"\*\*(Care Skills|Technical Skills|Clinical Skills|Cleaning Skills|Trade Skills):\*\*")

RETIREMENT_RE = re.compile(r"retirement village", re.I)
DOMESTIC_OFFICE_RE = re.compile(r"domestic assistance.{0,40}office cleaning|office cleaning.{0,40}domestic assistance", re.I)


def check(name: str, md: str, src: str, known_keys):
    facts = {"name": name}
    text_low = md.lower()
    src_low = src.lower()

    facts["placeholder_leak"] = bool(PLACEHOLDER_RE.search(md))
    facts["years_claim"] = bool(YEARS_CLAIM_RE.search(md))
    facts["retirement_misframe"] = bool(RETIREMENT_RE.search(md)) and "retirement village" not in src_low
    facts["domestic_office_hallucination"] = bool(DOMESTIC_OFFICE_RE.search(md))

    label = SKILLS_LABEL_RE.search(md)
    facts["skills_label"] = label.group(1) if label else "(none)"

    # Date fabrication: per role line, check the year tokens vs source
    fabricated_dates = []
    for m in ROLE_LINE_RE.finditer(md):
        role, dates = m.group(1).strip(), (m.group(2) or "").strip()
        if not dates: continue
        # Extract years from the date string
        years = re.findall(r"\b(19|20)\d{2}\b", dates)
        all_full = re.findall(r"\b(?:19|20)\d{2}\b", dates)
        if all_full and not all(y in src for y in all_full):
            fabricated_dates.append(f"{role}: {dates}")
    facts["fabricated_dates"] = fabricated_dates
    return facts


def main():
    files = sorted(OUT.glob("*.md"))
    print(f"Audit corpus: {len(files)} CVs\n")
    rows = []
    for f in files:
        name = f.stem
        cand = "shanti" if name.startswith("shanti") else "rashmi"
        src = SHANTI_SRC if cand == "shanti" else RASHMI_SRC
        keys = SHANTI_TRUE if cand == "shanti" else RASHMI_TRUE
        rows.append(check(name, f.read_text(), src, keys))

    by_cand = {"shanti": [], "rashmi": []}
    for r in rows:
        by_cand["shanti" if r["name"].startswith("shanti") else "rashmi"].append(r)

    for cand in ("shanti", "rashmi"):
        n = len(by_cand[cand])
        if n == 0: continue
        print(f"=== {cand.upper()} ({n} CVs) ===")
        ph   = sum(1 for r in by_cand[cand] if r["placeholder_leak"])
        yr   = sum(1 for r in by_cand[cand] if r["years_claim"])
        ret  = sum(1 for r in by_cand[cand] if r["retirement_misframe"])
        cat  = sum(1 for r in by_cand[cand] if r["domestic_office_hallucination"])
        labs = {}
        for r in by_cand[cand]:
            labs[r["skills_label"]] = labs.get(r["skills_label"], 0) + 1
        fab_cvs = [r for r in by_cand[cand] if r["fabricated_dates"]]
        print(f"  Placeholder [Dates] leaks:        {ph}/{n}")
        print(f"  Years-claim overclaim:            {yr}/{n}")
        print(f"  Retirement-village misframe:      {ret}/{n}")
        print(f"  Domestic+office categorical:      {cat}/{n}")
        print(f"  Skills labels: {labs}")
        print(f"  CVs with fabricated dates:        {len(fab_cvs)}/{n}")
        for r in fab_cvs[:5]:
            print(f"     - {r['name'][:32]}: {r['fabricated_dates']}")
        print()


if __name__ == "__main__":
    main()
