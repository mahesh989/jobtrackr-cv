"""Manual/service vertical — RoleFamilyProfile config."""
from __future__ import annotations

from app.services.verticals.base import RoleFamilyProfile

PROFILE = RoleFamilyProfile(
    id="manual",
    label="Manual / Service (cleaner, kitchen, warehouse, driver)",
    aliases=[
        "cleaner", "cleaning", "housekeep", "custodian", "janitor",
        "kitchen", "warehouse", "driver", "labourer", "factory",
        "sanitation", "domestic", "groundskeeper", "porter", "dishwasher",
    ],
    section_order=[
        "Summary", "Work Experience", "Skills", "Certifications & Checks", "Availability",
    ],
    skills_categories=["Core Skills", "Soft Skills", "Other Skills"],
    headline_bucket="domain_knowledge",
    cert_policy="first_class",
    injection_policy="none",
    metric_vocab=[
        "sites", "shifts", "rooms", "areas", "deliveries", "hours",
        "vehicles", "pallets", "customers",
    ],
    identity_guidance=(
        "IDENTITY: Keep it short, clear, and trustworthy. What matters: "
        "reliability, availability, and trust signals (police check, "
        "Working-with-Children check, White Card, driver/forklift licence, "
        "languages spoken, references). Do NOT keyword-stuff or pad — a clean, "
        "honest one-page CV outperforms an inflated one for these roles."
    ),
    extra_rules=(
        "- Do NOT invent or infer any skill or check. List only what the CV "
        "states.\n"
        "- A short ## Availability line (days/shifts, transport) is valuable.\n"
        "- Skip the keyword-injection game entirely; surface real experience plainly."
    ),
    keyword_weights={
        "domain_knowledge_required": 25,
        "soft_skills_required":      10,
        "technical_required":         5,
        "preferred_overall":         10,
    },
)
