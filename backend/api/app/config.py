from __future__ import annotations

import json
import logging
from functools import lru_cache
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.enums import Provider

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    # -------------------------------------------------------------------------
    # Supabase (shared project with JobTrackr)
    # -------------------------------------------------------------------------
    SUPABASE_URL: str
    SUPABASE_ANON_KEY: str
    SUPABASE_SERVICE_ROLE_KEY: str

    # -------------------------------------------------------------------------
    # Supabase Storage buckets
    # -------------------------------------------------------------------------
    SUPABASE_CV_BUCKET: str = "cvs"
    SUPABASE_TAILORED_CV_BUCKET: str = "tailored-cvs"

    # -------------------------------------------------------------------------
    # AI defaults — actual key is BYOK, supplied by JobTrackr per-request.
    # -------------------------------------------------------------------------
    DEFAULT_AI_PROVIDER: Provider = Provider.ANTHROPIC
    DEFAULT_AI_MODEL: str = "claude-3-5-sonnet-20241022"

    # -------------------------------------------------------------------------
    # Tailored-CV writer selection (beta→production migration).
    #   "w8_verified" — the role-family composition + deterministic enforce +
    #                   entailment-verify path (the validated writer; default).
    #   "legacy"      — the original single-call run_tailored_cv, kept as a
    #                   reversible escape hatch via the env var.
    # Default is "w8_verified" so output is consistent regardless of whether a
    # Fly secret is set; set TAILORED_CV_WRITER=legacy to fall back.
    # -------------------------------------------------------------------------
    TAILORED_CV_WRITER: str = "w8_verified"

    # -------------------------------------------------------------------------
    # Max analysis pipelines that may run their real work concurrently.
    # /internal/analyze fires every request as an unbounded BackgroundTask, so a
    # bulk auto-analysis of N jobs would otherwise stampede N pipelines at once
    # onto the shared Supabase client + the user's AI-key rate limit (the cause
    # of the HTTP/2 ConnectionTerminated failures during bulk runs). Excess runs
    # queue on a semaphore and start as slots free — they're still 202-accepted
    # instantly. Raise carefully: too high re-introduces the stampede.
    # -------------------------------------------------------------------------
    MAX_CONCURRENT_ANALYSES: int = 4

    # -------------------------------------------------------------------------
    # HMAC shared secret with JobTrackr — must match JOBTRACKR_HMAC_SECRET on
    # Vercel. cv-backend rejects requests whose signature does not verify.
    # -------------------------------------------------------------------------
    JOBTRACKR_HMAC_SECRET: str = ""

    # -------------------------------------------------------------------------
    # Tavily web search (system-level key — NOT user-supplied)
    # Used by company research pipeline (Phase 10.3). Leave empty to fall
    # back to direct website scraping only (search_skipped=true in response).
    # -------------------------------------------------------------------------
    TAVILY_API_KEY: str = ""

    # -------------------------------------------------------------------------
    # Sentry
    # -------------------------------------------------------------------------
    SENTRY_DSN: str = ""

    # -------------------------------------------------------------------------
    # CORS — cv-backend is internal; only JobTrackr's domain needs allowance
    # if any browser request ever lands here (currently none do).
    # -------------------------------------------------------------------------
    ALLOWED_ORIGINS: List[str] = ["http://localhost:3000"]

    @field_validator("ALLOWED_ORIGINS", mode="before")
    @classmethod
    def parse_allowed_origins(cls, v: object) -> List[str]:
        if isinstance(v, str):
            try:
                parsed = json.loads(v)
                if isinstance(parsed, list):
                    return parsed
            except json.JSONDecodeError:
                return [v]
        return v  # type: ignore[return-value]

    # -------------------------------------------------------------------------
    # Application
    # -------------------------------------------------------------------------
    ENVIRONMENT: str = "development"
    LOG_LEVEL: str = "INFO"

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
