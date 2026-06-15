"""Lightweight harness — JD analysis + CV-JD matching only.

Picks N jobs from docs/realtest/jobs_index.json, runs them through the
real LLM (OpenAI key from .env.realtest) and the full deterministic
post-process chain (groundedness gate, recall floor, post_process_jd_analysis,
section clamp, off-setting demoter), then runs cv_jd_matching.

Writes raw output to docs/realtest/extraction_loop/round_<N>/<job_id>.json.
NEVER writes to Supabase. NEVER generates PDFs / tailored CVs.

Usage:
  cd backend/api
  ./.venv/bin/python scripts/realtest_extraction_loop.py --round 1 --jobs 5
  ./.venv/bin/python scripts/realtest_extraction_loop.py --round 2 --jobs 5 --skip 5
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

# Add cv-backend root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env.realtest", override=True)

OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
if not OPENAI_KEY or not OPENAI_KEY.startswith("sk-"):
    print("ERROR: OPENAI_API_KEY not set or invalid in .env.realtest")
    sys.exit(1)

AI_PROVIDER = "openai"
AI_MODEL = "gpt-5.1"

DOCS_DIR = Path(__file__).parent.parent / "docs" / "realtest"
LEDGER_PATH = DOCS_DIR / "ledger.json"
JOBS_INDEX_PATH = DOCS_DIR / "jobs_index.json"
OUT_DIR = DOCS_DIR / "extraction_loop"

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("ext_loop")
logger.setLevel(logging.INFO)


async def run_one(client, cv_text, jd_text, job_meta, out_path):
    from app.services.pipeline.steps.jd_analysis import run_jd_analysis
    from app.services.pipeline.steps.cv_jd_matching import run_cv_jd_matching
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

    job_id = job_meta["job_id"]
    logger.info("Running %s — %s @ %s",
                job_id[:8], job_meta.get("title", "?")[:50],
                job_meta.get("company", "?"))

    # 1. JD analysis (LLM)
    jd_analysis = await run_jd_analysis(client, jd_text)

    # 2. Resolve role family + labels
    _rf = resolve_role_family(None, jd_analysis)
    jd_analysis["role_family"] = _rf.id
    jd_analysis["category_labels"] = category_labels(_rf)
    jd_analysis["category_order"] = category_order(_rf)

    role_family_id = str(jd_analysis.get("role_family") or "master")

    # 3. Deterministic post-process chain (same as orchestrator)
    jd_analysis = verify_skill_evidence(jd_analysis, jd_text, role_family_id=role_family_id)
    jd_analysis = enrich_required_skills_from_jd_body(jd_analysis, jd_text, role_family_id=role_family_id)
    jd_analysis = post_process_jd_analysis(jd_analysis, role_family_id=role_family_id)
    jd_analysis = clamp_by_jd_sections(jd_analysis, jd_text)
    try:
        setting = _classify_jd_setting(jd_text, jd_analysis)
        jd_analysis = demote_off_setting_keywords(jd_analysis, setting)
    except Exception:
        pass

    # 4. CV-JD matching (LLM)
    matching = await run_cv_jd_matching(client, cv_text, jd_analysis)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "job_id": job_id,
        "title": job_meta.get("title"),
        "company": job_meta.get("company"),
        "jd_text": jd_text,
        "jd_analysis": jd_analysis,
        "matching": matching,
    }
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)
    logger.info("  -> %s", out_path.name)


async def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", type=int, required=True)
    ap.add_argument("--jobs", type=int, default=5)
    ap.add_argument("--skip", type=int, default=0,
                    help="skip the first N jobs in the index (for rotating batches)")
    args = ap.parse_args(argv)

    if not LEDGER_PATH.exists() or not JOBS_INDEX_PATH.exists():
        print("ERROR: ledger.json or jobs_index.json missing")
        sys.exit(1)

    ledger = json.load(open(LEDGER_PATH))
    jobs_index = json.load(open(JOBS_INDEX_PATH))
    cv_text = ledger["cv_text"]

    # Stable ordering — use the ledger's all_job_ids order
    all_ids = ledger.get("all_job_ids") or list(jobs_index.keys())
    selected = all_ids[args.skip : args.skip + args.jobs]
    if not selected:
        print("Nothing to run with these slice args.")
        return

    print(f"Running {len(selected)} job(s) in round {args.round} "
          f"(skip={args.skip}). Output: {OUT_DIR}/round_{args.round}/")

    from app.services.ai.client import AIClient

    client = AIClient(
        provider=AI_PROVIDER, model=AI_MODEL, api_key=OPENAI_KEY,
        operation="realtest_ext_loop",
    )

    round_dir = OUT_DIR / f"round_{args.round}"
    for jid in selected:
        meta = jobs_index.get(jid)
        if not meta:
            print(f"  skip {jid[:8]} (not in index)")
            continue
        try:
            await run_one(client, cv_text, meta["jd_text"], meta,
                          round_dir / f"{jid}.json")
        except Exception as e:  # noqa: BLE001
            logger.error("  FAIL %s: %s", jid[:8], e)


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
