"""
Internal API consumed exclusively by JobTrackr's Next.js routes.

All endpoints require an HMAC-SHA256 signature in X-Signature, computed with
the shared JOBTRACKR_HMAC_SECRET. cv-backend has no other auth surface and
is not exposed to browsers.

Endpoints:
  - POST /internal/analyze                  — kicks off the pipeline (BackgroundTask)
  - POST /internal/extract-cv-text          — pypdf extraction for a Storage object
  - POST /internal/categorise-cv            — BYOK skill categorisation
  - POST /internal/extract-voice-fingerprint — voice fingerprint extraction
  - POST /internal/extract-stories          — story extraction from CV
  - POST /internal/match-stories            — deterministic story-to-JD ranking
  - POST /internal/scrape-jd               — JD scraping helper
  - POST /internal/research-company         — company research (Tavily + scrape + AI distill)
  - POST /internal/select-company-fact      — deterministic fact ranking (no AI)
  - POST /internal/generate-cover-letter        — single-call cover letter pipeline (BackgroundTask)
  - POST /internal/generate-opening-variants    — 3-4 P1 opener variants, synchronous
  - POST /internal/classify-skills              — deterministic lexicon classify, no AI
"""
from fastapi import APIRouter, Depends

from app.security.hmac import verify_hmac
from . import analyze, cv, voice, stories, scrape, company, cover_letter, skills

router = APIRouter(prefix="/internal", tags=["internal"], dependencies=[Depends(verify_hmac)])

for _m in (analyze, cv, voice, stories, scrape, company, cover_letter, skills):
    router.include_router(_m.router)
