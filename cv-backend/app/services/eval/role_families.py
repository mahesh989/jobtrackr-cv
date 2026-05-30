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
    # Verified equivalences: (jd_facing_term, [cv_terms_that_justify_it], category).
    # A small, curated, per-family slice of a skill ontology. When the JD wants
    # jd_facing_term and the CV literally contains one of the justifying terms,
    # the term may be surfaced honestly (synonym or child→parent tool inference —
    # NEVER a domain claim the CV doesn't support). category ∈
    # {technical, soft_skills, domain_knowledge}.
    equivalences: List[tuple] = field(default_factory=list)
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
    equivalences=[
        # child→parent (always honest: knowing the specific implies the general)
        ("SQL", ["postgresql", "postgres", "mysql", "sql server", "t-sql",
                 "pl/sql", "sqlite", "oracle", "mariadb"], "technical"),
        ("Relational Databases", ["postgresql", "mysql", "sql server",
                                  "oracle", "sqlite", "mariadb"], "technical"),
        ("NoSQL", ["mongodb", "cassandra", "dynamodb", "redis", "couchbase"], "technical"),
        ("Cloud", ["aws", "azure", "gcp", "google cloud"], "technical"),
        ("CI/CD", ["github actions", "gitlab ci", "jenkins", "circleci", "travis"], "technical"),
        ("Data Visualisation", ["power bi", "tableau", "looker", "matplotlib",
                                "seaborn", "plotly", "qlik"], "technical"),
        # user-approved tool inference: CV has SQL → JD's PostgreSQL is defensible
        ("PostgreSQL", ["sql", "postgres", "psql"], "technical"),
    ],
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
        "present in the CV.\n"
        "MEDICATION COMPETENCY is a key differentiator in care roles: if the CV "
        "shows medication assistance/administration (especially via electronic "
        "systems or a medication-competency cert), surface it prominently — name "
        "it in the summary AND lead the relevant role with it. It puts the "
        "candidate ahead of a basic-care applicant. (Only if the CV genuinely "
        "shows it — never imply medication authority the candidate lacks.)\n"
        "BREADTH OVER BARE YEARS: when total experience is short (<2 years) but "
        "the candidate has held several roles or worked across multiple care "
        "settings/providers, frame the summary by that BREADTH (e.g. "
        "'experience across multiple residential aged care settings') rather "
        "than leading with a small year count that undersells them. Never "
        "inflate the number or the seniority."
    ),
    extra_rules=(
        "- Include a ## Registration & Licences section ONLY if the CV actually "
        "states a real registration, licence, or clearance (e.g. AHPRA "
        "registration, police check, NDIS Worker Screening, Working with "
        "Children Check, driver licence, first aid / CPR). List only the ones "
        "the CV genuinely contains, with number/expiry if given. If the CV has "
        "NONE of these, OMIT the section entirely — NEVER write 'eligible to "
        "work in Australia', 'available on request', or that a credential is "
        "missing. Stating eligibility or absence is nonsense on a CV.\n"
        "- Certifications are first-class: include relevant clinical certs "
        "even when the JD does not name them explicitly."
    ),
    equivalences=[
        # TRUE SYNONYMS only — surfacing the same thing under the JD's vocabulary,
        # never inferring a clinical competency the CV doesn't state.
        ("Aged Care", ["ageing support", "aged care", "elderly care",
                       "residential aged care"], "domain_knowledge"),
        ("Activities of Daily Living", ["activities of daily living", "adls",
                                        "personal care", "showering", "dressing"], "domain_knowledge"),
        ("Person-Centred Care", ["person-centred care", "person centered care",
                                 "individualised care"], "domain_knowledge"),
    ],
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

    # Keyword match against the JD. We search the structured skill arrays AND
    # the free-text fields (job_title / summary / responsibilities) because the
    # JD analyser often returns a title like "Assistant in Nursing" whose alias
    # ("ain", "aged care") never appears verbatim in the skill arrays — the
    # signal lives in the summary/responsibilities prose instead.
    haystack_parts: List[str] = []
    if jd_analysis:
        haystack_parts.append(str(jd_analysis.get("job_title") or ""))
        haystack_parts.append(str(jd_analysis.get("summary") or ""))
        resp = jd_analysis.get("responsibilities") or []
        if isinstance(resp, list):
            haystack_parts.extend(str(x) for x in resp)
        else:
            haystack_parts.append(str(resp))
        for block in ("required_skills", "preferred_skills"):
            skills = jd_analysis.get(block) or {}
            if isinstance(skills, dict):
                for cat in ("technical", "soft_skills", "domain_knowledge"):
                    haystack_parts.extend(str(x) for x in (skills.get(cat) or []))
    haystack = " ".join(haystack_parts).lower()

    if haystack.strip():
        for fam in (_NURSING, _MANUAL, _TECH):  # specific before broad
            for alias in fam.aliases:
                if re.search(r"\b" + re.escape(alias.strip()), haystack):
                    return fam

    return _MASTER


_CATEGORY_KEYS = ("technical", "soft_skills", "domain_knowledge")


def category_labels(rf: RoleFamilyProfile) -> Dict[str, str]:
    """
    Map the internal skill-category keys to the family's display labels. The
    internal keys (technical / soft_skills / domain_knowledge) stay stable
    everywhere; only the user-facing label changes per family. category_labels
    is positional on RoleFamilyProfile.skills_categories:
        technical        → skills_categories[0]  (Clinical Skills / Technical
                                                   Skills / Core Skills)
        soft_skills      → skills_categories[1]
        domain_knowledge → skills_categories[2]
    """
    cats = list(rf.skills_categories) + ["Technical Skills", "Soft Skills", "Other Skills"]
    return {key: cats[i] for i, key in enumerate(_CATEGORY_KEYS)}


def resolve_seniority(jd_analysis: Dict[str, Any] | None) -> str:
    """Map the JD seniority to a coarse overlay bucket: grad | mid | senior."""
    level = str((jd_analysis or {}).get("seniority_level") or "unknown").lower()
    if level in ("entry", "junior", "graduate"):
        return "grad"
    if level in ("senior", "lead", "principal", "staff", "manager", "director"):
        return "senior"
    return "mid"


def apply_equivalences(
    feasibility: Dict[str, Any] | None,
    cv_text: str,
    jd_text: str,
    rf: RoleFamilyProfile,
) -> Dict[str, Any]:
    """
    W8.3 — deterministically promote JD terms to inject_directly when the role
    family's verified equivalence table says the CV honestly justifies them.

    A term is surfaced only when ALL hold:
      • the family allows injection (policy != "none"),
      • the JD actually wants the term (it appears in the JD text),
      • the CV literally contains one of the justifying terms,
      • the term isn't already in the inject list.

    The promoted entry uses the skills-section injection shape so the existing
    deterministic injector (_inject_missing_skills) lands it. Replaces the
    over-permissive AI feasibility guessing with verified, config-driven
    surfacing (no per-case tokens). Returns the (mutated) feasibility dict.
    """
    if feasibility is None:
        return feasibility
    if rf.injection_policy == "none" or not rf.equivalences:
        return feasibility

    cv_l = (cv_text or "").lower()
    jd_l = (jd_text or "").lower()
    plan = feasibility.setdefault("feasibility_plan", {})
    inject = plan.setdefault("inject_directly", [])
    if not isinstance(inject, list):
        return feasibility

    existing = {
        str(e.get("keyword", "")).lower()
        for e in inject if isinstance(e, dict)
    }
    added: List[str] = []
    for jd_term, cv_terms, category in rf.equivalences:
        key = jd_term.lower()
        if key in existing:
            continue
        if key not in jd_l:
            continue  # the JD doesn't ask for it → no ATS value in surfacing
        if not any(
            re.search(r"\b" + re.escape(t.lower()) + r"\b", cv_l) for t in cv_terms
        ):
            continue  # the CV doesn't honestly justify it
        inject.append({
            "keyword": jd_term,
            "category": category,
            "injection_target": "skills_section",
            "source": "equivalence",
        })
        existing.add(key)
        added.append(jd_term)

    if added:
        feasibility.setdefault("_equivalences_added", []).extend(added)
    return feasibility
