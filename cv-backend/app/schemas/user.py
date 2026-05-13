from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, EmailStr


class UserOut(BaseModel):
    id: uuid.UUID
    clerk_user_id: str
    email: Optional[str]
    full_name: Optional[str]
    avatar_url: Optional[str]
    plan: str
    analyses_used_this_month: int
    quota_reset_at: datetime
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserUpdateRequest(BaseModel):
    full_name: Optional[str] = None
    avatar_url: Optional[str] = None
