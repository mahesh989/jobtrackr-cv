from __future__ import annotations

import json
import logging
from functools import lru_cache
from typing import List

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

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
    SUPABASE_DB_URL: str  # postgresql+asyncpg://...

    # -------------------------------------------------------------------------
    # Supabase Storage buckets
    # -------------------------------------------------------------------------
    SUPABASE_CV_BUCKET: str = "cvs"
    SUPABASE_TAILORED_CV_BUCKET: str = "tailored-cvs"

    # -------------------------------------------------------------------------
    # AI defaults — actual key is BYOK, supplied by JobTrackr per-request in 2d.
    # -------------------------------------------------------------------------
    DEFAULT_AI_PROVIDER: str = "anthropic"
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
    # HMAC shared secret with JobTrackr (set in commit 2c, deployed in 2f).
    # cv-backend rejects requests whose signature does not verify with this.
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
