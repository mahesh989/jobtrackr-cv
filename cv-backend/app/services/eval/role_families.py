"""
Role-family config + router for the composition writer (W3).

A RoleFamilyProfile is the single source of truth for how a CV should be shaped
for a family of roles. It is consumed by the prompt assembler (composition.py)
AND by the deterministic enforcement (enforce.py), so prompt and validators
never drift.

Four families to start (the ones you prioritised): tech, nursing, manual,
master (the general fallback + base the others extend conceptually).

The router picks a family from an explicit vertical hint (the beta screen's
dropdown) first, then falls back to keyword-matching the JD analysis, then to
master.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List


@dataclass(frozen=True)
class RoleFamilyProfile:
    id: str
    label: str
    aliases: List[str]                 # router keyword match (substrings, lowercased)
    section_order: List[str]           # exact ## section order
    skills_categories: List[str]       # the 3 skills-line labels for this family
    cert_policy: str                   # "first_class" | "plus" | "rare"
    injection_policy: str              # "aggressive" | "direct_only" | "none"
    metric_vocab: List[str]            # domain metric words (for relevance/coverage)
    identity_guidance: str             # short prompt block: how to frame identity
    extra_rules: str = ""              # any family-specific rule text
    metadata: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Families
# ---------------------------------------------------------------------------

_TECH = RoleFamilyProfile(
    id="tech",
    label="IT / Tech / Data",
    aliases=[
        "data analyst", "data scientist", "data engineer", "analytics",
        "business intelligence", "bi developer", "software", "developer",
        "engineer", "machine learning", "ml ", "ai ", "devops", "it support",
        "systems analyst", "programmer", "full stack", "backend", "frontend",
        "cloud", "platform",
    ],
    section_order=[
        "Career Highlights", "Professional Experience", "Education",
        "Skills", "Projects", "Certifications",
    ],
    skills_categories=["Technical Skills", "Soft Skills", "Other Skills"],
    cert_policy="plus",          # include only when JD names the credential
    injection_policy="aggressive",  # inference allowed (worst case = awkward interview)
    metric_vocab=[
        "users", "records", "rows", "queries", "dashboards", "reports",
        "uptime", "latency", "accuracy", "models", "pipelines", "datasets",
        "%", "requests", "deployments",
    ],
    identity_guidance=(
        "IDENTITY: If the JD shows NO AI/ML signal (no LLM, model training, "
        "deep learning, computer vision, NLP, MLOps, research), suppress the "
        "candidate's AI/ML identity: use the plain role title (e.g. 'Data "
        "Analyst', not 'Data Analyst & AI Engineer'), keep AI/ML terms and "
        "AI-only projects OUT of Skills and Career Highlights, and prefer "
        "JD-aligned roles/projects over AI-evaluation/training roles. If the "
        "JD IS AI/ML-focused, lead with the AI/ML identity instead."
    ),
)

_NURSING = RoleFamilyProfile(
    id="nursing",
    label="Nursing / Healthcare",
    aliases=[
        "nurse", "nursing", "rn", "enrolled nurse", "registered nurse",
        "aged care", "midwife", "clinical", "healthcare assistant",
        "patient care", "ain", "personal care", "disability support",
    ],
    section_order=[
        "Professional Summary", "Registration & Licences", "Clinical Experience",
        "Education", "Skills", "Certifications",
    ],
    skills_categories=["Clinical Skills", "Soft Skills", "Other Skills"],
    cert_policy="first_class",   # licences/certs are the qualification — lead with them
    injection_policy="direct_only",  # NEVER infer clinical competencies (patient safety)
    metric_vocab=[
        "patients", "beds", "shifts", "rounds", "medications", "wait times",
        "caseload", "incidents", "compliance", "ratios", "handovers",
    ],
    identity_guidance=(
        "IDENTITY: This is a LICENSED profession. Lead with registration / "
        "licence status (e.g. AHPRA registration) and mandatory certifications "
        "(BLS/ACLS/manual handling) — these ARE the qualification, never bury "
        "or omit them. NEVER infer or imply a clinical competency the CV does "
        "not state; an invented clinical skill is a patient-safety and "
        "registration-fraud risk. Only surface clinical skills literally "
        "present in the CV."
    ),
    extra_rules=(
        "- Put a ## Registration & Licences section near the top listing "
        "registration body, number (if present), and expiry.\n"
        "- Certifications are first-class: include relevant clinical certs "
        "even when the JD does not name them explicitly."
    ),
)

_MANUAL = RoleFamilyProfile(
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
    cert_policy="first_class",   # police check, White Card, WWCC, forklift licence
    injection_policy="none",     # no keyword injection; honesty + clarity win here
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
)

_MASTER = RoleFamilyProfile(
    id="master",
    label="General (fallback)",
    aliases=[],  # never matched by alias; only the explicit/last-resort choice
    section_order=[
        "Career Highlights", "Professional Experience", "Education",
        "Skills", "Projects", "Certifications",
    ],
    skills_categories=["Technical Skills", "Soft Skills", "Other Skills"],
    cert_policy="plus",
    injection_policy="direct_only",  # conservative default for unknown fields
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

ROLE_FAMILIES: Dict[str, RoleFamilyProfile] = {
    f.id: f for f in (_TECH, _NURSING, _MANUAL, _MASTER)
}


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def resolve_role_family(
    vertical_hint: str | None,
    jd_analysis: Dict[str, Any] | None,
) -> RoleFamilyProfile:
    """
    Pick a role family. Priority:
      1. Explicit vertical hint that maps to a known family (beta dropdown:
         it→tech, nursing→nursing, cleaner/admin→manual, master/other→master).
      2. Keyword match of the JD job_title + required skills against aliases.
      3. master (general fallback).
    """
    hint = (vertical_hint or "").strip().lower()
    hint_map = {
        "it": "tech", "tech": "tech", "data": "tech",
        "nursing": "nursing", "health": "nursing", "healthcare": "nursing",
        "cleaner": "manual", "manual": "manual", "admin": "manual",
        "master": "master", "other": "master", "general": "master",
    }
    if hint in hint_map:
        return ROLE_FAMILIES[hint_map[hint]]
    if hint in ROLE_FAMILIES:
        return ROLE_FAMILIES[hint]

    # Keyword match against the JD.
    haystack_parts: List[str] = []
    if jd_analysis:
        haystack_parts.append(str(jd_analysis.get("job_title") or ""))
        req = jd_analysis.get("required_skills") or {}
        if isinstance(req, dict):
            for cat in ("technical", "soft_skills", "domain_knowledge"):
                haystack_parts.extend(str(x) for x in (req.get(cat) or []))
    haystack = " ".join(haystack_parts).lower()

    if haystack.strip():
        for fam in (_NURSING, _MANUAL, _TECH):  # specific before broad
            for alias in fam.aliases:
                if re.search(r"\b" + re.escape(alias.strip()), haystack):
                    return fam

    return _MASTER


def resolve_seniority(jd_analysis: Dict[str, Any] | None) -> str:
    """Map the JD seniority to a coarse overlay bucket: grad | mid | senior."""
    level = str((jd_analysis or {}).get("seniority_level") or "unknown").lower()
    if level in ("entry", "junior", "graduate"):
        return "grad"
    if level in ("senior", "lead", "principal", "staff", "manager", "director"):
        return "senior"
    return "mid"
