"""Move job tracker fields onto companies; drop saved_jobs.

Revision ID: 007
Revises: 006
Create Date: 2026-05-01

"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "companies",
        sa.Column("status", sa.String(), nullable=False, server_default="saved"),
    )
    op.add_column(
        "companies",
        sa.Column("notes", sa.Text(), nullable=True),
    )

    # Backfill from saved_jobs (last-write-wins per company_id).
    # If multiple SavedJob rows point at the same company, pick the most recently
    # updated row (fall back to created_at ordering).
    op.execute(
        sa.text(
            """
            UPDATE companies AS c
            SET status = sj.status,
                notes = sj.notes
            FROM (
              SELECT DISTINCT ON (company_id)
                company_id,
                status,
                notes
              FROM saved_jobs
              WHERE company_id IS NOT NULL
              ORDER BY company_id,
                       updated_at DESC NULLS LAST,
                       created_at DESC
            ) AS sj
            WHERE c.id = sj.company_id
            """
        )
    )

    op.drop_index("ix_saved_jobs_company_id", table_name="saved_jobs")
    op.drop_index("ix_saved_jobs_user_id", table_name="saved_jobs")
    op.drop_table("saved_jobs")


def downgrade() -> None:
    # Recreate saved_jobs table (data loss on downgrade is acceptable).
    op.create_table(
        "saved_jobs",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "company_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("companies.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("company_name", sa.String(), nullable=False),
        sa.Column("job_title", sa.String(), nullable=True),
        sa.Column("job_url", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False, server_default="saved"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_saved_jobs_user_id", "saved_jobs", ["user_id"])
    op.create_index("ix_saved_jobs_company_id", "saved_jobs", ["company_id"])

    op.drop_column("companies", "notes")
    op.drop_column("companies", "status")

