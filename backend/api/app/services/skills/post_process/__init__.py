"""Apply lexicon classification to LLM-extracted skill lists.

Used after JD analysis (LLM) and after CV categorisation (LLM) to:

  • drop universal noise from skill buckets (eligibility / credential /
    framework noise — these are NEVER skills)
  • move mis-bucketed skills to their lexicon-correct category
  • replace surface phrasings with canonical forms (so the CV and JD
    sides agree on the same canonical entry — which is what makes
    downstream matching deterministic)
  • track what was removed/moved in a `sidecar` dict, for routing
    (credentials → Registration & Licences) and for diagnostics

The LLM still EXTRACTS phrases (variance-tolerant). The lexicon
DECIDES the category (deterministic). Unknown phrases stay in the
LLM-assigned bucket as a safe fallback rather than being guessed
into the wrong one.

Split out of the former single-module post_process.py (2,283 lines). Pure
code motion — function bodies, ordering and comments are unchanged. Every
public *and* private name remains importable from
``app.services.skills.post_process`` via the package __init__, because 16
underscore-prefixed names are imported by app code and tests.
"""
from __future__ import annotations

from app.services.skills.post_process._common import logger  # noqa: F401
from app.services.skills.post_process.credentials import (  # noqa: F401
    _AU_UNIT_CODE_RE,
    _AU_UNIT_PREFIXES,
    _CONDITIONAL_CLAUSE_RE,
    _CREDENTIAL_COMPONENT_LABELS,
    _CREDENTIAL_PAREN_TAIL_RE,
    _CRED_PROSE_TAIL_STOP,
    _CRED_TAIL_CONNECTORS,
    _CRED_TAIL_TERMINATOR_RE,
    _EMBEDDED_CREDENTIAL_MARKER_RE,
    _FLUFF_SUBSTRINGS,
    _LANGUAGE_FALSE_POSITIVES,
    _LANGUAGE_PATTERN_RE,
    _LEADING_BULLET_RE,
    _LEADING_CRED_QUALIFIERS,
    _OBLIGATION_RE,
    _OFFER_VERB_RE,
    _PREFERRED_MARKERS,
    _QUAL_PATTERN,
    _SECTOR_SETTING_LABELS,
    _SETTING_CONTEXT_WORDS,
    _STUDENT_NOISE,
    _VEHICLE_ELIGIBILITY_RE,
    _WORD_FAMILY_TOKEN_RE,
    _build_credentials_block,
    _build_job_context,
    _clean_credential_phrase,
    _dedup_keep_order,
    _demote_conditional_required_to_preferred,
    _has_credential_marker,
    _is_au_unit_code,
    _is_fluff_phrase,
    _is_qualification_phrase,
    _is_setting_descriptor,
    _is_vaccination_phrase,
    _is_vehicle_eligibility,
    _line_is_offer_only,
    _looks_like_language,
    _share_content_token,
    _split_conditional_phrase,
    _strip_leading_cred_qualifiers,
    _trim_qual_phrase,
    extract_credentials_from_jd,
)
from app.services.skills.post_process.grounding import (  # noqa: F401
    _GROUND_FUZZY_TOKEN_HEAD,
    _GROUND_TOKEN_RE,
    _SOFT_SKILL_INANIMATE_GUARD,
    _WEAK_GROUNDING_TOKENS,
    _evidence_in_jd,
    _evidence_only_modifies_inanimate,
    _ground_blob,
    _ground_norm,
    _normalise_for_match,
    _skill_derivable_from_evidence,
    drop_ungrounded_soft_skills,
    verify_skill_evidence,
)
from app.services.skills.post_process.core import (  # noqa: F401
    _empty_sidecar,
    post_process_skills,
)
from app.services.skills.post_process.enrichment import (  # noqa: F401
    _BUCKET_CAPS,
    _COORD_COMM_RE,
    _JD_BODY_SCAN_CAP,
    _MAX_PHRASE_TOKENS,
    _already_extracted_canonicals,
    _expand_coordinated_modifiers,
    _scan_text,
    enrich_required_skills_from_jd_body,
)
from app.services.skills.post_process.demotion import (  # noqa: F401
    _OFF_SETTING_DOMAIN_KEYWORDS,
    demote_off_setting_keywords,
)
from app.services.skills.post_process.sections import (  # noqa: F401
    _INLINE_DESIRABLE,
    _INLINE_ESSENTIAL,
    _SECTION_HEAD_DESIRABLE,
    _SECTION_HEAD_ESSENTIAL,
    _collect_section_bodies,
    _phrase_in_blob,
    clamp_by_jd_sections,
)
from app.services.skills.post_process.subsumption import (  # noqa: F401
    _ROLL_UP_PARENTS,
    _collapse_children_to_parent,
    _dedupe_by_subsumption,
)
from app.services.skills.post_process.orchestrators import (  # noqa: F401
    post_process_cv_skills,
    post_process_jd_analysis,
)

__all__ = [
    "clamp_by_jd_sections",
    "demote_off_setting_keywords",
    "drop_ungrounded_soft_skills",
    "enrich_required_skills_from_jd_body",
    "extract_credentials_from_jd",
    "post_process_cv_skills",
    "post_process_jd_analysis",
    "post_process_skills",
    "verify_skill_evidence",
]
