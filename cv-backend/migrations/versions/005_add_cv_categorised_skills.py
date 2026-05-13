"""Add categorised_skills JSON column to cv_versions.

Stores a one-time, AI-extracted categorisation of the CV's own skills
into technical / soft_skills / domain_knowledge. Computed at upload
time (or via a backfill script) so the analysis detail page can
render "your CV's skills by category" without recomputing per run.

Revision ID: 005
Revises: 004
Create Date: 2026-04-28

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "cv_versions",
        sa.Column("categorised_skills", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("cv_versions", "categorised_skills")
