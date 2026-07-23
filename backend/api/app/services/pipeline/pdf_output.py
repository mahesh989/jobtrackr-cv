"""Tailored-CV PDF render + Storage upload — extracted verbatim from orchestrator.py.

ReportLab is CPU-bound, so the render+upload runs in asyncio.to_thread to keep
the event loop free. Raises on failure — the orchestrator treats a PDF failure
as non-fatal (markdown remains available) and owns the try/except + logging.
"""
from __future__ import annotations

import asyncio

from app.config import get_settings
from app.database import get_supabase
from app.db import upload_or_update
from app.services.cv.pdf_generator import generate_pdf_from_markdown


async def render_and_upload_tailored_pdf(user_id: str, run_id: str, tailored_md: str) -> str:
    """Render tailored markdown to PDF and upload to the tailored-CV bucket.

    Returns the storage path ("<user_id>/<run_id>.pdf"). Same path contract
    and upload semantics (upload → fallback to update) as before extraction.
    """
    settings = get_settings()
    supabase = get_supabase()
    pdf_path = f"{user_id}/{run_id}.pdf"

    def _render_and_upload() -> None:
        pdf_bytes = generate_pdf_from_markdown(tailored_md)
        upload_or_update(
            settings.SUPABASE_TAILORED_CV_BUCKET,
            pdf_path,
            pdf_bytes,
            "application/pdf",
            supabase=supabase,
        )

    await asyncio.to_thread(_render_and_upload)
    return pdf_path
