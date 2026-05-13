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
    # Supabase
    # -------------------------------------------------------------------------
    SUPABASE_URL: str
    SUPABASE_ANON_KEY: str
    SUPABASE_SERVICE_ROLE_KEY: str
    SUPABASE_DB_URL: str  # postgresql+asyncpg://...

    # -------------------------------------------------------------------------
    # Clerk
    # -------------------------------------------------------------------------
    CLERK_SECRET_KEY: str
    CLERK_WEBHOOK_SIGNING_SECRET: str
    CLERK_WEBHOOK_SECRET: str = ""  # alias — populated from CLERK_WEBHOOK_SIGNING_SECRET if blank
    CLERK_JWKS_URL: str

    # -------------------------------------------------------------------------
    # Supabase Storage
    # -------------------------------------------------------------------------
    SUPABASE_CV_BUCKET: str = "cv-files"
    SUPABASE_TAILORED_CV_BUCKET: str = "tailored-cvs"

    # -------------------------------------------------------------------------
    # AI Providers
    # -------------------------------------------------------------------------
    ANTHROPIC_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    DEEPSEEK_API_KEY: str = ""
    DEEPSEEK_BASE_URL: str = "https://api.deepseek.com/v1"

    # Default model used when a user has no preference set
    DEFAULT_AI_PROVIDER: str = "anthropic"
    DEFAULT_AI_MODEL: str = "claude-3-5-sonnet-20241022"

    # -------------------------------------------------------------------------
    # Sentry
    # -------------------------------------------------------------------------
    SENTRY_DSN: str = ""

    # -------------------------------------------------------------------------
    # Resend
    # -------------------------------------------------------------------------
    RESEND_API_KEY: str = ""
    RESEND_FROM_EMAIL: str = "CV Magic <noreply@cvmagic.app>"
    APP_URL: str = "http://localhost:3000"

    # -------------------------------------------------------------------------
    # Stripe
    # -------------------------------------------------------------------------
    STRIPE_SECRET_KEY: str = ""
    STRIPE_PUBLISHABLE_KEY: str = ""
    STRIPE_WEBHOOK_SIGNING_SECRET: str = ""
    STRIPE_PRO_PRICE_ID: str = ""
    STRIPE_BILLING_SUCCESS_PATH: str = "/billing/success"
    STRIPE_BILLING_CANCEL_PATH: str = "/billing/cancel"

    # -------------------------------------------------------------------------
    # CORS
    # -------------------------------------------------------------------------
    # Accepts a JSON array string: '["http://localhost:3000"]'
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
                # Treat as a single origin
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

    @property
    def webhook_secret(self) -> str:
        """Return whichever webhook secret env var is set."""
        return self.CLERK_WEBHOOK_SECRET or self.CLERK_WEBHOOK_SIGNING_SECRET


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
