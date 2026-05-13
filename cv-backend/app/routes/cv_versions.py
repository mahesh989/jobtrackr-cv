"""
CV upload and version management endpoints.

Upload flow:
1. POST /cv-versions/upload  → parse PDF, store in Supabase Storage, create CVVersion row
2. PATCH /cv-versions/{id}/activate  → mark as active (deactivates others)
3. GET  /cv-versions  → list all user CV versions ordered by version_number desc
"""
from __future__ import annotations

import io
import logging
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.core.dependencies import CurrentUser, get_current_user
from app.database import get_db, get_supabase
from app.models.cv_version import CVVersion
from app.schemas.cv_version import CVVersionOut
from app.services.ai.client import AIClientError, get_ai_client_for_user
from app.services.cv.skill_categoriser import categorise_cv_skills

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/cv-versions", tags=["cv-versions"])

_MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MB
_ALLOWED_CONTENT_TYPES = {"application/pdf", "text/plain"}


async def _extract_text_from_pdf(content: bytes) -> str:
    """Extract plain text from a PDF using pypdf (sync, run inline — small files only)."""
    try:
        import pypdf  # lazy import — not in all envs

        reader = pypdf.PdfReader(io.BytesIO(content))
        parts: list[str] = []
        for page in reader.pages:
            text = page.extract_text()
            if text:
                parts.append(text)
        return "\n".join(parts)
    except Exception as exc:
        logger.warning("PDF text extraction failed: %s", exc)
        return ""


@router.get("", response_model=list[CVVersionOut])
async def list_cv_versions(
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[CVVersionOut]:
    result = await db.execute(
        select(CVVersion)
        .where(CVVersion.user_id == current_user.id)
        .order_by(CVVersion.version_number.desc())
    )
    return [CVVersionOut.model_validate(v) for v in result.scalars().all()]


@router.post("/upload", response_model=CVVersionOut, status_code=status.HTTP_201_CREATED)
async def upload_cv(
    file: UploadFile = File(...),
    is_minimal: bool = False,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CVVersionOut:
    if file.content_type not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type: {file.content_type}. Use PDF or plain text.",
        )

    content = await file.read()
    if len(content) > _MAX_FILE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="File exceeds 10 MB limit",
        )

    # Determine next version number
    result = await db.execute(
        select(CVVersion.version_number)
        .where(CVVersion.user_id == current_user.id)
        .order_by(CVVersion.version_number.desc())
        .limit(1)
    )
    last_version = result.scalar_one_or_none() or 0
    next_version = last_version + 1

    # Extract text
    if file.content_type == "application/pdf":
        extracted_text = await _extract_text_from_pdf(content)
    else:
        extracted_text = content.decode("utf-8", errors="replace")

    word_count = len(extracted_text.split()) if extracted_text else None

    # Upload to Supabase Storage
    settings = get_settings()
    storage_path = f"{current_user.id}/cv_v{next_version}_{uuid.uuid4().hex[:8]}.pdf"

    supabase = get_supabase()
    supabase.storage.from_(settings.SUPABASE_CV_BUCKET).upload(
        path=storage_path,
        file=content,
        file_options={"content-type": file.content_type or "application/octet-stream"},
    )

    cv_version = CVVersion(
        user_id=current_user.id,
        version_number=next_version,
        storage_path=storage_path,
        original_filename=file.filename or "cv.pdf",
        file_size_bytes=len(content),
        extracted_text=extracted_text or None,
        word_count=word_count,
        is_active=False,
        is_minimal=is_minimal,
    )
    db.add(cv_version)
    await db.commit()
    await db.refresh(cv_version)

    # Best-effort one-time categorisation of CV skills.
    # Failures are non-fatal — upload still succeeds, the field stays null,
    # and a backfill script can fill it in later.
    if extracted_text:
        try:
            ai_client = await get_ai_client_for_user(current_user.id, db)
            categorised = await categorise_cv_skills(ai_client, extracted_text)
            cv_version.categorised_skills = categorised
            await db.commit()
            await db.refresh(cv_version)
        except (AIClientError, ValueError) as exc:
            logger.warning(
                "CV skill categorisation failed for cv_version %s: %s",
                cv_version.id,
                exc,
            )
        except Exception as exc:  # pragma: no cover — defensive
            logger.exception(
                "Unexpected error during CV skill categorisation for cv_version %s: %s",
                cv_version.id,
                exc,
            )

    return CVVersionOut.model_validate(cv_version)


@router.get("/{cv_version_id}", response_model=CVVersionOut)
async def get_cv_version(
    cv_version_id: uuid.UUID,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CVVersionOut:
    """Fetch a single CV version (used by the analysis page to show
    categorised CV skills)."""
    result = await db.execute(
        select(CVVersion).where(
            CVVersion.id == cv_version_id, CVVersion.user_id == current_user.id
        )
    )
    cv_version = result.scalar_one_or_none()
    if cv_version is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="CV version not found"
        )
    return CVVersionOut.model_validate(cv_version)


@router.patch("/{cv_version_id}/activate", response_model=CVVersionOut)
async def activate_cv_version(
    cv_version_id: uuid.UUID,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CVVersionOut:
    # Verify ownership
    result = await db.execute(
        select(CVVersion).where(
            CVVersion.id == cv_version_id, CVVersion.user_id == current_user.id
        )
    )
    cv_version = result.scalar_one_or_none()
    if cv_version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="CV version not found")

    # Deactivate all other versions
    await db.execute(
        update(CVVersion)
        .where(CVVersion.user_id == current_user.id, CVVersion.id != cv_version_id)
        .values(is_active=False)
    )
    cv_version.is_active = True
    await db.commit()
    await db.refresh(cv_version)
    return CVVersionOut.model_validate(cv_version)


@router.delete("/{cv_version_id}", status_code=status.HTTP_200_OK)
async def delete_cv_version(
    cv_version_id: uuid.UUID,
    current_user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(
        select(CVVersion).where(
            CVVersion.id == cv_version_id, CVVersion.user_id == current_user.id
        )
    )
    cv_version = result.scalar_one_or_none()
    if cv_version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="CV version not found")

    # Remove from storage (best-effort)
    try:
        supabase = get_supabase()
        settings = get_settings()
        supabase.storage.from_(settings.SUPABASE_CV_BUCKET).remove([cv_version.storage_path])
    except Exception as exc:
        logger.warning("Failed to remove CV file from storage: %s", exc)

    await db.delete(cv_version)
    await db.commit()
