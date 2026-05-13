"""Add keyword_feasibility JSON column to analysis_runs.

Stores the Step 4.5 feasibility classifier output: which missed JD
keywords can be legitimately injected into the tailored CV, which
need bullet rewording, and which are honest gaps.

Revision ID: 003
Revises: 002
Create Date: 2026-04-28

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "analysis_runs",
        sa.Column("keyword_feasibility", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("analysis_runs", "keyword_feasibility")
