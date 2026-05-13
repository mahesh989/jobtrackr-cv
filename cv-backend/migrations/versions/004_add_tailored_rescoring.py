"""Add tailored-CV re-scoring columns to analysis_runs.

Persists the deterministic re-score of the tailored CV so the API
can surface honest before/after numbers (original score, tailored
score, lift) plus the actually-injected keyword list.

Revision ID: 004
Revises: 003
Create Date: 2026-04-28

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "analysis_runs",
        sa.Column("tailored_ats_scoring_result", sa.JSON(), nullable=True),
    )
    op.add_column(
        "analysis_runs",
        sa.Column("tailored_match_score", sa.Integer(), nullable=True),
    )
    op.add_column(
        "analysis_runs",
        sa.Column("ats_lift", sa.Integer(), nullable=True),
    )
    op.add_column(
        "analysis_runs",
        sa.Column("injected_keywords", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("analysis_runs", "injected_keywords")
    op.drop_column("analysis_runs", "ats_lift")
    op.drop_column("analysis_runs", "tailored_match_score")
    op.drop_column("analysis_runs", "tailored_ats_scoring_result")
