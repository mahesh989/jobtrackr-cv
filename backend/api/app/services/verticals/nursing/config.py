"""Nursing vertical — RoleFamilyProfile config."""
from __future__ import annotations

from app.services.verticals.base import RoleFamilyProfile

PROFILE = RoleFamilyProfile(
    id="nursing",
    label="Nursing / Healthcare",
    aliases=[
        "nurse", "nursing", "rn", "enrolled nurse", "registered nurse",
        "aged care", "midwife", "clinical", "healthcare assistant",
        "patient care", "ain", "personal care", "disability support",
        "care worker", "support worker", "care assistant", "carer",
        "individual support", "home care", "community care", "aged care worker",
        "personal care worker", "nursing assistant",
    ],
    section_order=[
        "Professional Summary", "Experience", "Education", "Skills",
        "Certifications", "Registration & Licences",
    ],
    # skills_categories[0] is overwritten per nursing sub-type at resolve time
    # (Care Skills / Clinical Skills / Core Skills — see nursing/hooks.py);
    # "Clinical Skills" is the base default for an unclassified clinical role.
    skills_categories=["Clinical Skills", "Soft Skills", "Other Skills"],
    headline_bucket="domain_knowledge",
    cert_policy="first_class",
    injection_policy="direct_only",
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
        ("Aged Care", ["ageing support", "aged care", "elderly care",
                       "residential aged care"], "domain_knowledge"),
        ("Activities of Daily Living", ["activities of daily living", "adls",
                                        "personal care", "showering", "dressing"], "domain_knowledge"),
        ("Person-Centred Care", ["person-centred care", "person centered care",
                                 "individualised care"], "domain_knowledge"),
    ],
    keyword_weights={
        "domain_knowledge_required": 25,
        "soft_skills_required":      10,
        "technical_required":         5,
        "preferred_overall":         10,
    },
)
