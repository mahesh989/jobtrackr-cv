"""
Step 0 — Discover the ~40 analysed jobs + active CV for the real-test loop.
Run once to build ledger.json:

  cd cv-backend
  ./.venv/bin/python scripts/realtest_discover.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

# Add cv-backend to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

sb = create_client(SUPABASE_URL, SUPABASE_KEY)

LEDGER_PATH = Path(__file__).parent.parent / "docs" / "realtest" / "ledger.json"
RUNS_DIR = Path(__file__).parent.parent / "docs" / "realtest" / "runs"


def main():
    print("=== Step 0: Data Discovery ===\n")

    # 1. Find all users with completed analysis runs
    print("Fetching users with completed analysis runs...")
    runs = (
        sb.table("analysis_runs")
        .select("user_id, job_id, cv_version_id, jd_text")
        .eq("status", "completed")
        .execute()
    )
    print(f"  Total completed runs: {len(runs.data)}")

    # Group by user
    user_runs: dict[str, list] = {}
    for r in runs.data:
        uid = r["user_id"]
        user_runs.setdefault(uid, []).append(r)

    print(f"  Users with completed runs: {len(user_runs)}")
    for uid, uruns in sorted(user_runs.items(), key=lambda x: -len(x[1])):
        print(f"  - {uid}: {len(uruns)} runs")

    # Pick the user with the most runs (that's Rashmi/mahesh)
    target_user_id = max(user_runs, key=lambda uid: len(user_runs[uid]))
    print(f"\nTarget user: {target_user_id} ({len(user_runs[target_user_id])} completed runs)")

    # 2. Get active CV for this user
    print("\nFetching active CV...")
    cv_resp = (
        sb.table("cv_versions")
        .select("id, label, cv_text")
        .eq("user_id", target_user_id)
        .eq("is_active", True)
        .single()
        .execute()
    )
    cv = cv_resp.data
    print(f"  Active CV: {cv['id']} ({cv['label']}) — {len(cv['cv_text'])} chars")

    # 3. Get contact details from user_preferences
    print("\nFetching contact details...")
    try:
        pref_resp = (
            sb.table("user_preferences")
            .select("contact_details")
            .eq("user_id", target_user_id)
            .single()
            .execute()
        )
        contact_details = pref_resp.data.get("contact_details")
        print(f"  Contact details: {list(contact_details.keys()) if contact_details else 'None'}")
    except Exception as e:
        print(f"  Could not fetch contact details: {e}")
        contact_details = None

    # 4. Collect unique job_ids with their JD text
    # Use the most recent completed run per job
    job_data: dict[str, dict] = {}
    for r in user_runs[target_user_id]:
        jid = r["job_id"]
        if jid not in job_data:
            job_data[jid] = {
                "job_id": jid,
                "jd_text": r["jd_text"],
                "cv_version_id": r["cv_version_id"],
            }

    all_job_ids = list(job_data.keys())
    print(f"\nUnique jobs with completed runs: {len(all_job_ids)}")

    # 5. Enrich with job titles from jobs table
    print("Fetching job titles...")
    jobs_resp = (
        sb.table("jobs")
        .select("id, title, company")
        .in_("id", all_job_ids)
        .execute()
    )
    job_meta = {j["id"]: j for j in jobs_resp.data}
    for jid in all_job_ids:
        if jid in job_meta:
            jm = job_meta[jid]
            job_data[jid]["title"] = jm.get("title", "")
            job_data[jid]["company"] = jm.get("company", "")
            print(f"  {jid[:8]}... {jm.get('company','?')} — {jm.get('title','?')}")

    # 6. Write job data for the driver
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    jobs_index_path = RUNS_DIR.parent / "jobs_index.json"
    with open(jobs_index_path, "w") as f:
        json.dump(job_data, f, indent=2)
    print(f"\nWrote jobs index to {jobs_index_path}")

    # 7. Write the ledger
    if LEDGER_PATH.exists():
        print(f"\nLedger already exists at {LEDGER_PATH} — not overwriting.")
        print("Delete it manually if you want a fresh start.")
        return

    ledger = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "active_cv_version_id": cv["id"],
        "cv_text": cv["cv_text"],
        "contact_details": contact_details,
        "user_id": target_user_id,
        "total_jobs": len(all_job_ids),
        "all_job_ids": all_job_ids,
        "processed_job_ids": [],
        "batches": [],
        "deferred_narrow_issues": [],
        "done": False,
    }
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(LEDGER_PATH, "w") as f:
        json.dump(ledger, f, indent=2)
    print(f"Wrote ledger to {LEDGER_PATH}")
    print(f"\nReady for batch loop — {len(all_job_ids)} jobs queued.")


if __name__ == "__main__":
    main()
