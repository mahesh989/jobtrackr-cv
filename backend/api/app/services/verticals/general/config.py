"""General/master vertical — RoleFamilyProfile config (fallback for unknown roles)."""
from __future__ import annotations

from app.services.verticals.base import RoleFamilyProfile

PROFILE = RoleFamilyProfile(
    id="master",
    label="General (fallback)",
    aliases=[],  # never matched by alias; only the explicit/last-resort choice
    section_order=[
        "Career Highlights", "Professional Experience", "Education",
        "Skills", "Projects", "Certifications",
    ],
    skills_categories=["Technical Skills", "Soft Skills", "Other Skills"],
    cert_policy="plus",
    injection_policy="direct_only",
    metric_vocab=[
        "%", "customers", "clients", "projects", "revenue", "cost", "time",
        "teams", "stakeholders",
    ],
    identity_guidance=(
        "IDENTITY: Use the candidate's actual role titles. Surface only "
        "experience the CV truthfully supports. When unsure whether a keyword "
        "can be added honestly, leave it as a gap rather than stretch."
    ),
)
