"""Initial schema — all tables.

Revision ID: 001
Revises:
Create Date: 2026-04-26

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # users
    # ------------------------------------------------------------------
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("clerk_user_id", sa.String(), nullable=False, unique=True),
        sa.Column("email", sa.String(), nullable=False, unique=True),
        sa.Column("full_name", sa.String(), nullable=True),
        sa.Column("avatar_url", sa.String(), nullable=True),
        sa.Column("plan", sa.String(), nullable=False, server_default="free"),
        sa.Column("stripe_customer_id", sa.String(), nullable=True),
        sa.Column("stripe_subscription_id", sa.String(), nullable=True),
        sa.Column("analyses_used_this_month", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "quota_reset_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("date_trunc('month', now()) + interval '1 month'"),
        ),
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

    # ------------------------------------------------------------------
    # user_preferences
    # ------------------------------------------------------------------
    op.create_table(
        "user_preferences",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("ai_provider", sa.String(), nullable=False, server_default="anthropic"),
        sa.Column(
            "ai_model",
            sa.String(),
            nullable=False,
            server_default="claude-3-5-sonnet-20241022",
        ),
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

    # ------------------------------------------------------------------
    # companies
    # ------------------------------------------------------------------
    op.create_table(
        "companies",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("job_url", sa.String(), nullable=True),
        sa.Column("job_title", sa.String(), nullable=True),
        sa.Column("jd_text", sa.Text(), nullable=True),
        sa.Column("jd_hash", sa.String(), nullable=True),
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
    op.create_index("ix_companies_user_id", "companies", ["user_id"])

    # ------------------------------------------------------------------
    # cv_versions
    # ------------------------------------------------------------------
    op.create_table(
        "cv_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("storage_path", sa.String(), nullable=False),
        sa.Column("original_filename", sa.String(), nullable=False),
        sa.Column("file_size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("extracted_text", sa.Text(), nullable=True),
        sa.Column("word_count", sa.Integer(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("is_minimal", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_cv_versions_user_id", "cv_versions", ["user_id"])

    # ------------------------------------------------------------------
    # analysis_runs
    # ------------------------------------------------------------------
    op.create_table(
        "analysis_runs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "company_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("companies.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "cv_version_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("cv_versions.id"),
            nullable=False,
        ),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column(
            "step_status",
            postgresql.JSON(),
            nullable=False,
            server_default=sa.text(
                """'{"jd_analysis":"pending","cv_jd_matching":"pending","ats_scoring":"pending","input_recommendations":"pending","ai_recommendations":"pending","tailored_cv":"pending"}'"""
            ),
        ),
        sa.Column("jd_analysis_result", postgresql.JSON(), nullable=True),
        sa.Column("cv_jd_matching_result", postgresql.JSON(), nullable=True),
        sa.Column("ats_scoring_result", postgresql.JSON(), nullable=True),
        sa.Column("input_recommendations", postgresql.JSON(), nullable=True),
        sa.Column("ai_recommendations", sa.Text(), nullable=True),
        sa.Column("tailored_cv_storage_path", sa.String(), nullable=True),
        sa.Column("match_score", sa.Integer(), nullable=True),
        sa.Column("is_stale", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_analysis_runs_user_id", "analysis_runs", ["user_id"])
    op.create_index("ix_analysis_runs_company_id", "analysis_runs", ["company_id"])
    op.create_index("ix_analysis_runs_status", "analysis_runs", ["status"])

    # ------------------------------------------------------------------
    # saved_jobs
    # ------------------------------------------------------------------
    op.create_table(
        "saved_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "company_id",
            postgresql.UUID(as_uuid=True),
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


def downgrade() -> None:
    op.drop_table("saved_jobs")
    op.drop_table("analysis_runs")
    op.drop_table("cv_versions")
    op.drop_table("companies")
    op.drop_table("user_preferences")
    op.drop_table("users")
