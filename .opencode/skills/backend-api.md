---
name: backend-api
description: "Add or modify Python FastAPI endpoints in backend/api. Covers route handlers, Pydantic schemas, AI client usage, error handling, and HMAC-signed internal API conventions. Use when working on the Python backend."
trigger: backend
---

# Backend API Patterns

## Stack

- Python 3.12, FastAPI, async-only
- Pydantic v2 for schemas
- httpx for HTTP calls
- Supabase REST via `supabase-py` (service-role, no SQLAlchemy)
- AI: Anthropic, OpenAI, DeepSeek via unified client

## Entry Point

`backend/api/app/main.py` — FastAPI app with:
- CORS locked to GET/POST/OPTIONS + HMAC headers
- RequestId middleware (propagates `x-request-id`)
- Sentry integration (10% traces in prod)
- Docs disabled in production
- Two routers: `health` (public) and `internal` (HMAC-protected)

## Adding a New Endpoint

### 1. Create route file in `routes/internal/`

```python
# backend/api/app/routes/internal/my_feature.py
from fastapi import APIRouter, HTTPException
from app.schemas.internal import MyFeatureRequest, MyFeatureResponse

router = APIRouter()

@router.post("/my-feature", response_model=MyFeatureResponse)
async def my_feature(req: MyFeatureRequest):
    # Business logic here
    return MyFeatureResponse(result="...")
```

### 2. Register in `routes/internal/__init__.py`

```python
from . import my_feature
router.include_router(my_feature.router)
```

The `/internal` router already has `dependencies=[Depends(verify_hmac)]` — all routes under it are HMAC-protected automatically.

### 3. Create Pydantic schema in `schemas/`

```python
# backend/api/app/schemas/internal.py
from pydantic import BaseModel, Field

class MyFeatureRequest(BaseModel):
    user_id: str
    input_text: str = Field(min_length=1)

class MyFeatureResponse(BaseModel):
    result: str
```

For endpoints that need AI, extend the BYOK mixin:

```python
from app.schemas._byok import BYOK

class MyAiRequest(BYOK):
    input_text: str
    # Inherits: ai_provider, ai_api_key, ai_model
```

## Error Handling Convention

```python
from app.services.ai.client import AIClientError

@router.post("/my-endpoint")
async def handler(req: MyRequest):
    try:
        result = await some_service(req)
        return result
    except AIClientError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        # AI call failures (connection, timeout, 5xx from provider)
        raise HTTPException(status_code=502, detail=f"AI provider error: {exc}")
```

**Error taxonomy:**
| Error | Status | When |
|-------|--------|------|
| `AIClientError` | 422 | Bad request to AI (invalid params) |
| `AIBillingError` | 422 | AI provider billing issue |
| `AIRateLimitError` | 429 | AI provider rate limit |
| `AIJSONParseError` | 422 | AI returned unparseable JSON (auto-retries 3x) |
| AI connection/5xx | 502 | Provider unavailable |
| `ValueError` | 422 | Business logic validation |

## AI Client Usage

```python
from app.services.ai.client import make_ai_client

async def my_ai_call(text: str, api_key: str, provider: str, model: str | None):
    client = make_ai_client(provider=provider, api_key=api_key, model=model)

    # Text completion
    result = await client.complete(
        system="You are a helpful assistant.",
        user=f"Process this: {text}",
        max_tokens=4096,
    )

    # JSON completion (auto-retries on parse failure)
    data = await client.complete_json(
        system="Extract structured data from this text.",
        user=text,
        response_model=MyPydanticModel,  # optional Pydantic validation
        max_tokens=4096,
    )
    return data
```

The AI client handles:
- Auto-retry on HTTP/2 resets, connection drops, 502/503/504, 529
- Temperature auto-strike (newer Claude models reject temperature)
- Max_tokens auto-doubling on truncation
- JSON extraction: strip fences → strict parse → balanced extraction → json_repair
- Usage tracking (fire-and-forget `ai_calls` insert)

## Supabase Access

```python
from app.database import get_supabase

supabase = get_supabase()  # Singleton, service-role, bypasses RLS

# Read
result = supabase.table("jobs").select("id, title").eq("id", job_id).execute()

# Write
supabase.table("jobs").update({"jd_quality": "rich"}).eq("id", job_id).execute()

# RPC
result = supabase.rpc("my_function", {"param": value}).execute()
```

**Important:** The Supabase client forces HTTP/1.1 to avoid HTTP/2 GOAWAY failures.

## Configuration

All config via Pydantic Settings in `config.py`:

```python
from app.config import get_settings
settings = get_settings()
# settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY
# settings.JOBTRACKR_HMAC_SECRET, settings.SENTRY_DSN
# settings.TAVILY_API_KEY
```

## File Structure Reference

```
backend/api/app/
  main.py              Entry point
  config.py            Pydantic Settings
  database.py          Supabase singleton
  db.py                Shared DB helpers (retry-safe UPDATE, storage upload)
  enums.py             Provider, SkillCategory, StepName, etc.
  routes/
    health.py          GET /health, GET /health/db
    internal/          HMAC-protected endpoints (8 route files)
  schemas/
    _byok.py           BYOK mixin (ai_provider, ai_api_key, ai_model)
    internal.py        Request/response models
    company.py, cover_letter.py, stories.py, voice.py
  services/
    ai/
      client.py        Unified AI client (755 lines)
      usage_tracker.py Fire-and-forget ai_calls writer
      prompts/         All AI prompt templates (12+ files)
    pipeline/
      orchestrator.py  7-step pipeline (668 lines)
      steps/           Individual step implementations (10 files)
    cv/                CV parsing, structurization, rendering, PDF
    cover_letter/      3-pass cover letter pipeline
    company/           Research, fact selection, quality scoring
    skills/            Lexicon-based classification
    eval/              Deterministic enforcement + verification
    voice/             Trust scoring, fingerprint extraction
  security/
    hmac.py            HMAC-SHA256 verification
    ssrf.py            SSRF guard for URL fetching
```

## Anti-Patterns

- **Never** use SQLAlchemy — direct Supabase REST writes via httpx
- **Never** use sync route handlers — all routes must be `async def`
- **Never** catch and silently swallow exceptions — always re-raise or return error response
- **Never** forget `from exc` when re-raising: `raise HTTPException(...) from exc`
- **Never** expose backend/api routes to the browser — they are internal only
- **Never** log `voice_sample_text` — it's sensitive user content
- **Never** persist AI API keys — they're held in memory for pipeline lifetime only
- **Never** add public (non-HMAC) endpoints under `/internal/`
