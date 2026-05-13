from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from pydantic import BaseModel


class CVVersionOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    version_number: int
    original_filename: str
    file_size_bytes: int
    word_count: Optional[int]
    is_active: bool
    is_minimal: bool
    # One-time AI categorisation of the CV's own skills, shaped as
    # {"technical": [...], "soft_skills": [...], "domain_knowledge": [...]}.
    # null while pending or if extraction failed.
    categorised_skills: Optional[Dict[str, Any]] = None
    created_at: datetime

    model_config = {"from_attributes": True}
