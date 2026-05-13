"""
User profile & preference endpoints.
All routes require a valid Clerk JWT.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import CurrentUser, get_current_user
from app.database import get_db
from app.models.user import User
from app.models.user_preference import UserPreference
from app.schemas.user import UserOut, UserUpdateRequest

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/users", tags=["users"])


@router.get("/me", response_model=UserOut)
async def get_me(
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserOut:
    """Return the authenticated user's profile."""
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one()
    return UserOut.model_validate(user)


@router.patch("/me", response_model=UserOut)
async def update_me(
    body: UserUpdateRequest,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UserOut:
    """Update mutable profile fields (full_name, avatar_url)."""
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one()

    if body.full_name is not None:
        user.full_name = body.full_name
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url

    await db.commit()
    await db.refresh(user)
    return UserOut.model_validate(user)


class PreferenceOut(UserOut.__class__):
    pass


from pydantic import BaseModel  # noqa: E402 — local import to keep file self-contained


class Project(BaseModel):
    name: str
    url: str
    description: Optional[str] = None


class ContactDetails(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    address: Optional[str] = None
    linkedin: Optional[str] = None
    github: Optional[str] = None
    website: Optional[str] = None
    portfolio: Optional[str] = None
    other_label: Optional[str] = None
    other_url: Optional[str] = None
    projects: Optional[list[Project]] = None


class PreferenceResponse(BaseModel):
    ai_provider: str
    ai_model: str
    email_on_complete: bool
    contact_details: Optional[ContactDetails] = None

    model_config = {"from_attributes": True}


class PreferenceUpdateRequest(BaseModel):
    ai_provider: Optional[str] = None
    ai_model: Optional[str] = None
    email_on_complete: Optional[bool] = None
    contact_details: Optional[ContactDetails] = None


@router.get("/me/preferences", response_model=PreferenceResponse)
async def get_preferences(
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PreferenceResponse:
    result = await db.execute(
        select(UserPreference).where(UserPreference.user_id == current_user.id)
    )
    pref = result.scalar_one()
    return PreferenceResponse.model_validate(pref)


@router.patch("/me/preferences", response_model=PreferenceResponse)
async def update_preferences(
    body: PreferenceUpdateRequest,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PreferenceResponse:
    result = await db.execute(
        select(UserPreference).where(UserPreference.user_id == current_user.id)
    )
    pref = result.scalar_one()

    if body.ai_provider is not None:
        pref.ai_provider = body.ai_provider
    if body.ai_model is not None:
        pref.ai_model = body.ai_model
    if body.email_on_complete is not None:
        pref.email_on_complete = body.email_on_complete
    if body.contact_details is not None:
        # Strip empty scalar strings but preserve non-empty lists (e.g. projects)
        cd = body.contact_details.model_dump()
        pref.contact_details = {
            k: v for k, v in cd.items()
            if (isinstance(v, list) and v) or (not isinstance(v, list) and v)
        }

    await db.commit()
    await db.refresh(pref)
    return PreferenceResponse.model_validate(pref)
