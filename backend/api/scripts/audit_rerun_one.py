"""Re-run just the previously-escaped job(s) to confirm the fix."""
import asyncio, json, os, sys, uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env.realtest", override=True)

OPENAI_KEY = os.environ["OPENAI_API_KEY"]

import logging
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

from app.database import get_supabase
from app.schemas.internal import AnalyzeRequest
from app.services.pipeline.orchestrator import run_analysis_pipeline

SHANTI = {"user_id":"4e6f1a49-df6d-4303-a56f-edd24bee5d67",
          "cv_version_id":"41cfe764-f9ed-4dfe-bc38-f767bf7674b8"}

async def main():
    sb = get_supabase()
    with open('/tmp/shanti_source.md') as f: cv_text = f.read()
    with open(Path(__file__).parent.parent / 'docs/realtest/jobs_index.json') as f:
        idx = json.load(f)
    jid = sys.argv[1] if len(sys.argv)>1 else "bf4bdf33-df2f-42d1-84b4-48edd89362fa"
    info = idx[jid]
    run_id = str(uuid.uuid4())
    sb.table("analysis_runs").insert({
        "id": run_id, "user_id": SHANTI["user_id"], "job_id": jid,
        "cv_version_id": SHANTI["cv_version_id"], "jd_text": info["jd_text"],
        "status": "pending", "ai_provider": "openai", "ai_model": "gpt-5.1",
    }).execute()
    await run_analysis_pipeline(AnalyzeRequest(
        run_id=uuid.UUID(run_id),
        user_id=uuid.UUID(SHANTI["user_id"]),
        cv_version_id=uuid.UUID(SHANTI["cv_version_id"]),
        jd_text=info["jd_text"], cv_text=cv_text,
        ai_provider="openai", ai_api_key=OPENAI_KEY, ai_model="gpt-5.1",
        skip_initial_gate=True,
    ))
    # Download
    r = sb.table("analysis_runs").select("tailored_cv_storage_path,match_score,tailored_match_score").eq("id", run_id).single().execute()
    path = r.data['tailored_cv_storage_path']
    blob = sb.storage.from_("tailored-cvs").download(path)
    out = Path(f"/tmp/audit_rerun/shanti_{jid}.md")
    out.write_bytes(blob)
    print(f"\n{jid[:8]}: {r.data['match_score']} → {r.data['tailored_match_score']}")
    print(f"Saved {out}")
    print("\nDimeo line:")
    for line in blob.decode().splitlines():
        if "Dimeo" in line or "Cleaner" in line:
            print("  " + line)

asyncio.run(main())
