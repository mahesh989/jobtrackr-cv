from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, HttpUrl


class CompanyCreate(BaseModel):
    display_name: str
    job_url: Optional[str] = None
    job_title: Optional[str] = None
    jd_text: Optional[str] = None
    status: str = "saved"
    notes: Optional[str] = None


class CompanyUpdate(BaseModel):
    display_name: Optional[str] = None
    job_url: Optional[str] = None
    job_title: Optional[str] = None
    jd_text: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None


class CompanyOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    display_name: str
    job_url: Optional[str]
    job_title: Optional[str]
    jd_text: Optional[str]
    jd_hash: Optional[str]
    status: str
    notes: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class JDScrapeRequest(BaseModel):
    url: HttpUrl


class JDScrapeResponse(BaseModel):
    jd_text: str
    job_title: Optional[str] = None
    source_url: str
