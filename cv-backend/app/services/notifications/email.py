"""
Transactional email via Resend.

Resend is called over its REST API with httpx — no SDK dependency, just an
API key. Sending is fire-and-forget from the caller's point of view: errors
are logged but never re-raised, so a failed email never breaks the pipeline.
"""
from __future__ import annotations

import logging
from typing import Optional

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

_RESEND_URL = "https://api.resend.com/emails"
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


async def _send(
    *,
    to: str,
    subject: str,
    html: str,
    text: Optional[str] = None,
) -> bool:
    """Low-level send. Returns True on success, False otherwise.

    Silently no-ops (returns False) when RESEND_API_KEY is not configured —
    useful for local dev where we don't want to wire up Resend.
    """
    settings = get_settings()
    if not settings.RESEND_API_KEY:
        logger.info("Resend not configured — skipping email to %s", to)
        return False

    payload = {
        "from": settings.RESEND_FROM_EMAIL,
        "to": [to],
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(
                _RESEND_URL,
                headers={
                    "Authorization": f"Bearer {settings.RESEND_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
            if resp.status_code >= 400:
                logger.warning(
                    "Resend send failed (%s) to %s: %s",
                    resp.status_code,
                    to,
                    resp.text[:500],
                )
                return False
    except httpx.HTTPError as e:
        logger.warning("Resend HTTP error for %s: %s", to, e)
        return False

    logger.info("Resend email sent to %s (subject=%r)", to, subject)
    return True


async def send_analysis_complete(
    *,
    to_email: str,
    full_name: Optional[str],
    company_name: str,
    job_title: Optional[str],
    match_score: Optional[int],
    run_id: str,
) -> bool:
    """Notify the user that a pipeline run finished successfully."""
    settings = get_settings()
    name = (full_name or "").split(" ")[0] if full_name else "there"
    role = f"{job_title} at {company_name}" if job_title else company_name
    score_line = (
        f"Your tailored CV scored <strong>{match_score}%</strong> against this role."
        if match_score is not None
        else "Your tailored CV is ready."
    )
    score_line_text = (
        f"Your tailored CV scored {match_score}% against this role."
        if match_score is not None
        else "Your tailored CV is ready."
    )
    link = f"{settings.APP_URL.rstrip('/')}/analysis/{run_id}"

    html = f"""\
<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;
                  max-width:560px;margin:2rem auto;padding:0 1.25rem;line-height:1.55;color:#111;">
  <h2 style="margin-bottom:0.25rem;">Hi {name},</h2>
  <p>Your CV Magic analysis for <strong>{role}</strong> is complete.</p>
  <p>{score_line}</p>
  <p style="margin:1.5rem 0;">
    <a href="{link}"
       style="background:#111;color:#fff;text-decoration:none;
              padding:0.6rem 1rem;border-radius:6px;display:inline-block;">
      View results
    </a>
  </p>
  <p style="font-size:0.85rem;color:#666;">
    Don't want these emails? Turn them off in
    <a href="{settings.APP_URL.rstrip('/')}/settings">Settings</a>.
  </p>
</body></html>
"""
    text = (
        f"Hi {name},\n\n"
        f"Your CV Magic analysis for {role} is complete.\n"
        f"{score_line_text}\n\n"
        f"View results: {link}\n\n"
        f"Manage email preferences: {settings.APP_URL.rstrip('/')}/settings\n"
    )

    return await _send(
        to=to_email,
        subject=f"Your CV analysis for {company_name} is ready",
        html=html,
        text=text,
    )
