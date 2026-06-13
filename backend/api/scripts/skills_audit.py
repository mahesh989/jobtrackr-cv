"""
DB skills audit: extract Other Skills from all recent tailored CVs, classify each
item, and output a gap report. No API calls — purely DB read + classify().

Usage (from backend/api/):
    python3 scripts/skills_audit.py > /tmp/skills_audit.json
"""
import json, re, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

from supabase import create_client
from app.services.skills.classifier import classify, is_noise

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

_LABEL_RE = re.compile(r"^\s*(?:[-*•]\s+)?\*\*([^*]+?):\*\*\s*(.*)$")


def extract_skills(tailored_md: str) -> dict:
    """Parse ## Skills section from tailored CV markdown."""
    lines = tailored_md.split("\n")
    in_skills = False
    result = {}
    for line in lines:
        s = line.strip()
        if s.lower() == "## skills":
            in_skills = True
            continue
        if in_skills and s.startswith("## "):
            break
        if in_skills:
            m = _LABEL_RE.match(line)
            if m:
                label = m.group(1).strip()
                items_raw = m.group(2).strip()
                items = [x.strip() for x in items_raw.split(",") if x.strip()]
                result[label] = items
    return result


def classify_items(items: list, vertical: str) -> list:
    results = []
    for item in items:
        c = classify(item, vertical)
        n = is_noise(item)
        results.append({
            "item": item,
            "lex_category": c.category if c and c.is_skill else None,
            "lex_canonical": c.canonical if c and c.is_skill else None,
            "is_noise": n,
            "action": (
                "add_to_lexicon" if not c and not n else
                "should_be_care_skills" if c and c.category == "domain_knowledge" else
                "should_be_stripped" if n else
                "correct_technical"
            ),
        })
    return results


def main():
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Fetch recent non-stale runs with a tailored CV
    rows = (
        sb.table("analysis_runs")
        .select("id, job_id, tailored_cv_storage_path, jd_analysis_result, created_at")
        .not_.is_("tailored_cv_storage_path", "null")
        .eq("is_stale", False)
        .order("created_at", desc=True)
        .limit(200)
        .execute()
        .data
    )

    # Also fetch job titles + companies for display
    job_ids = list({r["job_id"] for r in rows if r.get("job_id")})
    jobs_raw = (
        sb.table("jobs")
        .select("id, title, company")
        .in_("id", job_ids)
        .execute()
        .data
    )
    job_map = {j["id"]: j for j in jobs_raw}

    report = []
    seen_jobs = set()

    for row in rows:
        jid = row.get("job_id")
        if jid in seen_jobs:
            continue  # one run per job (most recent)
        seen_jobs.add(jid)

        storage_path = row.get("tailored_cv_storage_path") or ""
        try:
            tailored = sb.storage.from_("tailored-cvs").download(storage_path).decode("utf-8")
        except Exception:
            tailored = ""
        jd_analysis = row.get("jd_analysis_result") or {}
        vertical = jd_analysis.get("role_family") or "master"
        # Map role_family id to lexicon vertical
        vert_map = {"nursing": "nursing", "tech": "tech", "manual": "cleaning"}
        lex_vertical = vert_map.get(vertical)

        skills = extract_skills(tailored)
        job = job_map.get(jid, {})

        # Classify Other Skills items (the primary focus)
        other_label = next((k for k in skills if "other" in k.lower() or "technical" in k.lower()), None)
        other_items = skills.get(other_label, []) if other_label else []

        other_classified = classify_items(other_items, lex_vertical) if lex_vertical else []

        # Summarise: which items need action
        needs_lexicon = [x for x in other_classified if x["action"] == "add_to_lexicon"]
        should_be_care = [x for x in other_classified if x["action"] == "should_be_care_skills"]
        should_strip = [x for x in other_classified if x["action"] == "should_be_stripped"]

        if needs_lexicon or should_be_care or should_strip:
            report.append({
                "job_id": jid,
                "job_title": job.get("title", ""),
                "company": job.get("company", ""),
                "role_family": vertical,
                "lex_vertical": lex_vertical,
                "other_skills_raw": other_items,
                "needs_lexicon": [x["item"] for x in needs_lexicon],
                "should_be_care_skills": [x["item"] for x in should_be_care],
                "should_be_stripped": [x["item"] for x in should_strip],
                "classified": other_classified,
            })

    # Summary stats
    all_needs_lexicon = {}
    for r in report:
        for item in r["needs_lexicon"]:
            all_needs_lexicon[item.lower()] = all_needs_lexicon.get(item.lower(), 0) + 1

    print(json.dumps({
        "summary": {
            "runs_analysed": len(rows),
            "unique_jobs": len(seen_jobs),
            "jobs_with_other_skills_issues": len(report),
            "lexicon_gaps_by_frequency": sorted(all_needs_lexicon.items(), key=lambda x: -x[1]),
        },
        "jobs": report,
    }, indent=2))


if __name__ == "__main__":
    main()
