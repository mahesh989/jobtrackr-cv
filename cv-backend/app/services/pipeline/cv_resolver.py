"""
Resolve which CV text to use for an analysis run.

Rule:
- Use the CV referenced by run.cv_version_id.
- If that CV row's `extracted_text` is populated, use it directly.
- Otherwise, raise — uploads always extract text at upload time, so a
  missing extracted_text indicates a corrupt or unparsable file.
"""
from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.analysis_run import AnalysisRun
from app.models.cv_version import CVVersion

logger = logging.getLogger(__name__)


class CVResolutionError(Exception):
    """Raised when we cannot obtain CV text for an analysis run."""


async def resolve_cv_text(db: AsyncSession, run: AnalysisRun) -> str:
    """Return the CV plain-text to feed to the pipeline."""
    result = await db.execute(
        select(CVVersion).where(CVVersion.id == run.cv_version_id)
    )
    cv_version = result.scalar_one_or_none()
    if cv_version is None:
        raise CVResolutionError(
            f"CV version {run.cv_version_id} not found for run {run.id}"
        )

    if not cv_version.extracted_text or not cv_version.extracted_text.strip():
        raise CVResolutionError(
            f"CV version {cv_version.id} has no extracted text — "
            "the file may be corrupt or scanned. Re-upload a text-based PDF."
        )

    return cv_version.extracted_text
