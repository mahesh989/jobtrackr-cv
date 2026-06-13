"""Final validation: 20 Shanti + 20 Rashmi through w8_verified+guards.

Runs in parallel batches of 4 to stay under provider rate limits.
Downloads each tailored CV. Then runs audit checks.
"""
from __future__ import annotations

import asyncio, json, logging, os, sys, uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env.realtest", override=True)

OPENAI_KEY = os.environ["OPENAI_API_KEY"]
logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("audit40")
logger.setLevel(logging.INFO)

OUT = Path("/tmp/audit_40")
OUT.mkdir(exist_ok=True)
CONCURRENCY = 4

SHANTI = {"name":"shanti", "user_id":"4e6f1a49-df6d-4303-a56f-edd24bee5d67",
          "cv_version_id":"41cfe764-f9ed-4dfe-bc38-f767bf7674b8",
          "cv_path":"/tmp/shanti_source.md"}
RASHMI = {"name":"rashmi", "user_id":"bd042f23-fa76-4b20-a74f-ee148f0fe304",
          "cv_version_id":"92f02035-b70a-4da6-bdbf-30cb8aef0db2",
          "cv_path":"/tmp/rashmi_source.md"}


async def run_one(cand, jid, info, sem):
    async with sem:
        from app.database import get_supabase
        from app.schemas.internal import AnalyzeRequest
        from app.services.pipeline.orchestrator import run_analysis_pipeline

        out_md = OUT / f"{cand['name']}_{jid}.md"
        if out_md.exists():
            return f"{cand['name']}/{jid[:8]}: cached"

        sb = get_supabase()
        with open(cand["cv_path"]) as f: cv_text = f.read()
        run_id = str(uuid.uuid4())
        try:
            sb.table("analysis_runs").insert({
                "id": run_id, "user_id": cand["user_id"], "job_id": jid,
                "cv_version_id": cand["cv_version_id"], "jd_text": info["jd_text"],
                "status":"pending", "ai_provider":"openai", "ai_model":"gpt-5.1",
            }).execute()
            await run_analysis_pipeline(AnalyzeRequest(
                run_id=uuid.UUID(run_id),
                user_id=uuid.UUID(cand["user_id"]),
                cv_version_id=uuid.UUID(cand["cv_version_id"]),
                jd_text=info["jd_text"], cv_text=cv_text,
                ai_provider="openai", ai_api_key=OPENAI_KEY, ai_model="gpt-5.1",
                skip_initial_gate=True,
            ))
            r = sb.table("analysis_runs").select(
                "tailored_cv_storage_path,match_score,tailored_match_score"
            ).eq("id", run_id).single().execute()
            path = r.data.get("tailored_cv_storage_path")
            init, fin = r.data.get("match_score"), r.data.get("tailored_match_score")
            if path:
                blob = sb.storage.from_("tailored-cvs").download(path)
                out_md.write_bytes(blob)
            label = f"{cand['name']}/{jid[:8]}: {init}->{fin}"
            print(label, flush=True)
            return label
        except Exception as e:
            print(f"{cand['name']}/{jid[:8]} FAIL: {e}", flush=True)
            return None


async def main():
    with open(Path(__file__).parent.parent / "docs/realtest/jobs_index.json") as f:
        shanti_jobs = json.load(f)
    with open("/tmp/rashmi_20.json") as f:
        rashmi_jobs = json.load(f)

    shanti_jids = list(shanti_jobs.keys())[:20]
    rashmi_jids = list(rashmi_jobs.keys())[:20]

    sem = asyncio.Semaphore(CONCURRENCY)
    tasks = []
    for jid in shanti_jids:
        tasks.append(run_one(SHANTI, jid, shanti_jobs[jid], sem))
    for jid in rashmi_jids:
        tasks.append(run_one(RASHMI, jid, rashmi_jobs[jid], sem))

    print(f"Total {len(tasks)} runs, concurrency={CONCURRENCY}\n", flush=True)
    results = await asyncio.gather(*tasks)
    ok = sum(1 for r in results if r)
    print(f"\nDone: {ok}/{len(tasks)} succeeded.")


if __name__ == "__main__":
    asyncio.run(main())
