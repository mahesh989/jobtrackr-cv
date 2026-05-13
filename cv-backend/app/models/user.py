from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Integer, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    clerk_user_id: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    full_name: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    avatar_url: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    plan: Mapped[str] = mapped_column(String, nullable=False, default="free")
    stripe_customer_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    stripe_subscription_id: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    analyses_used_this_month: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    quota_reset_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("date_trunc('month', now()) + interval '1 month'"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=text("now()"),
        onupdate=datetime.utcnow,
    )

    # Relationships
    preferences: Mapped[Optional["UserPreference"]] = relationship(  # noqa: F821
        "UserPreference", back_populates="user", uselist=False, lazy="select"
    )
    companies: Mapped[list["Company"]] = relationship(  # noqa: F821
        "Company", back_populates="user", lazy="select"
    )
    cv_versions: Mapped[list["CVVersion"]] = relationship(  # noqa: F821
        "CVVersion", back_populates="user", lazy="select"
    )
    analysis_runs: Mapped[list["AnalysisRun"]] = relationship(  # noqa: F821
        "AnalysisRun", back_populates="user", lazy="select"
    )
