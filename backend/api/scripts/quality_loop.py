"""Quality-loop runner: take 1 CV + N JDs, run the real pipeline against
each, aggregate findings, surface issues across summary / jd-skill-extraction
/ skills-injection / education. Same code path as the UI's analyze flow.

Usage:
    python scripts/quality_loop.py --iteration 1
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

# Load both .env files. .env has Supabase creds; .env.realtest has the
# OpenAI key (kept separate so it's only used when explicitly opted in).
HERE = Path(__file__).resolve().parent.parent
def _load_env(path: Path) -> None:
    if not path.exists(): return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
_load_env(HERE / ".env")
_load_env(HERE / ".env.realtest")
sys.path.insert(0, str(HERE))

from app.services.pipeline.orchestrator import run_analysis_pipeline   # noqa: E402
from app.schemas.internal import AnalyzeRequest                         # noqa: E402
from supabase import create_client                                       # noqa: E402

# ── Fixture: CV + 5 JDs ──────────────────────────────────────────────────────
CV_VERSION_ID  = "41cfe764-f9ed-4dfe-bc38-f767bf7674b8"   # SHANTI GIRI AIN CV
USER_EMAIL     = "maheshtwari99@gmail.com"
JD_IDS = [
    ("512a376f-e980-405e-b4d4-217ebe112b2f", "Anglicare Sydney — Care Worker (home care)"),
    ("fd183c2a-5a0c-4f8e-be72-df49b09dada0", "Bolton Clarke — Personal Care Worker Casual"),
    ("2e279fa3-ed48-49f9-a1f0-f1bab3cfdc49", "Australian Unity — Home Care Strathfield"),
    ("af7cfb00-5f8b-4163-a67f-3a7fcfb202e0", "Allied Health Students — AIN/Disability"),
    ("0b7679e1-925d-40dd-84e9-58700df226f7", "Multicultural Care — Home & Community Aged Care"),
]

OUT = HERE / "scripts" / "_quality_runs"
OUT.mkdir(parents=True, exist_ok=True)


def sb():
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])


def resolve_full_ids(client) -> tuple[str, str, list[tuple[str, dict]], str]:
    """Load user + CV + JD rows."""
    user = client.table("users").select("id,email").eq("email", USER_EMAIL).execute().data[0]
    cv = client.table("cv_versions").select("id,cv_text,categorised_skills").eq("id", CV_VERSION_ID).execute().data[0]
    jobs = []
    for jid, _hint in JD_IDS:
        rows = client.table("jobs").select("id,title,company,location,description,manual_jd_text").eq("id", jid).execute().data
        if rows:
            j = rows[0]
            jd_text = (j.get("manual_jd_text") or j.get("description") or "").strip()
            jobs.append((j["id"], {"title": j.get("title"), "company": j.get("company"),
                                    "location": j.get("location"), "jd_text": jd_text}))
    return user["id"], cv["id"], jobs, cv["cv_text"]


async def run_one(client, user_id: str, cv_id: str, job_id: str, jd_text: str, jd_meta: dict) -> dict:
    """Pre-create analysis_runs row → call orchestrator → read back results."""
    run_id = str(uuid.uuid4())
    client.table("analysis_runs").insert({
        "id":            run_id,
        "user_id":       user_id,
        "job_id":        job_id,
        "cv_version_id": cv_id,
        "jd_text":       jd_text,
        "status":        "pending",
        "ai_provider":   "openai",
        "ai_model":      "gpt-4o",         # cheap + sturdy for quality testing
        "is_stale":      True,             # mark stale so it doesn't pollute the UI
    }).execute()

    # Fetch CV text fresh
    cv = client.table("cv_versions").select("cv_text").eq("id", cv_id).execute().data[0]
    cv_text = cv["cv_text"]

    payload = AnalyzeRequest(
        run_id=uuid.UUID(run_id),
        user_id=uuid.UUID(user_id),
        cv_version_id=uuid.UUID(cv_id),
        jd_text=jd_text,
        jd_meta=jd_meta,
        cv_text=cv_text,
        ai_provider="openai",
        ai_api_key=os.environ["OPENAI_API_KEY"],
        ai_model="gpt-4o",
        contact_details=None,
        min_initial_ats=0,    # always run end-to-end for this loop
        min_final_ats=0,
    )

    try:
        await run_analysis_pipeline(payload)
    except Exception as e:
        print(f"  ! pipeline raised: {e}")

    row = client.table("analysis_runs").select(
        "status, step_status, jd_analysis_result, cv_jd_matching_result, "
        "ats_scoring_result, keyword_feasibility, tailored_cv_storage_path, "
        "tailored_ats_scoring_result, match_score, tailored_match_score, "
        "initial_ats_score, ats_lift, error_message, quality_flags, "
        "role_family_id, injected_keywords"
    ).eq("id", run_id).execute().data[0]

    # Pull the tailored markdown from storage
    tailored_md = ""
    sp = row.get("tailored_cv_storage_path")
    if sp:
        try:
            tailored_md = client.storage.from_("tailored-cvs").download(sp).decode("utf-8")
        except Exception as e:
            print(f"  ! storage download failed: {e}")

    return {
        "run_id":  run_id,
        "row":     row,
        "tailored_md": tailored_md,
        "jd_meta": jd_meta,
    }


# ── Issue detectors ──────────────────────────────────────────────────────────
SETTING_LABELS = {
    "aged care", "residential aged care", "home care", "community care",
    "disability support", "individual support", "lifestyle programs",
    "in-home care", "in home care",
}
CREDENTIAL_KEYWORDS = {
    "ahpra", "police check", "ndis worker check", "ndiswc", "first aid",
    "manual handling certificate", "white card", "drivers licence", "drivers license",
}
CARE_DOMAIN_FLOORS = {
    "personal care", "mobility support", "dementia care",
    "medication administration", "activities of daily living",
    "manual handling", "infection control", "person-centred care",
    "individual support", "emotional support",
}


def find_issues(rec: dict) -> List[str]:
    issues: List[str] = []
    jd  = rec["row"].get("jd_analysis_result") or {}
    req = jd.get("required_skills") or {}
    pref = jd.get("preferred_skills") or {}

    all_skills = []
    for blk in (req, pref):
        for cat in ("technical", "soft_skills", "domain_knowledge"):
            all_skills.extend((blk.get(cat) or []))
    all_skills_lower = [s.lower() for s in all_skills if isinstance(s, str)]

    # 1. domain_knowledge underextraction
    dk_count = len((req.get("domain_knowledge") or [])) + len((pref.get("domain_knowledge") or []))
    if dk_count < 3:
        issues.append(f"JD-EXTRACT under-extraction: only {dk_count} domain_knowledge skills total")

    # 2. setting labels as skills
    leaked_settings = [s for s in all_skills_lower if s in SETTING_LABELS]
    if leaked_settings:
        issues.append(f"JD-EXTRACT setting label leaked into skills: {leaked_settings}")

    # 3. credentials in skills
    leaked_creds = [s for s in all_skills_lower
                    if any(c in s for c in CREDENTIAL_KEYWORDS)]
    if leaked_creds:
        issues.append(f"JD-EXTRACT credential leaked into skills: {leaked_creds}")

    # 4. care vertical floor: must include at least one care skill
    role_fam = rec["row"].get("role_family_id")
    if role_fam == "nursing":
        hits = [s for s in all_skills_lower if any(c in s for c in CARE_DOMAIN_FLOORS)]
        if not hits:
            issues.append(f"JD-EXTRACT care vertical but ZERO care domain skills extracted")

    # 5. summary word count + sentence count
    md = rec["tailored_md"]
    if md:
        import re
        m = re.search(r"## (Professional Summary|Career Highlights)\n+([^\n#][^#]*?)(?=\n##|$)",
                      md, re.DOTALL | re.IGNORECASE)
        if m:
            summary = m.group(2).strip()
            words = len(re.findall(r"\b\w+\b", summary))
            sents = [s for s in re.split(r"[.!?]+", summary) if s.strip()]
            if words < 35 or words > 50:
                issues.append(f"SUMMARY word count {words} outside 35-50")
            if len(sents) != 2:
                issues.append(f"SUMMARY sentence count {len(sents)} != 2")
        else:
            issues.append("SUMMARY section not found in tailored CV")

    # 6. education in tailored CV — no VET codes, ≤3 entries
    if md:
        import re
        edu_m = re.search(r"## Education\n+([^#]*?)(?=\n##|$)", md, re.DOTALL)
        if edu_m:
            body = edu_m.group(1)
            vet = re.findall(r"\b(?:HLT|CHC|BSB|FSK|SIT|CPP|AHC|HLTHPS|HLTAID)[A-Z0-9]{2,6}\b", body)
            if vet:
                issues.append(f"EDU VET codes leaked: {vet}")
            entries = re.findall(r"^### ", body, re.MULTILINE)
            if len(entries) > 3:
                issues.append(f"EDU entry count {len(entries)} > 3")

    # 7. injection: how many approved keywords landed in skills section
    feas = rec["row"].get("keyword_feasibility") or {}
    plan = feas.get("feasibility_plan") or {}
    approved = []
    for bucket in ("inject_directly", "inject_with_inference", "inject_as_extension"):
        for entry in (plan.get(bucket) or []):
            if isinstance(entry, dict):
                kw = entry.get("keyword")
                if kw: approved.append(kw.lower())
    if approved and md:
        md_lower = md.lower()
        landed = [k for k in approved if k in md_lower]
        rate = len(landed) / len(approved)
        if rate < 0.8:
            missed = [k for k in approved if k not in landed]
            issues.append(f"INJECTION {len(landed)}/{len(approved)} ({rate*100:.0f}%) approved keywords landed; missed: {missed[:6]}")

    return issues


# ── Main loop ────────────────────────────────────────────────────────────────
async def main(iteration: int) -> None:
    client = sb()
    user_id, cv_id, jobs, cv_text = resolve_full_ids(client)
    print(f"CV {cv_id[:8]} ({len(cv_text)} chars), {len(jobs)} JDs")

    run_records: List[dict] = []
    for full_jid, meta in jobs:
        print(f"\n→ {meta['company']} — {meta['title'][:50]} ({len(meta['jd_text'])} chars)")
        rec = await run_one(client, user_id, cv_id, full_jid, meta["jd_text"], meta)
        rec["job_id_short"] = full_jid[:8]
        run_records.append(rec)
        issues = find_issues(rec)
        for i in issues:
            print(f"    ⚠ {i}")
        if not issues:
            print("    ✓ no issues found")

    # Aggregate
    out_path = OUT / f"iter_{iteration}.json"
    serialisable = []
    for rec in run_records:
        serialisable.append({
            "job_id":     rec["job_id_short"],
            "company":    rec["jd_meta"]["company"],
            "title":      rec["jd_meta"]["title"],
            "status":     rec["row"].get("status"),
            "step_status": rec["row"].get("step_status"),
            "role_family_id": rec["row"].get("role_family_id"),
            "jd_analysis": rec["row"].get("jd_analysis_result"),
            "feasibility": rec["row"].get("keyword_feasibility"),
            "tailored_md": rec["tailored_md"],
            "match_score": rec["row"].get("match_score"),
            "tailored_match_score": rec["row"].get("tailored_match_score"),
            "ats_lift":   rec["row"].get("ats_lift"),
            "issues":     find_issues(rec),
            "error":      rec["row"].get("error_message"),
        })
    out_path.write_text(json.dumps(serialisable, indent=2, default=str))
    print(f"\n→ wrote {out_path}")

    # Summary
    total_issues = sum(len(r["issues"]) for r in serialisable)
    print(f"\nIteration {iteration}: {total_issues} issue(s) across {len(serialisable)} JDs")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--iteration", type=int, default=1)
    args = p.parse_args()
    asyncio.run(main(args.iteration))
