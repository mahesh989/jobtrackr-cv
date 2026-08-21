"""Nursing vertical — RoleFamilyProfile config."""
from __future__ import annotations

from app.enums import CertPolicy, HeadlineBucket, InjectionPolicy
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
        # "Awards" is prescribed explicitly. The universal prompt routes
        # awards/recognitions under ## Certifications and relies on a
        # downstream relabel to rename that heading to ## Awards — but this
        # family now forbids a Certifications heading outright
        # (cert_policy=excluded), closing that route. Without naming Awards
        # here it lands under an unprescribed ad-hoc heading, which
        # _reorder_sections can only dump at the very end (after
        # Registration & Licences) instead of placing it.
        "Professional Summary", "Experience", "Education", "Skills",
        "Awards", "Registration & Licences",
    ],
    # skills_categories[0] is overwritten per nursing sub-type at resolve time
    # (Care Skills / Clinical Skills / Core Skills — see nursing/hooks.py);
    # "Clinical Skills" is the base default for an unclassified clinical role.
    skills_categories=["Clinical Skills", "Soft Skills", "Other Skills"],
    headline_bucket=HeadlineBucket.DOMAIN_KNOWLEDGE,
    # Health sector never gets a standalone Certifications section — a AQF
    # qualification cert (e.g. Certificate IV in Ageing Support) belongs in
    # Education, an actual registration/licence/clearance belongs in
    # Registration & Licences, and a facility training record ("Certificate
    # of Attendance"/"Certificate of Completion") isn't a portable credential
    # and is simply dropped. See _strip_certs_when_excluded.
    cert_policy=CertPolicy.EXCLUDED,
    injection_policy=InjectionPolicy.DIRECT_ONLY,
    metric_vocab=[
        "patients", "beds", "shifts", "rounds", "medications", "wait times",
        "caseload", "incidents", "compliance", "ratios", "handovers",
    ],
    identity_guidance=(
        "IDENTITY: This is a LICENSED profession. Lead with registration / "
        "licence status and mandatory clinical certifications (e.g. AHPRA "
        "registration, BLS/ACLS, manual handling) under Registration & "
        "Licences — these ARE the qualification, never bury or omit them. Do "
        "NOT create a separate Certifications section: a training/CPD "
        "certificate that isn't a registration, licence, or mandatory "
        "clearance is omitted entirely, not listed. NEVER infer or imply a "
        "clinical competency the CV does "
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
        "- Do NOT emit a `## Certifications` section for this role family, "
        "under any circumstances. Route an AQF qualification certificate "
        "(Certificate I-IV, Diploma) under Education instead, route an "
        "actual registration/licence/clearance under Registration & "
        "Licences, and omit everything else (facility training records, "
        "CPD/attendance certificates) entirely."
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

JD_ANALYSIS_HINTS = """\
VERTICAL CONTEXT — this is a NURSING / AGED-CARE / DISABILITY-CARE role.
Bucket with this field in mind:
- domain_knowledge: care settings and clinical/care knowledge — aged care,
  residential aged care, home care, community care, disability support, dementia
  care, palliative care, person-centred care, medication administration, wound
  care, infection control, manual handling, activities of daily living, personal
  care, pressure area care, continence care, mobility support.
- soft_skills: interpersonal qualities, INCLUDING cultural ones — compassion,
  empathy, teamwork, communication, patience, "working with culturally and
  linguistically diverse people" / "CALD" → cultural sensitivity (this is a SOFT
  skill, NOT domain knowledge — it describes how the worker relates to people,
  not a clinical procedure).
- technical: named care SOFTWARE / equipment only — Leecare, Manad, eMMS,
  electronic medication management system, hoists. The ACT of using them
  (medication administration, manual handling) is domain_knowledge, not technical.
"""
