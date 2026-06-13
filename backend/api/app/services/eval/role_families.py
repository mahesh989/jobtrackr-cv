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
from dataclasses import dataclass, field, replace
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
    # Which internal bucket carries this family's HEADLINE competencies, i.e.
    # the bucket that should wear skills_categories[0]. The CV/JD categoriser
    # files software/tools/platforms under "technical" and industry/process/
    # clinical knowledge under "domain_knowledge". For tech roles the headline
    # is the technical bucket; for nursing/manual the headline is the domain
    # bucket (clinical/care competencies), and "technical" (e.g. BESTMed) is
    # the secondary "Other Skills" bucket.
    headline_bucket: str = "technical"  # "technical" | "domain_knowledge"
    # Verified equivalences: (jd_facing_term, [cv_terms_that_justify_it], category).
    # A small, curated, per-family slice of a skill ontology. When the JD wants
    # jd_facing_term and the CV literally contains one of the justifying terms,
    # the term may be surfaced honestly (synonym or child→parent tool inference —
    # NEVER a domain claim the CV doesn't support). category ∈
    # {technical, soft_skills, domain_knowledge}.
    equivalences: List[tuple] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    # Per-family ATS keyword weights — sum to 50 (the Keyword Match half of the
    # 100-point ATS score). Tech defaults: technical 25 / soft 10 / domain 5 /
    # preferred 10 (BI/SQL/cloud tools dominate). Nursing/manual flip technical
    # ↔ domain because the headline competencies live in domain_knowledge.
    # If a family does not set this, ats_scoring.py falls back to the tech
    # defaults below.
    keyword_weights: Dict[str, int] = field(default_factory=lambda: {
        "technical_required":        25,
        "soft_skills_required":      10,
        "domain_knowledge_required":  5,
        "preferred_overall":         10,
    })


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
        "IDENTITY SCAN — run FIRST, before deciding anything else. Count "
        "AI/ML signal words in the JD: LLM, GPT, Claude, transformer, RAG, "
        "embedding, deep learning, neural network, computer vision, NLP, "
        "PyTorch, TensorFlow, scikit-learn, ML model, AI engineer, ML "
        "engineer, AI/ML, machine learning, model training, fine-tuning, "
        "MLOps, research, publication. Pick ONE mode for the entire output:\n"
        "  • Signal count ≥ 2 → AI-FORWARD MODE. Lead with AI/ML identity; "
        "keep AI projects/bullets/skills.\n"
        "  • Signal count = 0 → AI-SUPPRESSED MODE (HARD). Identity is the "
        "JD's single base title (e.g. 'Data Analyst', 'Software Engineer'), "
        "NEVER a hybrid. Drop the AI/ML half from BOTH the summary opener "
        "AND every Experience role title — even if the source CV chains "
        "them as 'X & AI Engineer'. Drop AI vocabulary (LLM, model "
        "training, deep learning, CV/NLP, fine-tuning) from Career "
        "Highlights entirely. Drop AI-only frameworks (PyTorch, TensorFlow, "
        "scikit-learn, Hugging Face) from Skills. Prefer JD-aligned "
        "roles/projects over AI-evaluation/training roles.\n"
        "  • Signal count = 1 → JUDGEMENT CALL. Default to suppression "
        "unless the single signal is core to the JD's primary methodology.\n"
        "Once Mode is picked, it controls every downstream choice."
    ),
    extra_rules=(
        "PROJECT RANKING (HARD) — rank every CV project by three keys, in "
        "this order: (1) Q2 = tech-stack match to the JD, (2) Q1 = domain "
        "match to the JD, (3) headline metrics. Q2 = yes ALWAYS outranks "
        "Q2 = no, regardless of how impressive the no-match project's "
        "numbers are. A SQL/ETL project with '30% time saved' outranks an "
        "ML project with '92% accuracy' when the JD is SQL/Power BI. Among "
        "Q2 = no projects, Q1 = yes outranks Q1 = no. Headline metrics "
        "break ties ONLY when relevance is equal. Pick the top 2 from that "
        "ranking; never let metric flash decide above relevance.\n\n"
        "PROJECT RANKING — worked example: JD is SQL/Power BI Data Analyst. "
        "Candidate projects: [CV Agent (Flutter, Multi-LLM), YOLOv8 (PyTorch, "
        "Computer Vision, 92% accuracy), SQL Pipeline (SQL, PostgreSQL, ETL, "
        "30% time saved)]. Rank: SQL Pipeline (Q2=yes — direct stack hit) "
        "beats every Q2=no project, including YOLOv8 despite the 92%. CV "
        "Agent (Q2=no but has full-stack/scale framing) > YOLOv8 (Q2=no, "
        "pure CV). Output: SQL Pipeline first, CV Agent second.\n\n"
        "TECHNICAL SKILLS LINE — may use ` | ` separators for up to 3 "
        "logical sub-groups when there are ≥9 technical entries (languages "
        "| BI tools | cloud). One space on EACH side of the pipe; the "
        "separator is ASCII U+007C, never capital I or lowercase l — those "
        "break ATS parsing. Example: 'Python, SQL, R | Power BI, Tableau | "
        "AWS, Snowflake'. With fewer than 9 entries, write a single comma "
        "list — do not force sub-groups when there is nothing to group.\n\n"
        "SKILLS NUMERIC CAPS (HARD): Technical Skills 10-14 entries, Soft "
        "Skills 4-6 entries, Other Skills 5-8 entries. When the candidate's "
        "raw skill set exceeds a cap, drop the LEAST JD-relevant items "
        "first, never the most relevant. Padding to hit a count is "
        "forbidden.\n\n"
        "SKILLS MINIMUM FLOOR (HARD): at least 5 total entries across all "
        "three lines after JD-relevance filtering. If filtering leaves "
        "fewer than 5, pad Technical Skills with the candidate's most "
        "impactful tools (even if not in the JD) until the total reaches "
        "5. Never pad with irrelevant skills beyond the floor.\n\n"
        "CATEGORY PLACEMENT (HARD): methodologies and domain terms go in "
        "**Other Skills**, never Technical. Technical = languages, "
        "libraries, platforms, databases, BI tools, cloud services, ML "
        "frameworks ONLY. 'Predictive Analytics', 'Statistical Analysis', "
        "'ETL Pipelines', 'A/B Testing', 'Data Warehousing', 'Marketing "
        "Analytics', 'Stakeholder Management' → Other Skills. Never "
        "duplicate a skill across two lines.\n\n"
        "CAREER HIGHLIGHTS PRE-WRITE 7-STEP CHECK — before emitting the "
        "summary, internally verify all of: (1) S1 word count ≤ 28? (2) S2 "
        "word count ≤ 22? (3) Total 35-50? (4) Either sentence names a "
        "tool (Python, SQL, Power BI, PostgreSQL, AWS)? If yes, replace "
        "the tool name with the method/outcome the tool enabled. (5) Does "
        "S2 contain a number or named deliverable? (6) If 2+ Experience "
        "roles kept, does S2 contain TWO clauses joined by a semicolon, "
        "one anchored to each top role? (7) Any seniority word in S1 "
        "(Senior/Lead/Principal/Manager) actually present in the "
        "candidate's CV titles? Only emit Career Highlights after all 7 "
        "pass."
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
        "care worker", "support worker", "care assistant", "carer",
        "individual support", "home care", "community care", "aged care worker",
        "personal care worker", "nursing assistant",
    ],
    section_order=[
        "Professional Summary", "Experience", "Education", "Skills",
        "Certifications", "Registration & Licences",
    ],
    # skills_categories[0] is overwritten per nursing sub-type at resolve time
    # (Care Skills / Clinical Skills / Core Skills — see _apply_nursing_subtype);
    # "Clinical Skills" is the base default for an unclassified clinical role.
    skills_categories=["Clinical Skills", "Soft Skills", "Other Skills"],
    headline_bucket="domain_knowledge",  # clinical competencies live in domain_knowledge
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
    # Nursing flips technical ↔ domain weighting. Clinical/care competencies
    # (Personal Care, Dementia Care, Medication Administration) live in the
    # domain_knowledge bucket — those ARE the role. Tools (BESTMed, MedMobile)
    # are nice-to-have, not the qualification. Sums to 50 like tech (same
    # keyword-match budget; only the per-bucket distribution differs).
    keyword_weights={
        "domain_knowledge_required": 25,
        "soft_skills_required":      10,
        "technical_required":         5,
        "preferred_overall":         10,
    },
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
    headline_bucket="domain_knowledge",  # hands-on/process competencies live in domain_knowledge
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
    # Manual roles match nursing's weighting: core competencies (cleaning,
    # forklift operation, kitchen prep) sit in domain_knowledge; "technical"
    # is mostly empty. Sums to 50 like tech.
    keyword_weights={
        "domain_knowledge_required": 25,
        "soft_skills_required":      10,
        "technical_required":         5,
        "preferred_overall":         10,
    },
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


# Australian nursing / care taxonomy. Unregulated assistant/care roles lead with
# hands-on "Care Skills"; registered/licensed clinicians lead with "Clinical
# Skills". Anything nursing we can't confidently classify falls back to a neutral
# "Core Skills". Signals are matched on word boundaries (so "ain" matches the
# acronym AIN, not "again"). AIN and Care Worker are the same family.
_NURSING_CARE_SIGNALS = (
    "assistant in nursing", "ain", "personal care worker", "personal care assistant",
    "personal care", "care worker", "care assistant", "aged care worker",
    "home care", "community care", "individual support", "disability support",
    "support worker", "carer", "nursing assistant", "patient care assistant",
    "care companion", "aged care",
)
_NURSING_CLINICAL_SIGNALS = (
    "registered nurse", "enrolled nurse", "clinical nurse", "nurse practitioner",
    "midwife", "mental health nurse", "intensive care", "icu", "theatre nurse",
    "emergency nurse", "perioperative", "graduate nurse", "division 1",
    "division 2", "rn", "en", "cns", "cnc",
)
_NURSING_SUBTYPE_LABEL = {"care": "Care Skills", "clinical": "Clinical Skills"}


def _nursing_subtype(jd_analysis: Dict[str, Any] | None) -> str:
    """
    Classify a nursing JD as 'care' (unregulated assistant/care roles),
    'clinical' (registered/licensed clinicians), or 'unknown'. The job title is
    the strongest signal and decides outright when it carries one; otherwise we
    count signal hits across the summary + responsibilities prose.
    """
    def _hit(text: str, signals: tuple) -> int:
        return sum(
            1 for s in signals
            if re.search(r"\b" + re.escape(s) + r"\b", text)
        )

    # Registration is the defining identity: a "Registered/Enrolled Nurse" title
    # is clinical even when it also names a care SETTING ("aged care"), so the
    # clinical check runs before the care check on the title.
    title = str((jd_analysis or {}).get("job_title") or "").lower()
    if _hit(title, _NURSING_CLINICAL_SIGNALS):
        return "clinical"
    if _hit(title, _NURSING_CARE_SIGNALS):
        return "care"

    parts: List[str] = [str((jd_analysis or {}).get("summary") or "")]
    resp = (jd_analysis or {}).get("responsibilities") or []
    if isinstance(resp, list):
        parts.extend(str(x) for x in resp)
    else:
        parts.append(str(resp))
    blob = " ".join(parts).lower()
    care, clinical = _hit(blob, _NURSING_CARE_SIGNALS), _hit(blob, _NURSING_CLINICAL_SIGNALS)
    if care > clinical:
        return "care"
    if clinical > care:
        return "clinical"
    return "unknown"


def _apply_nursing_subtype(
    rf: RoleFamilyProfile,
    jd_analysis: Dict[str, Any] | None,
) -> RoleFamilyProfile:
    """
    For the nursing family, overwrite the headline skills label (skills_categories[0])
    with the sub-type-appropriate one — "Care Skills" for care roles, "Clinical
    Skills" for clinicians, "Core Skills" when unclassified — keeping id="nursing"
    so the W8 canonical sandwich (_TO_CANONICAL["nursing"]) still applies. No-op
    for every other family.
    """
    if rf.id != "nursing":
        return rf
    subtype = _nursing_subtype(jd_analysis)
    headline = _NURSING_SUBTYPE_LABEL.get(subtype, "Core Skills")
    cats = list(rf.skills_categories)
    cats[0] = headline
    return replace(
        rf,
        skills_categories=cats,
        metadata={**rf.metadata, "nursing_subtype": subtype},
    )


def resolve_role_family(
    vertical_hint: str | None,
    jd_analysis: Dict[str, Any] | None,
) -> RoleFamilyProfile:
    """
    Pick a role family, then apply the nursing sub-type overlay so the headline
    skills label matches the specific role (Care / Clinical / Core).
    """
    return _apply_nursing_subtype(
        _resolve_base_family(vertical_hint, jd_analysis), jd_analysis,
    )


def _resolve_base_family(
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
    everywhere; only the user-facing label changes per family.

    The three labels in skills_categories are, by convention:
        [0] HEADLINE competencies, [1] soft skills, [2] secondary / catch-all.

    The CV/JD categoriser files software/tools/platforms under "technical" and
    industry/process/clinical knowledge under "domain_knowledge". Which of those
    two buckets is the family's HEADLINE differs by role: tech roles lead with
    "technical" (Python, SQL → Technical Skills); nursing/manual roles lead with
    "domain_knowledge" (medication administration, dementia care → Clinical
    Skills), and "technical" (e.g. BESTMed/MedMobile) becomes the secondary
    "Other Skills" bucket. rf.headline_bucket selects which.
    """
    cats = list(rf.skills_categories) + ["Technical Skills", "Soft Skills", "Other Skills"]
    headline = rf.headline_bucket if rf.headline_bucket in ("technical", "domain_knowledge") else "technical"
    secondary = "domain_knowledge" if headline == "technical" else "technical"
    # The domain_knowledge bucket keeps an explicit "Domain Knowledge" label
    # whenever it is NOT the headline (i.e. tech/master) so it stays a distinct,
    # visible category instead of collapsing into a generic "Other Skills". When
    # the secondary is the technical bucket (nursing/manual: tools/systems like
    # BESTMed), it takes the family's catch-all label (skills_categories[2]).
    secondary_label = "Domain Knowledge" if secondary == "domain_knowledge" else cats[2]
    return {
        headline:      cats[0],
        "soft_skills": cats[1],
        secondary:     secondary_label,
    }


def category_order(rf: RoleFamilyProfile) -> List[str]:
    """
    Display order of the internal skill buckets for this family:
    headline first, then soft skills, then the secondary bucket. So tech shows
    Technical → Soft → Domain Knowledge; nursing shows Clinical → Soft → Other.
    """
    headline = rf.headline_bucket if rf.headline_bucket in ("technical", "domain_knowledge") else "technical"
    secondary = "domain_knowledge" if headline == "technical" else "technical"
    return [headline, "soft_skills", secondary]


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


# ---------------------------------------------------------------------------
# Match-time equivalences + qualification hierarchy
# ---------------------------------------------------------------------------

_MATCH_BUCKETS = ("required", "preferred")
_MATCH_CATS = ("technical", "soft_skills", "domain_knowledge")

# Aged-care / personal-care qualification streams treated as interchangeable for
# AIN / personal-care / aged-care roles. A higher AQF certificate level in the
# same family subsumes a lower or alternative one (Cert IV ⊇ Cert III), so the
# matcher must not flag an either/or or lower-level cert as missing when the CV
# already holds an equivalent or higher qualification.
_AGED_CARE_QUAL_TERMS = (
    "aged care", "ageing support", "ageing", "aged-care",
    "individual support", "personal care", "community care",
    "home care", "home and community care", "disability",
)
_ROMAN_LEVEL = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5}
_CERT_RE = re.compile(r"certificate\s+([ivx]+)\b(?:\s+(?:in|of)\s+([a-z ,&/+-]+))?")


def _aged_care_cert_level(text: str) -> int:
    """Highest aged-care-family certificate level present in `text` (0 if none).
    'Certificate IV in Ageing Support' → 4."""
    best = 0
    for m in _CERT_RE.finditer(text.lower()):
        lvl = _ROMAN_LEVEL.get(m.group(1))
        stream = m.group(2) or ""
        if lvl and any(t in stream for t in _AGED_CARE_QUAL_TERMS):
            best = max(best, lvl)
    return best


def _required_aged_care_cert_level(keyword: str) -> int | None:
    """AQF level of an aged-care-family certificate requirement, else None.
    'certificate iii in individual support' → 3."""
    m = _CERT_RE.search(keyword.lower())
    if not m:
        return None
    lvl = _ROMAN_LEVEL.get(m.group(1))
    stream = m.group(2) or ""
    if lvl and any(t in stream for t in _AGED_CARE_QUAL_TERMS):
        return lvl
    return None


def promote_matched_equivalents(
    matched: Dict[str, Dict[str, List[str]]],
    missed: Dict[str, Dict[str, List[str]]],
    cv_text: str,
    rf: RoleFamilyProfile,
) -> List[str]:
    """
    Move JD keywords from `missed` to `matched` when the CV honestly satisfies
    them under the role family's rules — never invents a match. Two sources:

      1. rf.equivalences synonyms — the JD term and a CV term mean the same
         thing (JD 'Aged Care' ⇄ CV 'ageing support').
      2. Aged-care certificate hierarchy (nursing only) — a higher or
         alternative AQF certificate in the CV subsumes a lower/alternative one
         the JD lists (Cert IV in Ageing Support ⊇ Cert III in Individual
         Support). This is the "either/or + qualification level" rule for
         AIN / personal-care roles.

    Mutates matched/missed in place; returns the promoted keywords (lowercased).
    """
    cv_l = (cv_text or "").lower()
    promoted: List[str] = []

    def _move(bucket: str, cat: str, kw: str) -> None:
        if kw not in missed[bucket][cat]:
            return
        missed[bucket][cat] = [k for k in missed[bucket][cat] if k != kw]
        if kw not in matched[bucket][cat]:
            matched[bucket][cat].append(kw)
        promoted.append(kw)

    # 1. Verified synonyms from the family's equivalence table.
    for jd_term, cv_terms, category in rf.equivalences:
        if category not in _MATCH_CATS:
            continue
        if not any(
            re.search(r"\b" + re.escape(t.lower()) + r"\b", cv_l) for t in cv_terms
        ):
            continue
        key = jd_term.lower()
        for bucket in _MATCH_BUCKETS:
            _move(bucket, category, key)

    # 2. Aged-care certificate hierarchy (AIN / personal-care).
    if rf.id == "nursing":
        cv_level = _aged_care_cert_level(cv_l)
        if cv_level:
            for bucket in _MATCH_BUCKETS:
                for cat in _MATCH_CATS:
                    for kw in list(missed[bucket][cat]):
                        req_level = _required_aged_care_cert_level(kw)
                        if req_level is not None and req_level <= cv_level:
                            _move(bucket, cat, kw)

    return promoted
