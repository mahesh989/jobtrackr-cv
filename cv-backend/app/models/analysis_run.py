from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, text
from sqlalchemy.dialects.postgresql import JSON, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

_DEFAULT_STEP_STATUS: Dict[str, str] = {
    "jd_analysis": "pending",
    "cv_jd_matching": "pending",
    "ats_scoring": "pending",
    "input_recommendations": "pending",
    "keyword_feasibility": "pending",
    "ai_recommendations": "pending",
    "tailored_cv": "pending",
}


class AnalysisRun(Base):
    __tablename__ = "analysis_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    company_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("companies.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    cv_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cv_versions.id"),
        nullable=False,
    )
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending", index=True)
    step_status: Mapped[Dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=lambda: dict(_DEFAULT_STEP_STATUS)
    )
    jd_analysis_result: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    cv_jd_matching_result: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    ats_scoring_result: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    input_recommendations: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    keyword_feasibility: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    ai_recommendations: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tailored_cv_storage_path: Mapped[Optional[str]] = mapped_column(String, nullable=True)
    tailored_ats_scoring_result: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    tailored_match_score: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    ats_lift: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    injected_keywords: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    match_score: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    is_stale: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )

    # Relationships removed during strip — cv-backend accesses these tables
    # via Supabase service-role REST (no SQLAlchemy joins).
