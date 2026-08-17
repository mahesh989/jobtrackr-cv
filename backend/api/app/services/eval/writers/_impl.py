"""
Writer variant registry (Track W).

A writer takes the raw CV + JD (and BYOK client) and returns a WriterResult:
the tailored markdown plus the intermediate artifacts the runner needs to
score and report (jd_analysis, matching, initial ats, feasibility).

Variants:
  W1  current production  — full pipeline + production tailoring prompt.
  W2  generalised         — full pipeline + role-agnostic prompt (no baked
                            examples, no AI-suppression machinery).
  W4  chat single-call    — ONE rich AI call with raw CV+JD + lean prompt.
                            jd_analysis/matching/feasibility still run upstream
                            so the metrics/scoring are apples-to-apples with
                            W1/W2; the tailoring call itself never sees them.

W3 (composition) plugs in here later.

W1 reuses production code verbatim (no copies). W2 and W4 reuse the production
deterministic post-processors (_enforce_structure, _inject_missing_skills,
stamp_contact_line) so structural caps and the safety-net skills injection
behave identically across variants — the only thing that changes between
writers is the AI prompt that produced the markdown.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid

from app.enums import CATEGORY_KEYS
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple

from app.services.ai.client import AIClient, TAILORED_CV_GENERATION
from app.services.ai.prompts.variants.composition import (
    build_composition_system,
    COMPOSITION_USER_TEMPLATE,
)
from app.services.eval.enforce import enforce_skills_section, reroute_skills_by_lexicon
from app.services.eval.enforce_w3 import (
    apply_w3_gates,
    restrict_domain_to_direct,
)
from app.services.eval.enforce_w8 import to_canonical, restore_and_order, ensure_bachelor
from app.services.eval.verify import verify_claims
from app.services.eval.knockout import detect_knockouts
from app.services.eval.role_families import (
    resolve_role_family,
    resolve_seniority,
    apply_equivalences,
)
from app.services.cv.contact_line import (
    stamp_availability_in_summary,
    stamp_contact_line,
    stamp_credentials,
    stamp_references,
)
from app.services.pipeline.steps.jd_analysis import run_jd_analysis
from app.services.pipeline.steps.cv_jd_matching import run_cv_jd_matching
from app.services.pipeline.steps.ats_scoring import run_ats_scoring
from app.services.pipeline.steps.input_recommendations import run_input_recommendations
from app.services.pipeline.steps.keyword_feasibility import run_keyword_feasibility
from app.services.pipeline.steps.tailored_cv import (
    _cert_policy_for,          # role-family cert_policy (keep first_class certs)
    _enforce_company_anchor,   # summary employer-anchor net (re-run post-verify)
    _enforce_structure,        # production-stable post-processor — reused for fairness
    _enforce_summary_opener,   # forbidden-opener strip (re-run post-verify)
    _enforce_summary_s1_title_case,  # S1 title-case (runs before opener strip)
    _extract_employers_from_cv,  # multi-month employer extraction (anchor enforcement)
    _inject_missing_skills,    # production-stable safety net
    _upload_to_storage,        # production-stable Supabase upload (same path contract)
    build_family_label_map,    # convert RoleFamilyProfile → bold label map for injector
)

logger = logging.getLogger(__name__)

# Extracted to focused submodules (behaviour-preserving — same objects, new
# home). Re-imported so _impl's remaining code and the test-suite keep
# referencing them unqualified, and the writers barrel keeps mirroring them.
from app.services.eval.writers.career_highlights import (  # noqa: E402,F401
    _CAREER_HIGHLIGHTS_FLOOR,
    _career_highlights_word_count,
    _ensure_career_highlights_floor,
    _replace_career_highlights_prose,
)
from app.services.eval.writers.summary_anchors import (  # noqa: E402,F401
    _SUMMARY_HEADING_ALIASES,
    _YEARS_FIGURE_RE,
    _ensure_summary_anchors_both_employers,
    _summary_named_employers,
)
from app.services.eval.writers.bullet_rewrites import (  # noqa: E402,F401
    _BULLET_MARKERS,
    _kw_norm,
    _targeted_bullet_rewrites,
)
from app.services.eval.writers.reporting import (  # noqa: E402,F401
    _log_tailoring_report,
    _persist_quality_flags,
)


@dataclass
class WriterResult:
    tailored_md: str
    jd_analysis: Dict[str, Any]
    matching: Dict[str, Any]
    initial_ats_internal: Dict[str, Any]
    feasibility: Dict[str, Any]
    extras: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Shared upstream — every writer needs the same metric scaffolding around it
# so initial/final ATS and the rescore/grounding reports are apples-to-apples.
# ---------------------------------------------------------------------------


async def _run_upstream(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    jd_analysis = await run_jd_analysis(client, jd_text)
    matching = await run_cv_jd_matching(client, cv_text, jd_analysis)
    ats = run_ats_scoring(cv_text, jd_analysis, matching)
    input_recs = run_input_recommendations(cv_text, jd_analysis, matching, ats)
    feasibility = await run_keyword_feasibility(
        client, cv_text, jd_analysis, matching, input_recs, contact_details=contact_details,
    )
    return {
        "jd_analysis": jd_analysis,
        "matching":    matching,
        "ats":         ats,
        "input_recs":  input_recs,
        "feasibility": feasibility,
    }


def _inject_keyword_set(feasibility: Optional[Dict[str, Any]]) -> set[str]:
    """Lowercased inject_directly keywords — the feasibility/equivalence terms the
    plan authorised to surface. Used to exempt honest child→parent inferences
    (e.g. SQL→PostgreSQL) from the deterministic skills entity-grounding strip."""
    plan = (feasibility or {}).get("feasibility_plan") or {}
    out: set[str] = set()
    for e in (plan.get("inject_directly") or []):
        if isinstance(e, dict):
            kw = str(e.get("keyword") or "").strip().lower()
            if kw:
                out.add(kw)
    return out


def _postprocess(
    markdown: str,
    feasibility: Dict[str, Any],
    contact_details: Optional[Dict[str, Any]],
    role_family_id: Optional[str] = None,
) -> str:
    """Apply the production deterministic post-processors. Same for every variant."""
    enforced = _enforce_structure(markdown.strip())
    with_skills = _inject_missing_skills(enforced, feasibility)
    return stamp_contact_line(with_skills, contact_details, role_family_id=role_family_id)


# Skills surfacing & injection were extracted to writers.injection.
# Re-imported so _impl's remaining code + the test-suite keep referencing
# these unqualified.
from app.services.eval.writers.injection import (  # noqa: E402,F401
    _SURFACE_BUCKETS, _SURFACE_CATS, _matched_surface_terms, _SURFACE_CAPS, _LEADING_BULLET_RE, _line_starts_label, _surface_matched_skills, _KNOWN_CV_TOOLS, _surface_cv_named_tools, _TECHNICAL_SKILL_PATTERNS, _move_misplaced_technical_skills, _APPROVED_BUCKETS, _approved_skill_entries, _INJECT_LINE_RE, _norm_item, _inject_approved_skills, _drop_subsumed_generic_skills,
)


# ---------------------------------------------------------------------------
# Phase 2 Sprint B — deterministic Experience-section normaliser.
#
# Two modules combined: chronological sort + verb tense normalisation. Run
# AFTER restore_and_order (which orders SECTIONS but not entries within a
# section) and AFTER the awards-split pass.
#
# Why deterministic? The LLM gets these right ~70% of the time but flips
# tense on one bullet in three (the "Transported" regression in the
# Anglicare run is the canonical example), and orders entries by an unclear
# heuristic ("most recently mentioned" vs "most recent start date" vs
# "longest tenure"). Sorting and tense matching are pure functions; no
# reason to leave them to the LLM.
# ---------------------------------------------------------------------------

# Experience-section processing (month/date parse, chronological sort, tense
# normalisation) was extracted to writers.experience. Re-imported so _impl's
# remaining code + the test-suite keep referencing these unqualified.
from app.services.eval.writers.experience import (  # noqa: E402, F401 — re-exported via the writers barrel
    _MONTH_TO_NUM, _PAST_TO_PRESENT_VERBS, _PRESENT_TO_PAST_VERBS, _DATE_TOKEN_RE,
    _DATE_RANGE_RE, _EXPERIENCE_HEADING_RE, _BULLET_FIRST_WORD_RE, _parse_month_year,
    _parse_role_date_range, _is_present_role, _find_experience_section,
    _split_into_entries, _find_role_line, sort_experience_chronologically,
    _strip_trailing_blank, _convert_bullet_tense, normalise_experience_tense,
)
# ---------------------------------------------------------------------------
# Phase 2 Sprint C — body-text spelling + heading title-case + date format.
#
# Three small deterministic passes that clean LLM drift across the whole
# document (not just Skills, which existing _canonicalise_skill_spelling
# already covers).
#
# • Module 4: extend British/Australian spelling normalisation to body text
#             (Professional Summary, Experience bullets, Education, Awards
#             descriptions). Case-preserving — "Recognized" → "Recognised",
#             "individualized" → "individualised", "Recognise" → "Recognise".
# • Module 5: italic role/qualification lines title-cased properly. Short
#             prepositions/articles (in/of/to/for/and/or/the/a/an/by/with/
#             on/at/as) lowercase EXCEPT at sentence start; preserve ALL-CAPS
#             tokens (IV/NSW/CPR/RN/AHPRA/NDIS) and mixed-case brands.
# • Module 6: strip day-of-month from CV dates ("Sept 20, 2024" → "Sept 2024")
#             — standard CV convention.
# ---------------------------------------------------------------------------

# Module 4 — case-preserving British/Australian spelling map.
#
# Each pair is (american_pattern, british_canonical_lowercase). Replacement
# inflects to the matched input's case style (lowercase / Capitalised /
# ALL-CAPS) so we don't break "recognized for" mid-sentence into "Recognised
# for" (the existing _canonicalise_skill_spelling does that — it's fine for
# Skills line which is always capitalised, but wrong for body prose).
# Body spelling + heading title-case were extracted to writers.spelling_case.
# Re-imported so _impl's remaining code + the test-suite keep referencing them
# unqualified.
from app.services.eval.writers.spelling_case import (  # noqa: E402,F401
    _BR_AM_BODY_SUBS, _case_preserve_replace, canonicalise_body_spelling, _apply_body_spelling_subs, _TITLE_CASE_STOPWORDS, _PRESERVE_CASE_TOKENS, _TITLE_CASE_LINE_RE, _H3_HEADING_RE, _title_case_token, _title_case_phrase, normalise_heading_title_case,
)
# Date-format normaliser lives with the other date logic in writers.experience
# (it uses _MONTH_TO_NUM, defined there). Re-imported for unqualified references.
from app.services.eval.writers.experience import (  # noqa: E402,F401
    _DATE_WITH_DAY_RE, normalise_date_formats,
)



def _apply_display_heading(md: str) -> str:
    """Set the summary heading to `## Career Highlights` (YEARS framing) or
    `## Professional Summary` (BREADTH framing) based on S1's prose, regardless
    of the role family's default heading name."""
    lines = md.split("\n")
    start = next(
        (i for i, ln in enumerate(lines) if ln.strip() in _SUMMARY_HEADING_ALIASES),
        None,
    )
    if start is None:
        return md
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("## ")),
        len(lines),
    )
    prose = " ".join(
        ln.strip() for ln in lines[start + 1 : end]
        if ln.strip() and not ln.strip().startswith(("-", "*"))
    )
    s1 = prose.split(".", 1)[0].lower() if prose else ""
    if not s1:
        return md
    has_years = bool(_YEARS_FIGURE_RE.search(s1))
    target = "## Career Highlights" if has_years else "## Professional Summary"
    if lines[start].strip() == target:
        return md
    lines[start] = target
    return "\n".join(lines)
















# ---------------------------------------------------------------------------
# Skills hygiene — drop "non-skill" entries that the matcher surfaces or the
# base classifier mislabels. These are JD keywords that match for scoring but
# read as junk in a Skills list: qualifications (belong in Education; a higher
# cert subsumes a lower one — Cert IV ⊇ Cert III), eligibility/compliance
# phrases (work rights, police checks), bare sector names (Aged Care), and
# JD-phrasing fillers ("Experience in…", "Knowledge of…"). Stripping them from
# Skills does not lose the keyword for ATS — the scorer still matches it from
# Education/Summary/Experience, or re-derives cert equivalences via promotion.
# ---------------------------------------------------------------------------

# Skills-section hygiene was extracted to writers.skills_section. Re-imported so
# _impl's remaining code + the test-suite (and the rescorer's import of
# _NON_SKILL_PATTERN/_EXACT/_PREFIXES) keep referencing them unqualified.
from app.services.eval.writers.skills_section import (  # noqa: E402,F401
    _NON_SKILL_EXACT, _NON_SKILL_PREFIXES, _NON_SKILL_PATTERN, _is_non_skill_phrase, _SKILLS_LINE_RE, _LEADING_SKILL_QUALIFIER_RE, _STRIPPABLE_SKILL_BASE_RE, _TRAILING_SKILLS_WORD_RE, _tidy_skill_qualifiers, _strip_non_skill_phrases, _KNOWN_ACRONYMS, _smartcase_atom, _smartcase_skill, _normalise_skills_case, _BR_AM_SKILL_SUBS, _canonicalise_skill_spelling, _dedupe_skills_across_lines,
)
# Awards/certification parsing helpers were extracted to writers.awards_parsing.
# Re-imported here so the rest of _impl + the test-suite keep referencing them
# unqualified (behaviour-preserving — same objects, new home).
from app.services.eval.writers.awards_parsing import (  # noqa: E402, F401 — re-exported via the writers barrel
    _AWARD_RE, _CERT_LIKE_RE, _AWARDS_SOURCE_HEADINGS, _DATE_TAIL_RE, _LEADING_DATE_RE,
    _AU_LOCATION_TAIL_RE, _AU_LOCATION_TAIL_NOCOMMA_RE, _DESCRIPTION_PREFIX_RE,
    _LOCATION_ANCHOR_RE, _is_valid_date, _add_desc_sentence, _parse_award_parts,
    _strip_duplicate_trailing_word, _strip_au_location, _format_award_entry,
    _format_award_bullet, _classify_entry_line, _looks_like_location,
    _split_award_name_org, _parse_award_raw_entry, _dedupe_award_description_sentences,
)
# Awards/credentials section logic was extracted to writers.awards.
# Re-imported so _impl's remaining code + the test-suite keep referencing
# these unqualified.
from app.services.eval.writers.awards import (  # noqa: E402,F401
    _is_description_only_entry, _normalise_awards_entries, _relabel_awards_only_certifications, _entry_is_award, _entry_is_cert, _registration_section_text, _credential_already_in_registration, split_awards_and_certifications, _drop_sections_by_ranges, _CRED_KEYWORDS, _OTHER_SECTION_WORDS, _is_cred_heading, _cv_heading_word, _extract_original_credentials, _awards_section_text, ensure_awards, _GROUNDED_SECTION_WORDS, _PLACEHOLDER_RE, _strip_ungrounded_credentials,
)


# ---------------------------------------------------------------------------
# W8 — production-contract integration of the role-family engine.
#
# The deliverable of the "document production → integrate into the new engine →
# adapt for nursing" task. It is the role-family COMPOSITION writer (W3's
# architecture: [universal engine] + [role-family pack] + [seniority overlay],
# correct per-family section order and skills taxonomy) run through the EXACT
# FROZEN production presentation contract — reproduced 1:1 via the canonical
# sandwich (enforce_w8): rename the family's section headings to the production
# canonical names, run the verbatim production post-processors + the proven W3
# gates + skills hygiene, rename back, then reorder to the family's section
# order. No production code is forked or re-implemented, so the PDF format,
# bullet-writing method, bullet counts, and the 2-sentence/35-50-word summary
# method are identical to production. Fixes W7's one residual: W8 leads nursing
# with "Registration & Licences" and honours every family's section order.
#
# Honesty stack (same as W7): domain_knowledge restricted to direct-only,
# suppression for tech/master, degree relevance, ungrounded-strip, skills caps.
# ---------------------------------------------------------------------------


# Setting classification + summary bridges were extracted to writers.bridges.
# Re-imported so _impl's remaining code + the test-suite keep referencing them
# unqualified.
from app.services.eval.writers.bridges import (  # noqa: E402,F401
    _SETTING_HOME, _SETTING_HOSPITAL, _SETTING_NDIS, _SETTING_LIFESTYLE, _SETTING_THEATRE, _SETTING_RESIDENTIAL, _classify_jd_setting, _build_jd_setting_block, _HIGHLIGHT_HEADINGS_SET, _S1_RESIDENTIAL_RE, _SETTING_BRIDGES, _CV_HOSPITAL_MARKERS_RE, _scan_experience_section, _cv_has_hospital_experience, _CV_HOME_MARKERS_RE, _CV_NDIS_MARKERS_RE, _CV_LIFESTYLE_MARKERS_RE, _CV_THEATRE_MARKERS_RE, _cv_has_home_care_experience, _cv_has_ndis_experience, _cv_has_lifestyle_experience, _cv_has_theatre_experience, _BRIDGE_EVIDENCE_GATES, _apply_setting_bridge,
)
from app.services.eval.writers.honesty_guard import (  # noqa: E402,F401
    enforce_source_dates,
    enforce_source_settings,
    pin_skills_section_labels,
    enforce_credential_claims,
    filter_irrelevant_roles_pre,
    assess_honesty_risk,
)
async def _writer_w8_integrated(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,
    upstream: Optional[Dict[str, Any]] = None,
) -> WriterResult:
    # ── PRE-COMPOSITION HONESTY GATE ──────────────────────────────────────
    # Strip Experience entries whose primary vertical differs from the JD's
    # AND drops are above the floor (always keep ≥2 roles). Mutates cv_text
    # consistently so upstream metrics + composition see the same trimmed
    # source. Safe no-op when JD vertical is unknown or source has too few
    # roles. The dropped employer names land in extras for the surfacing
    # report.
    _pre_dropped: list[str] = []
    if vertical:
        cv_text, _pre_dropped = filter_irrelevant_roles_pre(cv_text, vertical)
        if _pre_dropped:
            logger.info("w8_integrated: pre-composition role filter dropped %s", _pre_dropped)
    # `upstream` lets the production orchestrator hand in its already-computed
    # jd_analysis/matching/ats/input_recs/feasibility so the w8 path doesn't
    # re-pay those AI calls. The eval harness passes nothing → recompute.
    up = dict(upstream) if upstream is not None else await _run_upstream(client, cv_text, jd_text, contact_details)
    up["feasibility"] = restrict_domain_to_direct(up["feasibility"])  # domain expertise can't be inferred

    role_family = resolve_role_family(vertical, up["jd_analysis"])
    seniority = resolve_seniority(up["jd_analysis"])
    # W8.3 — promote JD terms the CV honestly justifies via the family's verified
    # equivalence table (replaces over-permissive AI guessing for these terms).
    up["feasibility"] = apply_equivalences(up["feasibility"], cv_text, jd_text, role_family)
    system_prompt = build_composition_system(role_family, seniority)

    plan_for_prompt = (up["feasibility"] or {}).get("feasibility_plan") or {}

    # Deterministic JD setting classification — prepended to the user message so
    # it arrives before the CV text and cannot be overridden by the model's
    # residential-setting prior derived from the candidate's employer history.
    _setting       = _classify_jd_setting(jd_text, up["jd_analysis"])
    _setting_block = _build_jd_setting_block(_setting)
    _setting_prefix = (_setting_block + "\n\n") if _setting_block else ""
    logger.info("w8_integrated: JD setting classified as %s", _setting)

    user_prompt = _setting_prefix + COMPOSITION_USER_TEMPLATE.format(
        cv_text=cv_text,
        jd_text=jd_text,
        feasibility_json=json.dumps(plan_for_prompt, indent=2),
    )
    raw = await client.complete(
        system=system_prompt,
        user=user_prompt,
        max_tokens=6144,
        operation="tailored_cv",
        **TAILORED_CV_GENERATION,
    )
    if not raw or len(raw.strip()) < 200:
        raise ValueError("W8 tailored CV: response too short")

    # ── Canonical sandwich — reproduce the FROZEN production contract 1:1 ──
    # 1. Rename the family's section headings to the production canonical names.
    md = to_canonical(raw.strip(), role_family)
    # 1b. If Career Highlights shipped under the prompt's own 35-word floor,
    #     retry once to expand it with CV-grounded facts before any trimming.
    md = await _ensure_career_highlights_floor(
        client, md, system_prompt=system_prompt, cv_text=cv_text, jd_text=jd_text,
    )
    # 1c. MULTI-ROLE anchor: when the CV has 2+ multi-month employers but the
    #     summary names fewer than both, retry once to rewrite S2 into two
    #     employer-anchored clauses (the deterministic net below cannot repair
    #     a cherry-picked / award-shaped S2 — see _ensure_summary_anchors_both_employers).
    md = await _ensure_summary_anchors_both_employers(
        client, md, system_prompt=system_prompt, cv_text=cv_text, jd_text=jd_text,
    )
    # 2. Run the VERBATIM production post-processors (structural caps, bullet
    #    method, summary clamp, education rules, skills safety-net injector).
    md = _enforce_structure(
        md,
        jd_job_title=str(up["jd_analysis"].get("job_title") or ""),
        cv_text=cv_text,
        cert_policy=_cert_policy_for(up["jd_analysis"]),
    )
    # Pass the family-aware label map so inject_directly domain keywords land on
    # the correct category line. For nursing: domain_knowledge → "**Care Skills:**"
    # not "**Other Skills:**". Without this, wound care / continence care injected
    # here would wrongly appear on the Other Skills line.
    md = _inject_missing_skills(md, up["feasibility"], family_label_map=build_family_label_map(role_family))
    md = stamp_contact_line(md, contact_details, role_family.id)
    # 3. Proven W3 deterministic gates (suppression / degree relevance /
    #    ungrounded-strip) + skills hygiene — all expect canonical names.
    md = apply_w3_gates(
        md,
        jd_text=jd_text,
        jd_analysis=up["jd_analysis"],
        suppress=role_family.id in ("tech", "master"),
        original_cv_text=cv_text,
        keep_skills=_inject_keyword_set(up["feasibility"]),
        jd_vertical=vertical,
    )
    md = enforce_skills_section(
        md,
        original_cv_text=cv_text,
        drop_ungrounded=(role_family.injection_policy == "none"),
    )
    # 3a. Re-surface JD terms the matcher confirmed but the rewrite dropped, so the
    #     tailored CV never scores BELOW the original on keywords it already had.
    #     Honest (matched-only) and AFTER the hygiene cap so it can't be stripped.
    #     Skipped for the "none" policy (trades) where minimalism is intentional.
    if role_family.injection_policy != "none":
        md = _surface_matched_skills(md, up["matching"])
    # 3a-pre. CV-named brand tools the writer dropped (BESTMed, MedMobile,
    #     Leecare, ...). Independent of the JD — these are the candidate's
    #     differentiators and must never disappear, even when the writer
    #     prompt biases toward JD-required generics ("Basic Computer Skills").
    if role_family.injection_policy != "none":
        md = _surface_cv_named_tools(md, cv_text, role_family)
    # 3a-pre-2. Move obviously-technical skills out of Soft/Care lines.
    #     'Basic Smartphone Skills' / 'Computer Skills' / brand tools that
    #     end up on the wrong line because the LLM mis-classified them.
    if role_family.injection_policy != "none":
        md = _move_misplaced_technical_skills(md, role_family)
    # 3a-bis. Strip non-skill entries (qualifications, eligibility/compliance,
    #     bare sector names, JD-phrasing fillers) from the Skills section, no
    #     matter whether the base classifier or the surfacing pass added them.
    md = _strip_non_skill_phrases(md)
    # 3a-ter-pre. Re-route mis-bucketed Skills entries to the lexicon-correct
    #     line (e.g. 'Clinical Documentation' on Other Skills → Care Skills for
    #     nursing). Uses classify(entry, vertical) as the authority. Unknown
    #     entries stay put. Follow with enforce to re-cap any line that grew.
    md = reroute_skills_by_lexicon(md, vertical)
    md = enforce_skills_section(md)
    # 3a-ter. Normalise case across all Skills entries — Title Case with
    #     preservation rules for acronyms (SQL/NDIS), digit tokens (GA4), and
    #     mixed-case product names (BESTMed/MedMobile). Fixes inconsistent
    #     casing between AI-written entries and surfacing-pass entries.
    md = _normalise_skills_case(md)
    # 3a-quater. Canonicalise British/American spellings AND dedupe duplicates
    #     across Skills lines. "Person-Centered Care" in Other Skills + "Person-
    #     Centred Care" in Care Skills are the same skill — keep only the
    #     earlier-line entry, drop the later. Applies British spelling
    #     (Australian default) to all surviving entries.
    md = _dedupe_skills_across_lines(md)
    # 3a-quinquies. Post-cap safety net for approved-but-missing skill keywords
    #     (e.g. "verbal communication" / "written communication") the cap
    #     dropped, then drop generics the specific entries now subsume.
    md = _inject_approved_skills(md, up["feasibility"])
    md = _drop_subsumed_generic_skills(md)
    md = _normalise_skills_case(md)
    md = _dedupe_skills_across_lines(md)
    # 3b. Deterministic Bachelor recovery — re-add a dropped baseline degree from
    #     the original CV (the writer occasionally drops it despite the prompt).
    md = ensure_bachelor(md, cv_text)
    # 3c. Deterministic award/credential recovery — re-add a Certifications/Awards
    #     entry from the original CV that the rewrite silently dropped.
    md = ensure_awards(md, cv_text)
    # 4. Rename canonical headings back to the family's names and apply the
    #    family's section order (fixes W7's nursing section-order residual).
    final_md = restore_and_order(md, role_family)
    # 4a. Drop AI-fabricated credential/checks entries not grounded in the CV
    #     (e.g. "First Aid – [Provider not specified]", "Driver Licence (NSW)").
    final_md = _strip_ungrounded_credentials(final_md, cv_text)
    # 4b. Relabel an awards-only "Certifications" / "Recognition" section to "Awards".
    #     This handles the PURE case (every entry is award-shaped). The MIXED
    #     case (award entry + cert entry under one heading) survives this pass.
    final_md = _relabel_awards_only_certifications(final_md)
    # 4c. Stamp user-supplied credentials into ## Registration & Licences
    #     (C22o: nursing + manual only — contact_line.py's
    #     _CREDENTIAL_FAMILIES — a prior version of this comment wrongly
    #     included manual in the no-op list; manual DOES run this pass, see
    #     test_credentials_stamp.py's explicit manual-path assertion. No-op
    #     when role family is tech/general or when the user has saved no
    #     credentials). Replaces any AI-emitted body in that section — the
    #     user's profile is authoritative for what they actually hold. Run
    #     BEFORE the awards-split pass so it can dedupe against
    #     Registration content.
    final_md = stamp_credentials(final_md, contact_details, role_family.id)
    # 4c-bis. Availability note (opt-in) — italic line at the end of the
    #         Professional Summary, just above the next section.
    final_md = stamp_availability_in_summary(final_md, contact_details, role_family.id)
    # 4c-tris. Stamp the user-saved References block (role-family agnostic).
    #          mode=details renders a 2-col table; mode=on_request renders
    #          a single line; mode=none omits the section entirely.
    final_md = stamp_references(final_md, contact_details)
    # 4c-bis. Sprint A — split MIXED Certifications sections into clean Awards
    #     + Certifications, dropping cert entries already duplicated in
    #     Registration & Licences. Fixes the Anglicare run where "First Aid
    #     Certification" + "Staff Excellence Award" landed under one heading;
    #     the relabel pass at 4b refused to rename (mixed), so the award sat
    #     under the wrong heading and the cert duplicated Registration.
    final_md = split_awards_and_certifications(final_md)
    # 4d. Normalise every entry in ## Awards to a single clean bullet
    #     `- Name – Organisation (Date)` — collapses the two-line H3+italic
    #     block shape the writer sometimes emits, and strips trailing
    #     "Recognised for hard work…" descriptive text from verbose bullets.
    #     Run AFTER the awards-split so newly-created Awards sections get
    #     normalised too.
    final_md = _normalise_awards_entries(final_md)
    # 4e. Sprint B — sort Experience entries reverse-chronological. The LLM
    #     gets this right ~70% of the time; locking it down deterministically
    #     ensures Uniting (Mar 2026) → Jesmond (May 2025) → Anglicare (Sept
    #     2024) regardless of the model. Ongoing roles first, then ended.
    final_md = sort_experience_chronologically(final_md)
    # 4f. Sprint B — normalise verb tense on Experience bullets. For "Present"
    #     roles every first verb is present-tense (Serve / Deliver / Provide);
    #     for ended roles past-tense (Served / Delivered / Provided). Fixes
    #     the "Transported residents…" regression where one bullet drifted
    #     past-tense even though the role is still active.
    final_md = normalise_experience_tense(final_md)
    # 4g. Sprint C — apply British/Australian spelling to body text
    #     (Summary, Experience bullets, Education, Awards). Case-preserving,
    #     so "Recognized" → "Recognised" and "individualized" → "individualised"
    #     in mid-sentence positions. Existing _canonicalise_skill_spelling on
    #     Skills entries is unchanged; this pass picks up everything else.
    final_md = canonicalise_body_spelling(final_md)
    # 4h. Sprint C — title-case italic role/qualification lines and H3
    #     headings. "Assistant In Nursing" → "Assistant in Nursing"; preserves
    #     ALL-CAPS tokens (IV, NSW, CPR) and mixed-case brands (BESTMed).
    final_md = normalise_heading_title_case(final_md)
    # 4i. Sprint C — strip day-of-month from CV dates. "Sept 20, 2024" →
    #     "Sept 2024". Standard CV convention.
    final_md = normalise_date_formats(final_md)
    # 4j. Final display step — when S1 used BREADTH framing (no years figure,
    #     scope-anchored), rename `## Career Highlights` → `## Professional
    #     Summary`. All upstream helpers ran against the canonical name; only
    #     the displayed PDF heading switches.
    final_md = _apply_display_heading(final_md)

    # W8.2 — knockout pass (deterministic, no AI). Honest hard-requirement report
    # (mandatory licence / minimum years / work rights) that a CV edit can't fix.
    knockouts = detect_knockouts(jd_text, up["jd_analysis"], cv_text)

    # End-of-tailoring report — one log line summarising where every JD keyword
    # landed. Makes "why did keyword X go missing?" debuggable without grepping
    # 10 per-pass logs. Deliberately concise: family / counts / first few honest
    # gaps. Full landings are deducible from the tailored_md when needed.
    _log_tailoring_report(
        family_id=role_family.id,
        feasibility=up["feasibility"],
        matching=up["matching"],
        tailored_md=final_md,
    )

    # Honesty-risk signal (logged, not gated). HIGH when the candidate has
    # <3 months of vertical tenure AND the initial ATS is already low — the
    # tailored CV probably can't add much real value, only inflation risk.
    _honesty_risk = assess_honesty_risk(
        cv_text, vertical,
        initial_ats=(up["ats"] or {}).get("overall_score") if isinstance(up["ats"], dict) else None,
    )
    return WriterResult(
        tailored_md=final_md,
        jd_analysis=up["jd_analysis"],
        matching=up["matching"],
        initial_ats_internal=up["ats"],
        feasibility=up["feasibility"],
        extras={
            "input_recommendations": up["input_recs"],
            "role_family": role_family.id,
            "seniority": seniority,
            "section_order": role_family.section_order,
            "knockouts": knockouts,
            "jd_setting": _setting,  # passed to _writer_w8_verified for bridge pass
            "pre_filter_dropped_roles": _pre_dropped,
            "honesty_risk": _honesty_risk,
        },
    )








# ---------------------------------------------------------------------------
# W8-verified — W8 + Stage-6 per-claim entailment verification (W8.1).
# Identical to w8_integrated, then runs one focused entailment pass that repairs
# or drops any tailored bullet not entailed by the source CV. Shipped as a
# separate variant so the beta screen can A/B the honesty lift (W8 vs W8+verify)
# and prove it before the verifier is promoted into the single production path.
# ---------------------------------------------------------------------------


async def _writer_w8_verified(
    client: AIClient,
    cv_text: str,
    jd_text: str,
    contact_details: Optional[Dict[str, Any]],
    *,
    vertical: Optional[str] = None,
    upstream: Optional[Dict[str, Any]] = None,
) -> WriterResult:
    result = await _writer_w8_integrated(
        client, cv_text, jd_text, contact_details, vertical=vertical, upstream=upstream,
    )
    verified_md, vreport = await verify_claims(client, result.tailored_md, cv_text)
    role_family = resolve_role_family(vertical, result.jd_analysis)
    verified_md = apply_w3_gates(
        verified_md,
        jd_text=jd_text,
        jd_analysis=result.jd_analysis,
        suppress=role_family.id in ("tech", "master"),
        original_cv_text=cv_text,
        keep_skills=_inject_keyword_set(result.feasibility),
        jd_vertical=vertical,
    )
    # Re-run the grounding gate (C22p, filed from C22j's independent review):
    # verify_claims is an AI step that can rewrite/reintroduce a fabricated
    # credential entry into a Certifications/Checks section — the FIRST
    # grounding pass (step 4a, above, inside _writer_w8_integrated) already
    # ran BEFORE verify_claims saw the document, so anything verify_claims
    # fabricates here was never checked against the source CV at all. This
    # closed the "runs after and is never re-checked" gap that capped C22j's
    # own fix's real-world effectiveness. Idempotent — safe to re-run.
    verified_md = _strip_ungrounded_credentials(verified_md, cv_text)
    # Re-run the awards/section normalisers — verify_claims is an AI step that
    # can rewrite the Awards/Certifications section into a messy shape (e.g.
    # description promoted to ###). These deterministic passes are idempotent
    # and ensure the structured Awards layout reaches the renderer.
    verified_md = _relabel_awards_only_certifications(verified_md)
    verified_md = _normalise_awards_entries(verified_md)
    # Re-run skills hygiene — verify_claims can rewrite the Skills section:
    # merging all three categories back onto one line (so the PDF renders them
    # as a single paragraph), adding junk entries like "Person-Centred Care
    # Principles" or care-setting descriptors, and breaking case consistency.
    # These passes are idempotent; the cost is negligible.
    verified_md = enforce_skills_section(verified_md)
    verified_md = _strip_non_skill_phrases(verified_md)
    verified_md = reroute_skills_by_lexicon(verified_md, vertical)
    verified_md = enforce_skills_section(verified_md)
    verified_md = _normalise_skills_case(verified_md)
    verified_md = _dedupe_skills_across_lines(verified_md)
    # ── PHASE 2 RE-RUN ──────────────────────────────────────────────────────
    # verify_claims is an AI step that can rewrite ANY section, undoing the
    # Phase 2 sprints that ran inside _writer_w8_integrated. Re-run them here
    # so the final output is always Phase-2-canonical regardless of what the
    # verifier emits. All passes are idempotent → cheap re-run.
    #   • Sprint A: split mixed Certifications back into Awards + Certs
    #   • Sprint B: chronological order + bullet tense
    #   • Sprint C: body spelling, italic title case, date format
    #   • Sprint E: enforce Summary S2 concreteness
    # Sprint D is implicit in _normalise_awards_entries above.
    verified_md = split_awards_and_certifications(verified_md)
    verified_md = _normalise_awards_entries(verified_md)
    verified_md = sort_experience_chronologically(verified_md)
    verified_md = normalise_experience_tense(verified_md)
    verified_md = canonicalise_body_spelling(verified_md)
    verified_md = normalise_heading_title_case(verified_md)
    verified_md = normalise_date_formats(verified_md)
    # ── HONESTY GUARDS (single source-facts ground truth) ─────────────────
    # Deterministic anchors against the source CV. Each guard is idempotent,
    # returns (md, notes); the notes accumulate into result.extras so the
    # orchestrator can surface "we omitted dates / dropped a setting label"
    # as a per-run quality_flag (the user asked to be notified).
    _hg_notes: list[str] = []
    # 1. Date guard — replace fabricated/placeholder role dates with source-
    #    verbatim values or strip the date slot if source has none. Kills
    #    the "[Dates] – [Dates]" template leak + "2017–2021" / "2023–2024"
    #    fabrications surfaced in the real-test audit.
    verified_md, _n = enforce_source_dates(verified_md, cv_text)
    _hg_notes.extend(_n)
    # 2. Setting guard — strip setting descriptors ("retirement village",
    #    "acute hospital ward") from role italic-headers when the source
    #    role doesn't evidence that setting. Bullets keep their JD-vocab
    #    reframing; the role's identity comes from source.
    verified_md, _n = enforce_source_settings(verified_md, cv_text)
    _hg_notes.extend(_n)
    # 3. Skills-section label pin — force the headline label to the family's
    #    convention (Care Skills for nursing) regardless of what the LLM
    #    emitted. Fixes the 12/20 "Technical Skills" misrouting on nursing
    #    CVs surfaced in the audit.
    _rf_id = (result.extras or {}).get("role_family") if hasattr(result, "extras") else None
    verified_md, _n = pin_skills_section_labels(verified_md, _rf_id)
    _hg_notes.extend(_n)
    # 4. Credential-claim guard — strip unverifiable compliance claims from
    #    bullets ("AIN with current compliance for pre-employment medical,
    #    police, and NDIS worker clearances …"). Verified against the user's
    #    saved credentials (contact_details.credentials). Claims the user
    #    genuinely holds (e.g. police_check=true) survive; the rest are
    #    stripped and surfaced via quality_flags.
    verified_md, _n = enforce_credential_claims(verified_md, contact_details)
    _hg_notes.extend(_n)
    # 5. Forbidden-opener RE-ENFORCEMENT + title-honesty gate. The opener strip
    #    ran inside _writer_w8_integrated, but verify_claims (an AI step) can
    #    rewrite S1 and re-introduce a forbidden status/identity opener
    #    ("International student with …"). The post-verify re-run block above
    #    re-applies the other deterministic passes but had omitted this one.
    #    CRITICAL honesty rule: use the JD job title as the opener ONLY when it
    #    shares the candidate's domain (role family). For an off-axis JD
    #    ("Pharmacy Technician" on an aged-care CV) inserting the JD title
    #    fabricates an identity the CV can't support — flag instead of aligning.
    verified_md = _enforce_summary_s1_title_case(verified_md)
    _before_opener = verified_md
    _cv_family = resolve_role_family(None, {"summary": cv_text}).id
    _title_supported = _cv_family == role_family.id
    verified_md = _enforce_summary_opener(
        verified_md,
        str((result.jd_analysis or {}).get("job_title") or ""),
        title_supported=_title_supported,
    )
    if verified_md != _before_opener:
        _hg_notes.append(
            "Adjusted the summary opener to the candidate's CV-aligned role title"
            if _title_supported else
            "Summary opener: the JD's role title isn't supported by the CV's "
            "experience — flagged for a manual title rather than fabricating alignment"
        )
    if _hg_notes:
        result.extras["honesty_guard_notes"] = _hg_notes
        logger.info("w8_verified: honesty guards applied — %d rewrite(s)", len(_hg_notes))
    # Targeted bullet rewrites — for inject_as_extension keywords the composition
    # LLM missed, run one small focused call per bullet concurrently. Zero cost
    # when the LLM applied all rewrites correctly (no missed items → no calls).
    # Runs AFTER all deterministic passes so rewrites are applied to the final
    # experience text, not an intermediate state.
    verified_md = await _targeted_bullet_rewrites(client, verified_md, result.feasibility)
    # Hard cap FIRST so each line is at DEFAULT_SKILL_CAPS (15/10/10) before
    # injection. Then cap-aware inject: approved keywords get priority over
    # writer-only tail items; writer-only items displaced when at cap.
    # NO enforce_skills_section after inject — it would truncate the
    # just-placed approved keywords off the tail (the pre-Fix-C regression).
    verified_md = enforce_skills_section(verified_md)
    verified_md = _inject_approved_skills(verified_md, result.feasibility)
    verified_md = _drop_subsumed_generic_skills(verified_md)
    verified_md = _normalise_skills_case(verified_md)
    verified_md = _dedupe_skills_across_lines(verified_md)
    # Force-inject — catches approved keywords the regular injector dropped
    # via label-mismatch (category=technical on nursing where only "Other
    # Skills" exists, not "Technical Skills"). Belt-and-braces.
    from app.services.eval.writers.injection import force_inject_missed_approved
    verified_md, _force_notes = force_inject_missed_approved(verified_md, result.feasibility)
    if _force_notes:
        # Merge into extras directly so this works in both the w8_verified
        # path (which accumulates _hg_notes locally) and the w8_critique
        # path (which doesn't have that local).
        prior = result.extras.get("honesty_guard_notes") or []
        result.extras["honesty_guard_notes"] = list(prior) + list(_force_notes)
    # RE-RUN the summary employer-anchor net. Like availability, the anchor is
    # enforced mid-pipeline (inside _enforce_structure, pre-verify), but
    # verify_claims rewrites the summary and can drop the employer name(s),
    # leaving a generic, anchor-less S2. Re-applying here (idempotent: no-op
    # when both top-2 employers are already named) guarantees the final S2
    # names them. See OPS-32.
    verified_md = _enforce_company_anchor(verified_md, cv_text)
    # RE-STAMP the opt-in availability note LAST. It was stamped mid-pipeline
    # inside _writer_w8_integrated, but verify_claims (+ the summary repair
    # pass) can bundle the italic "*Available: …*" line into the summary prose
    # and delete it. stamp_availability_in_summary is idempotent, so applying
    # it here guarantees the line survives to storage / PDF. See OPS-31.
    verified_md = stamp_availability_in_summary(verified_md, contact_details, role_family.id)
    result.tailored_md = verified_md
    result.extras["verify"] = vreport
    return result



# ---------------------------------------------------------------------------
# Production entry point — drop-in replacement for run_tailored_cv that routes
# the tailoring step through the validated w8_verified writer while preserving
# the exact (markdown, storage_path) contract the orchestrator depends on.
#
# The orchestrator hands in the upstream artifacts it already computed
# (jd_analysis/matching/ats/input_recs/feasibility) so this adds only the
# composition + entailment-verify calls — no duplicate upstream AI calls. The
# markdown is uploaded to the SAME storage path (<user_id>/<run_id>.md) via the
# production uploader, so the PDF render and storage path stay identical.
# ---------------------------------------------------------------------------


async def run_tailored_cv_w8_verified(
    client: AIClient,
    user_id: uuid.UUID,
    run_id: uuid.UUID,
    cv_text: str,
    jd_text: str,
    jd_analysis: Dict[str, Any],
    matching: Dict[str, Any],
    ats: Dict[str, Any],
    input_recs: Dict[str, Any],
    feasibility: Dict[str, Any],
    contact_details: Optional[Dict[str, Any]] = None,
) -> tuple[str, str]:
    """Returns (markdown, storage_path) — same contract as run_tailored_cv."""
    upstream = {
        "jd_analysis": jd_analysis,
        "matching":    matching,
        "ats":         ats,
        "input_recs":  input_recs,
        "feasibility": feasibility,
    }
    # Derive lexicon vertical from the already-resolved role_family stored in
    # jd_analysis. Without this the re-router (and any future vertical-aware
    # pass) silently no-ops because vertical=None bypasses all lexicon logic.
    from app.services.verticals import FAMILY_TO_LEXICON as _FAMILY_TO_VERTICAL
    vertical = _FAMILY_TO_VERTICAL.get(str(jd_analysis.get("role_family") or ""))
    result = await _writer_w8_verified(
        client, cv_text, jd_text, contact_details,
        vertical=vertical, upstream=upstream,
    )
    md = result.tailored_md
    if not md or len(md.strip()) < 200:
        raise ValueError("w8_verified tailored CV: response too short")
    # Blocking Supabase Storage upload on the DEFAULT w8_verified path — run
    # off the event loop the same way the very next call already does
    # (_persist_quality_flags), and the same way pdf_output.py's identical
    # upload_or_update call does. This was the actual instance the audit
    # meant (#12: "_impl.py:847 → tailored_cv/runner.py:98") — blocking here
    # stalls every other concurrent pipeline run sharing this event loop,
    # not just this one.
    storage_path = await asyncio.to_thread(_upload_to_storage, user_id, run_id, md)
    # Persist the honesty_guard rewrite notes alongside the run. Best-effort —
    # if migration 057 (analysis_runs.quality_flags) hasn't been applied yet,
    # this writes nothing rather than failing the pipeline.
    # Sync supabase write — run in a worker thread so the event loop stays free.
    await asyncio.to_thread(_persist_quality_flags, run_id, result)
    return md, storage_path


