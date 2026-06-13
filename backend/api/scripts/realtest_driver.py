"""
Real-test loop driver — runs the next batch of 5 jobs through the pipeline
in-process (Option B) and saves raw results to docs/realtest/runs/<jobid>.json.

Usage:
  cd cv-backend
  ./.venv/bin/python scripts/realtest_driver.py

Reads OPENAI_API_KEY from .env.realtest (gitignored).
Reads/writes docs/realtest/ledger.json.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Add cv-backend root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Load main env first, then realtest overlay (key only)
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env.realtest", override=True)

OPENAI_KEY = os.environ.get("OPENAI_API_KEY", "")
if not OPENAI_KEY or not OPENAI_KEY.startswith("sk-"):
    print("ERROR: OPENAI_API_KEY not set or invalid in .env.realtest")
    sys.exit(1)

AI_PROVIDER = "openai"
AI_MODEL = "gpt-5.1"  # matches UI

BATCH_SIZE = 5
DOCS_DIR = Path(__file__).parent.parent / "docs" / "realtest"
LEDGER_PATH = DOCS_DIR / "ledger.json"
RUNS_DIR = DOCS_DIR / "runs"
JOBS_INDEX_PATH = DOCS_DIR / "jobs_index.json"

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("realtest_driver")


def load_ledger() -> dict:
    if not LEDGER_PATH.exists():
        print(f"ERROR: {LEDGER_PATH} not found — run realtest_discover.py first")
        sys.exit(1)
    with open(LEDGER_PATH) as f:
        return json.load(f)


def save_ledger(ledger: dict) -> None:
    ledger["updated"] = datetime.now(timezone.utc).isoformat()
    with open(LEDGER_PATH, "w") as f:
        json.dump(ledger, f, indent=2)


def load_jobs_index() -> dict:
    with open(JOBS_INDEX_PATH) as f:
        return json.load(f)


def pre_create_run(
    supabase_client,
    user_id: str,
    job_id: str,
    cv_version_id: str,
    jd_text: str,
) -> str:
    """Insert a pending analysis_runs row, return the new run_id."""
    run_id = str(uuid.uuid4())
    resp = (
        supabase_client.table("analysis_runs")
        .insert({
            "id": run_id,
            "user_id": user_id,
            "job_id": job_id,
            "cv_version_id": cv_version_id,
            "jd_text": jd_text,
            "status": "pending",
            "ai_provider": AI_PROVIDER,
            "ai_model": AI_MODEL,
        })
        .execute()
    )
    if not resp.data:
        raise RuntimeError(f"Failed to insert analysis_runs row for job {job_id}")
    return run_id


def fetch_run_result(supabase_client, run_id: str) -> dict:
    """Fetch the full analysis_runs row after completion."""
    resp = (
        supabase_client.table("analysis_runs")
        .select(
            "id, status, error_message, "
            "jd_analysis_result, cv_jd_matching_result, ats_scoring_result, "
            "input_recommendations, keyword_feasibility, "
            "ai_recommendations, tailored_cv_storage_path, tailored_ats_scoring_result, "
            "match_score, tailored_match_score"
        )
        .eq("id", run_id)
        .single()
        .execute()
    )
    return resp.data or {}


async def run_single_job(
    job_id: str,
    job_info: dict,
    ledger: dict,
) -> dict:
    """Run one job through the pipeline; return a summary dict."""
    from app.database import get_supabase
    from app.schemas.internal import AnalyzeRequest
    from app.services.pipeline.orchestrator import run_analysis_pipeline

    sb = get_supabase()
    user_id = ledger["user_id"]
    cv_version_id = ledger["active_cv_version_id"]
    cv_text = ledger["cv_text"]
    contact_details = ledger.get("contact_details")
    jd_text = job_info["jd_text"]

    title = job_info.get("title", "")
    company = job_info.get("company", "")
    logger.info("Running: %s — %s (%s)", company, title, job_id[:8])

    run_id_str = pre_create_run(sb, user_id, job_id, cv_version_id, jd_text)
    run_id = uuid.UUID(run_id_str)

    payload = AnalyzeRequest(
        run_id=run_id,
        user_id=uuid.UUID(user_id),
        cv_version_id=uuid.UUID(cv_version_id),
        jd_text=jd_text,
        cv_text=cv_text,
        ai_provider=AI_PROVIDER,
        ai_api_key=OPENAI_KEY,
        ai_model=AI_MODEL,
        contact_details=contact_details,
        skip_initial_gate=True,  # always run to completion
    )

    await run_analysis_pipeline(payload)

    # Fetch result
    result = fetch_run_result(sb, run_id_str)
    result["_job_id"] = job_id
    result["_title"] = title
    result["_company"] = company
    result["_run_id"] = run_id_str

    status = result.get("status", "unknown")
    initial_ats = result.get("match_score")
    final_ats = result.get("tailored_match_score")
    logger.info(
        "  %s: %s — initial_ats=%s final_ats=%s",
        job_id[:8], status, initial_ats, final_ats,
    )

    # Save raw result
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_file = RUNS_DIR / f"{job_id}.json"
    with open(run_file, "w") as f:
        json.dump(result, f, indent=2)
    logger.info("  Saved to %s", run_file)

    return result


def extract_skills_summary(result: dict) -> dict:
    """Pull the skills/summary fields useful for diagnosis."""
    tailored = result.get("tailored_cv_result") or {}
    jd_analysis = result.get("jd_analysis_result") or {}
    cv_jd = result.get("cv_jd_matching_result") or {}

    # Parse tailored CV sections if it's markdown text
    tailored_md = tailored if isinstance(tailored, str) else tailored.get("tailored_cv_md", "")

    return {
        "job": f"{result.get('_company')} — {result.get('_title')}",
        "status": result.get("status"),
        "initial_ats": result.get("match_score"),
        "final_ats": result.get("tailored_match_score"),
        "error": result.get("error_message"),
        "jd_required_skills_count": len(
            (jd_analysis.get("required_skills") or {}).get("domain_knowledge", []) +
            (jd_analysis.get("required_skills") or {}).get("soft_skills", []) +
            (jd_analysis.get("required_skills") or {}).get("technical", [])
        ),
        "jd_role_family": jd_analysis.get("role_family"),
        "cv_skills_snapshot": cv_jd.get("matching_skills", [])[:10],
        "tailored_md_length": len(tailored_md),
    }


async def run_batch(batch_job_ids: list[str], jobs_index: dict, ledger: dict) -> list[dict]:
    """Run all jobs in batch sequentially (avoid rate limit spikes)."""
    results = []
    for job_id in batch_job_ids:
        job_info = jobs_index.get(job_id)
        if not job_info:
            logger.warning("Job %s not in jobs_index — skipping", job_id)
            continue
        try:
            result = await run_single_job(job_id, job_info, ledger)
            results.append(result)
        except Exception as e:
            logger.error("Job %s failed: %s", job_id, e, exc_info=True)
            results.append({
                "_job_id": job_id,
                "status": "error",
                "error_message": str(e),
            })
    return results


def print_batch_summary(results: list[dict]) -> None:
    print("\n" + "=" * 60)
    print("BATCH SUMMARY")
    print("=" * 60)
    for r in results:
        summary = extract_skills_summary(r)
        status = summary["status"] or "?"
        ats_info = f"initial={summary['initial_ats']} final={summary['final_ats']}"
        print(f"\n  {summary['job']}")
        print(f"    status={status}  {ats_info}")
        if summary.get("error"):
            print(f"    ERROR: {summary['error']}")
    print()


def main():
    ledger = load_ledger()

    if ledger.get("done"):
        print("Ledger shows done=true — all jobs processed. Nothing to do.")
        return

    processed = set(ledger.get("processed_job_ids", []))
    remaining = [j for j in ledger["all_job_ids"] if j not in processed]

    if not remaining:
        print("All jobs processed! Setting done=true.")
        ledger["done"] = True
        save_ledger(ledger)
        return

    batch = remaining[:BATCH_SIZE]
    batch_n = len(ledger.get("batches", [])) + 1
    print(f"\n=== Batch {batch_n} ({len(batch)} jobs, {len(remaining)} remaining) ===")
    for jid in batch:
        idx = jobs_index = load_jobs_index()
        info = idx.get(jid, {})
        print(f"  {jid[:8]}... {info.get('company','?')} — {info.get('title','?')}")

    jobs_index = load_jobs_index()
    results = asyncio.run(run_batch(batch, jobs_index, ledger))

    print_batch_summary(results)

    # Update ledger
    processed.update(r["_job_id"] for r in results if "_job_id" in r)
    ledger["processed_job_ids"] = list(processed)

    batch_record = {
        "n": batch_n,
        "job_ids": batch,
        "summaries": [extract_skills_summary(r) for r in results],
        "issues": [],  # filled in manually / by the diagnostic pass
        "tests": "pending",
        "commit": None,
    }
    ledger.setdefault("batches", []).append(batch_record)
    ledger["done"] = len(processed) >= len(ledger["all_job_ids"])
    save_ledger(ledger)

    print(f"Ledger updated: {len(processed)}/{ledger['total_jobs']} jobs processed.")
    if ledger["done"]:
        print("All jobs done!")
    else:
        rem = len(ledger["all_job_ids"]) - len(processed)
        print(f"{rem} jobs remaining in {(rem + BATCH_SIZE - 1) // BATCH_SIZE} more batches.")


if __name__ == "__main__":
    main()
