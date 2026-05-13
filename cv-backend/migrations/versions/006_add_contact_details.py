"""Add contact_details JSON column to user_preferences.

Stores the user's contact info (name, phone, email, address, social URLs)
so the tailored CV pipeline can stamp a consistent contact line.

Revision ID: 006
Revises: 005
Create Date: 2026-04-29

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_preferences",
        sa.Column("contact_details", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("user_preferences", "contact_details")
