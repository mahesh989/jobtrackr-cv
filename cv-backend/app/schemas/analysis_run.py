from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from pydantic import BaseModel


class AnalysisRunCreate(BaseModel):
    company_id: uuid.UUID
    cv_version_id: uuid.UUID


class AnalysisRunOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    company_id: uuid.UUID
    cv_version_id: uuid.UUID
    status: str
    step_status: Dict[str, Any]
    jd_analysis_result: Optional[Dict[str, Any]] = None
    cv_jd_matching_result: Optional[Dict[str, Any]] = None
    ats_scoring_result: Optional[Dict[str, Any]] = None
    input_recommendations: Optional[Dict[str, Any]] = None
    keyword_feasibility: Optional[Dict[str, Any]] = None
    ai_recommendations: Optional[str] = None
    tailored_cv_storage_path: Optional[str] = None
    tailored_ats_scoring_result: Optional[Dict[str, Any]] = None
    tailored_match_score: Optional[int] = None
    ats_lift: Optional[int] = None
    injected_keywords: Optional[Dict[str, Any]] = None
    match_score: Optional[int] = None
    is_stale: bool
    error_message: Optional[str] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime

    model_config = {"from_attributes": True}
