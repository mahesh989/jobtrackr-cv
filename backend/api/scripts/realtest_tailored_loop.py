"""Tailored-CV harness — pipeline through step 6 (tailored CV markdown).

Runs Shanti's CV against N random JDs from the jobs index. Calls:
  1. run_jd_analysis (LLM)
  2. deterministic post-process chain
  3. run_cv_jd_matching (LLM)
  4. run_input_recommendations + run_ats_scoring (deterministic)
  5. run_keyword_feasibility (LLM)
  6. _writer_w8_verified (LLM × 2-3, includes the entailment verify pass)

NO Supabase writes (skips _upload_to_storage + _persist_quality_flags).
NO PDF generation. NO cover letter.

Saves to docs/realtest/tailored_loop/<job_id>.json with:
  • jd_analysis, matching, ats, feasibility, tailored_md

Usage:
  cd backend/api
  ./.venv/bin/python scripts/realtest_tailored_loop.py --jobs 5 --seed 42
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import random
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env.realtest", override=True)

OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
if not OPENAI_KEY or not OPENAI_KEY.startswith("sk-"):
    print("ERROR: OPENAI_API_KEY not set in .env.realtest")
    sys.exit(1)

AI_PROVIDER = "openai"
AI_MODEL = "gpt-5.1"

DOCS_DIR = Path(__file__).parent.parent / "docs" / "realtest"
LEDGER_PATH = DOCS_DIR / "ledger.json"
JOBS_INDEX_PATH = DOCS_DIR / "jobs_index.json"
OUT_DIR = DOCS_DIR / "tailored_loop"

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("tailored_loop")
logger.setLevel(logging.INFO)


async def run_one(client, cv_text, contact_details, jd_text, job_meta, out_path):
    from app.services.pipeline.steps.jd_analysis import run_jd_analysis
    from app.services.pipeline.steps.cv_jd_matching import run_cv_jd_matching
    from app.services.pipeline.steps.input_recommendations import run_input_recommendations
    from app.services.pipeline.steps.ats_scoring import run_ats_scoring
    from app.services.pipeline.steps.keyword_feasibility import run_keyword_feasibility
    from app.services.eval.role_families import (
        category_labels, category_order, resolve_role_family,
    )
    from app.services.skills import (
        clamp_by_jd_sections,
        enrich_required_skills_from_jd_body,
        post_process_jd_analysis,
        verify_skill_evidence,
    )
    from app.services.skills.post_process import demote_off_setting_keywords
    from app.services.eval.writers import _classify_jd_setting
    from app.services.eval.writers._impl import _writer_w8_verified

    job_id = job_meta["job_id"]
    logger.info("Running %s — %s @ %s",
                job_id[:8], job_meta.get("title", "?")[:50],
                job_meta.get("company", "?"))

    # Step 1 — JD analysis
    jd_analysis = await run_jd_analysis(client, jd_text)
    _rf = resolve_role_family(None, jd_analysis)
    jd_analysis["role_family"] = _rf.id
    jd_analysis["category_labels"] = category_labels(_rf)
    jd_analysis["category_order"] = category_order(_rf)

    rfi = str(jd_analysis.get("role_family") or "master")
    jd_analysis = verify_skill_evidence(jd_analysis, jd_text, role_family_id=rfi)
    jd_analysis = enrich_required_skills_from_jd_body(jd_analysis, jd_text, role_family_id=rfi)
    jd_analysis = post_process_jd_analysis(jd_analysis, role_family_id=rfi)
    jd_analysis = clamp_by_jd_sections(jd_analysis, jd_text)
    try:
        setting = _classify_jd_setting(jd_text, jd_analysis)
        jd_analysis = demote_off_setting_keywords(jd_analysis, setting)
    except Exception:
        pass

    # Step 2 — CV-JD matching
    matching = await run_cv_jd_matching(client, cv_text, jd_analysis)

    # Step 3 — ATS scoring (deterministic, sync)
    ats = run_ats_scoring(cv_text, jd_analysis, matching)

    # Step 4 — input recs (deterministic, sync)
    input_recs = run_input_recommendations(cv_text, jd_analysis, matching, ats)

    # Step 5 — keyword feasibility (LLM)
    feasibility = await run_keyword_feasibility(
        client, cv_text, jd_analysis, matching, input_recs,
        contact_details=contact_details,
    )

    # Step 6 — tailored CV via w8_verified writer (no Supabase writes)
    _FAMILY_TO_VERTICAL = {"tech": "tech", "nursing": "nursing", "manual": "cleaning"}
    vertical = _FAMILY_TO_VERTICAL.get(str(jd_analysis.get("role_family") or ""))
    upstream = {
        "jd_analysis": jd_analysis, "matching": matching,
        "ats": ats, "input_recs": input_recs, "feasibility": feasibility,
    }
    writer_result = await _writer_w8_verified(
        client, cv_text, jd_text, contact_details,
        vertical=vertical, upstream=upstream,
    )
    tailored_md = writer_result.tailored_md
    extras = writer_result.extras or {}

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "job_id": job_id,
        "title": job_meta.get("title"),
        "company": job_meta.get("company"),
        "jd_text": jd_text,
        "jd_analysis": jd_analysis,
        "matching": matching,
        "ats": ats,
        "feasibility": feasibility,
        "tailored_md": tailored_md,
        "writer_extras": {
            "honesty_guard_notes": extras.get("honesty_guard_notes") or [],
            "pre_filter_dropped_roles": extras.get("pre_filter_dropped_roles") or [],
            "honesty_risk": extras.get("honesty_risk") or {},
            "filtered_non_skill": extras.get("filtered_non_skill") or [],
            "force_inject_notes": extras.get("force_inject_notes") or [],
            "approved_but_missed": extras.get("approved_but_missed") or [],
        },
    }
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)
    logger.info("  -> %s (md %d chars)", out_path.name, len(tailored_md))


async def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42,
                    help="random seed for job selection (deterministic)")
    args = ap.parse_args(argv)

    ledger = json.load(open(LEDGER_PATH))
    jobs_index = json.load(open(JOBS_INDEX_PATH))
    cv_text = ledger["cv_text"]
    contact_details = ledger.get("contact_details") or {}

    all_ids = list(jobs_index.keys())
    rng = random.Random(args.seed)
    selected = rng.sample(all_ids, min(args.jobs, len(all_ids)))

    print(f"Selected {len(selected)} job(s) with seed={args.seed}:")
    for jid in selected:
        meta = jobs_index.get(jid) or {}
        print(f"  {jid[:8]} — {meta.get('title','?')[:50]} @ {meta.get('company','?')}")

    from app.services.ai.client import AIClient
    client = AIClient(
        provider=AI_PROVIDER, model=AI_MODEL, api_key=OPENAI_KEY,
        operation="realtest_tailored_loop",
    )

    for jid in selected:
        meta = jobs_index.get(jid)
        if not meta:
            continue
        try:
            await run_one(client, cv_text, contact_details,
                          meta["jd_text"], meta, OUT_DIR / f"{jid}.json")
        except Exception as e:  # noqa: BLE001
            logger.error("  FAIL %s: %s", jid[:8], e, exc_info=True)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
