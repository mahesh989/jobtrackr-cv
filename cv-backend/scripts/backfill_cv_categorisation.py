"""
Backfill CV skill categorisation for existing rows.

Usage (from backend dir):
    python -m scripts.backfill_cv_categorisation
    python -m scripts.backfill_cv_categorisation --dry-run
    python -m scripts.backfill_cv_categorisation --limit 5
    python -m scripts.backfill_cv_categorisation --force        # re-categorise all
    python -m scripts.backfill_cv_categorisation --user <uuid>  # only one user

Walks every cv_versions row that has extracted_text but no
categorised_skills (or all rows when --force is set), runs the
categoriser, and persists the result. Failures are logged and skipped
so one bad CV doesn't kill the whole run.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import uuid
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.cv_version import CVVersion
from app.services.ai.client import AIClientError, get_ai_client_for_user
from app.services.cv.skill_categoriser import categorise_cv_skills

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s — %(message)s"
)
logger = logging.getLogger("backfill_cv_categorisation")


async def _backfill_one(db: AsyncSession, cv: CVVersion, *, dry_run: bool) -> bool:
    """Returns True on success, False on skip/failure."""
    if not cv.extracted_text:
        logger.info("skip cv=%s — no extracted_text", cv.id)
        return False

    if dry_run:
        logger.info("[dry-run] would categorise cv=%s (user=%s)", cv.id, cv.user_id)
        return True

    try:
        ai_client = await get_ai_client_for_user(cv.user_id, db)
        categorised = await categorise_cv_skills(ai_client, cv.extracted_text)
    except (AIClientError, ValueError) as exc:
        logger.warning("failed cv=%s: %s", cv.id, exc)
        return False
    except Exception as exc:  # pragma: no cover
        logger.exception("unexpected error cv=%s: %s", cv.id, exc)
        return False

    cv.categorised_skills = categorised
    await db.commit()
    await db.refresh(cv)

    n_tech = len(categorised.get("technical", []))
    n_soft = len(categorised.get("soft_skills", []))
    n_dom = len(categorised.get("domain_knowledge", []))
    logger.info(
        "ok cv=%s — tech=%d soft=%d domain=%d", cv.id, n_tech, n_soft, n_dom
    )
    return True


async def _run(
    *,
    dry_run: bool,
    force: bool,
    limit: Optional[int],
    user_id: Optional[uuid.UUID],
) -> None:
    async with AsyncSessionLocal() as db:
        stmt = select(CVVersion).order_by(CVVersion.created_at.desc())
        if not force:
            stmt = stmt.where(CVVersion.categorised_skills.is_(None))
        if user_id is not None:
            stmt = stmt.where(CVVersion.user_id == user_id)
        if limit is not None:
            stmt = stmt.limit(limit)

        result = await db.execute(stmt)
        rows = list(result.scalars().all())

        logger.info("found %d cv_version row(s) to process", len(rows))

        ok = fail = 0
        for cv in rows:
            success = await _backfill_one(db, cv, dry_run=dry_run)
            if success:
                ok += 1
            else:
                fail += 1

        logger.info("done — ok=%d fail/skip=%d total=%d", ok, fail, len(rows))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="don't write anything")
    parser.add_argument(
        "--force", action="store_true", help="re-categorise rows that already have data"
    )
    parser.add_argument("--limit", type=int, default=None, help="process at most N rows")
    parser.add_argument(
        "--user", type=str, default=None, help="restrict to one user (UUID)"
    )
    args = parser.parse_args()

    user_id = uuid.UUID(args.user) if args.user else None

    asyncio.run(
        _run(dry_run=args.dry_run, force=args.force, limit=args.limit, user_id=user_id)
    )


if __name__ == "__main__":
    main()
