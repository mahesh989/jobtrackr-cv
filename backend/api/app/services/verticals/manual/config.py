"""Manual/service vertical — RoleFamilyProfile config."""
from __future__ import annotations

from app.enums import CertPolicy, HeadlineBucket, InjectionPolicy
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
    headline_bucket=HeadlineBucket.DOMAIN_KNOWLEDGE,
    cert_policy=CertPolicy.FIRST_CLASS,
    injection_policy=InjectionPolicy.NONE,
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

JD_ANALYSIS_HINTS = """\
VERTICAL CONTEXT — this is a CLEANING / MANUAL / TRADES role.
Bucket with this field in mind:
- domain_knowledge: cleaning knowledge and compliance — commercial cleaning,
  deep cleaning, bathroom cleaning, vacuuming, mopping, dusting, waste
  management, chemical handling, PPE use, infection control, WHS / work health
  and safety, food safety.
- technical: named EQUIPMENT only — floor scrubber, polisher, industrial
  cleaning machine, pressure washer, forklift, EWP. The ACT of cleaning is
  domain_knowledge, not technical.
- soft_skills: cross-role behaviours — reliability, attention to detail,
  working autonomously, following instructions, time management, teamwork.
"""
