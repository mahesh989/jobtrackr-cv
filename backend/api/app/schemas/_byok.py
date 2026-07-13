"""Shared schema components — reusable Pydantic mixins."""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field

from app.enums import Provider


class BYOK(BaseModel):
    """Bring-Your-Own-Key fields — repeated in every AI-calling request schema."""
    ai_provider: Provider
    ai_api_key:  str = Field(min_length=1)
    ai_model:    Optional[str] = None
