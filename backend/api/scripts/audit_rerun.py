"""Audit re-run: 5 jobs for Shanti + 5 jobs for Rashmi through the
honesty-guard-enabled pipeline. Saves results to /tmp/audit_rerun/.

Run:
    cd cv-backend
    ./.venv/bin/python scripts/audit_rerun.py
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env.realtest", override=True)

OPENAI_KEY = os.environ["OPENAI_API_KEY"]
AI_PROVIDER = "openai"
AI_MODEL = "gpt-5.1"

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("audit_rerun")

OUT_DIR = Path("/tmp/audit_rerun")
OUT_DIR.mkdir(exist_ok=True)


SHANTI = {
    "name": "shanti",
    "user_id": "4e6f1a49-df6d-4303-a56f-edd24bee5d67",
    "cv_version_id": "41cfe764-f9ed-4dfe-bc38-f767bf7674b8",
    "cv_text_path": "/tmp/shanti_source.md",
    # Picked from previous audit — the cases that previously had bugs:
    "jobs": [
        # Hardi — previously fabricated Dimeo "2023–2024"
        "3aa529ca-7e93-49ca-84e2-78f9ead7fb3d",
        # Aeralife — previously fabricated Dimeo "2023–2024" + BBA "2017–2021"
        "b82d3b3a-01a7-4fbb-8da7-ae90694d718d",
        # Anglicare — "retirement village placement" misframe
        "85749033-977b-4ed3-8d64-40a1938fbe08",
        # Australian Unity — "domestic assistance" categorical hallucination
        "773a6688-c8c9-470b-b662-2177ec663331",
        # NSW Health undergrad — De-escalation hallucination + Technical Skills label
        "bf4bdf33-df2f-42d1-84b4-48edd89362fa",
    ],
    "jobs_index_path": "backend/api/docs/realtest/jobs_index.json",
}

RASHMI = {
    "name": "rashmi",
    "user_id": "bd042f23-fa76-4b20-a74f-ee148f0fe304",
    "cv_version_id": "92f02035-b70a-4da6-bdbf-30cb8aef0db2",
    "cv_text_path": "/tmp/rashmi_source.md",
    # 5 of her 8 recent runs:
    "jobs": [
        "f7921b9b-",  # placeholder — load from /tmp/rashmi_jobs.json
    ],
    "jobs_index_path": "/tmp/rashmi_jobs.json",
}


def load_jobs(idx_path: str) -> dict:
    if idx_path.startswith("/"):
        path = idx_path
    else:
        path = str(Path(__file__).parent.parent.parent / idx_path)
    with open(path) as f:
        return json.load(f)


def pre_create_run(sb, user_id, job_id, cv_version_id, jd_text) -> str:
    run_id = str(uuid.uuid4())
    sb.table("analysis_runs").insert({
        "id": run_id, "user_id": user_id, "job_id": job_id,
        "cv_version_id": cv_version_id, "jd_text": jd_text,
        "status": "pending", "ai_provider": AI_PROVIDER, "ai_model": AI_MODEL,
    }).execute()
    return run_id


def fetch_run(sb, run_id_str):
    r = sb.table("analysis_runs").select(
        "id,status,error_message,match_score,tailored_match_score,"
        "tailored_cv_storage_path,jd_analysis_result,ats_scoring_result,"
        "tailored_ats_scoring_result,keyword_feasibility"
    ).eq("id", run_id_str).single().execute()
    return r.data or {}


async def run_one(candidate, job_id, job_info):
    from app.database import get_supabase
    from app.schemas.internal import AnalyzeRequest
    from app.services.pipeline.orchestrator import run_analysis_pipeline

    sb = get_supabase()
    with open(candidate["cv_text_path"]) as f:
        cv_text = f.read()

    company = job_info.get("company", "?")
    title = job_info.get("title", "?")
    logger.info("[%s] %s — %s", candidate["name"], company, title[:50])

    run_id_str = pre_create_run(sb, candidate["user_id"], job_id, candidate["cv_version_id"], job_info["jd_text"])
    payload = AnalyzeRequest(
        run_id=uuid.UUID(run_id_str),
        user_id=uuid.UUID(candidate["user_id"]),
        cv_version_id=uuid.UUID(candidate["cv_version_id"]),
        jd_text=job_info["jd_text"],
        cv_text=cv_text,
        ai_provider=AI_PROVIDER,
        ai_api_key=OPENAI_KEY,
        ai_model=AI_MODEL,
        skip_initial_gate=True,
    )
    await run_analysis_pipeline(payload)
    result = fetch_run(sb, run_id_str)
    result["_company"] = company
    result["_title"] = title
    result["_candidate"] = candidate["name"]

    # Save raw + download tailored md
    out_json = OUT_DIR / f"{candidate['name']}_{job_id}.json"
    with open(out_json, "w") as f:
        json.dump(result, f, indent=2, default=str)
    path = result.get("tailored_cv_storage_path")
    if path:
        try:
            blob = sb.storage.from_("tailored-cvs").download(path)
            out_md = OUT_DIR / f"{candidate['name']}_{job_id}.md"
            with open(out_md, "wb") as f:
                f.write(blob)
        except Exception as e:
            logger.warning("could not download %s: %s", path, e)
    init = result.get("match_score")
    fin = result.get("tailored_match_score")
    logger.info("  result: %s → %s", init, fin)
    return result


async def main():
    # Load Rashmi jobs from /tmp/rashmi_jobs.json
    rashmi_jobs = load_jobs(RASHMI["jobs_index_path"])
    RASHMI["jobs"] = list(rashmi_jobs.keys())[:5]
    shanti_jobs_idx = load_jobs(SHANTI["jobs_index_path"])

    tasks = []
    for jid in SHANTI["jobs"]:
        info = shanti_jobs_idx.get(jid)
        if not info: continue
        tasks.append((SHANTI, jid, info))
    for jid in RASHMI["jobs"]:
        info = rashmi_jobs.get(jid)
        if not info: continue
        tasks.append((RASHMI, jid, info))

    # Run sequentially (concurrent would race on Supabase + LLM)
    for cand, jid, info in tasks:
        try:
            await run_one(cand, jid, info)
        except Exception as e:
            logger.exception("FAIL %s/%s: %s", cand["name"], jid[:8], e)


if __name__ == "__main__":
    asyncio.run(main())
