"""Deterministic JD-analysis enrichment — extracted verbatim from orchestrator.py.

Three pure, synchronous passes that run around Step 1 (JD analysis):

  build_boilerplate_blob()     — provenance blob of cleaner-discarded sections
  attach_role_family_labels()  — resolved role family + family-aware category
                                 labels/order, stamped onto jd_analysis
  enrich_jd_analysis()         — the lexicon post-process pipeline: evidence
                                 gates, deterministic recall floor, credential
                                 scan/merge, section clamp, off-setting
                                 demotion, unknown-phrase tracking

All three mutate/return the jd_analysis dict; persistence (save_step_result)
stays with the orchestrator. Execution order inside enrich_jd_analysis is
load-bearing — do not reorder the passes.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def build_boilerplate_blob(jd_section_map: Dict[str, str]) -> str:
    """Belt-and-suspenders provenance for the section gates: the bodies
    of sections the cleaner discarded as boilerplate (perks/benefits/About
    Us). A credential or soft skill whose only support is here is a leak.
    Empty on the fallback path (no '_boilerplate' key) → gates no-op.
    """
    _boilerplate_blob = ""
    try:
        _bp_headings = (jd_section_map.get("_boilerplate") or "")
        if _bp_headings:
            from app.services.skills.post_process import _ground_norm
            _bp_bodies = " ".join(
                jd_section_map.get(h.strip(), "")
                for h in _bp_headings.split(",")
            )
            _boilerplate_blob = f" {_ground_norm(_bp_bodies)} "
    except Exception:  # noqa: BLE001 — provenance is best-effort
        logger.warning("boilerplate blob build: failed", exc_info=True)
    return _boilerplate_blob


def attach_role_family_labels(
    jd_analysis: Dict[str, Any],
    explicit_vertical: Optional[str],
) -> bool:
    """Attach the resolved role family + family-aware category labels so every
    downstream step and the UI render category-1 as "Clinical Skills"
    (nursing) / "Technical Skills" (tech) / "Core Skills" (manual) instead
    of the IT-default "Technical". Rides in the jd_analysis_result JSON, so
    no migration. Idempotent — recomputes only when absent (handles old
    cached analyses on resume).
    Keyed on category_order so a resume of a run enriched by an older
    label scheme recomputes against the current one.

    Returns True when jd_analysis was mutated (caller persists it).
    """
    if jd_analysis.get("category_order"):
        return False
    from app.services.eval.role_families import (
        category_labels, category_order, resolve_role_family,
    )
    _rf = resolve_role_family(explicit_vertical, jd_analysis)
    jd_analysis["role_family"] = _rf.id
    jd_analysis["category_labels"] = category_labels(_rf)
    jd_analysis["category_order"] = category_order(_rf)
    return True


def enrich_jd_analysis(
    jd_analysis: Dict[str, Any],
    *,
    jd_text: str,
    jd_text_for_llm: str,
    boilerplate_blob: str,
) -> Dict[str, Any]:
    """Lexicon post-process — re-classify the LLM's raw skill buckets via
    the curated per-vertical lexicon. Drops universal noise (credentials,
    eligibility statements, framework/value phrases) from skill buckets,
    moves mis-bucketed skills to their canonical category, dedupes by
    canonical form. Unknown phrases stay in the LLM-assigned bucket (safe
    fallback). The sidecar (lexicon_meta) holds the dropped/moved items
    for downstream routing (credentials → Registration & Licences) and
    diagnostics. Idempotent — the caller keys on the presence of
    `lexicon_meta` before invoking.

    jd_text is the RAW payload text (evidence gate, section clamp, setting
    demotion need the full unmodified JD); jd_text_for_llm is the cleaned
    text (boilerplate stripped).
    """
    # JD-body lexicon scan — surface canonical domain_knowledge skills
    # the IT-centric JD analysis prompt missed in prose-heavy
    # responsibilities. Closes the ATS-score variance caused by an
    # empty domain bucket triggering presence-aware redistribution.
    # Runs BEFORE post_process_jd_analysis so injected canonicals flow
    # through the same dedup / sidecar path as LLM-extracted ones.
    from app.services.skills import (
        drop_ungrounded_soft_skills,
        enrich_required_skills_from_jd_body,
        post_process_jd_analysis,
        verify_skill_evidence,
    )
    from app.services.skills.post_process import (
        _dedup_keep_order,
        extract_credentials_from_jd,
    )
    # Phase-1 groundedness gate — drop LLM-extracted skills whose
    # evidence quote isn't in the JD (hallucinations) BEFORE the
    # deterministic floor below adds any lexicon-verified extras.
    # Gate only sees the LLM's output; the floor is trusted by
    # construction (it's a curated regex against the JD body).
    jd_analysis = verify_skill_evidence(
        jd_analysis,
        jd_text,
        role_family_id=str(jd_analysis.get("role_family") or "master"),
    )
    # Soft-skill grounding gate — drop LLM soft skills with no verbatim
    # canonical/variant in the JD (e.g. "reliability"/"flexibility"
    # inferred from employer-preference prose). Runs before the floor,
    # which re-adds any genuinely grounded soft skill.
    jd_analysis = drop_ungrounded_soft_skills(
        jd_analysis,
        jd_text,
        role_family_id=str(jd_analysis.get("role_family") or "master"),
        skill_text=jd_text_for_llm,
    )
    jd_analysis = enrich_required_skills_from_jd_body(
        jd_analysis,
        jd_text,
        role_family_id=str(jd_analysis.get("role_family") or "master"),
        skill_text=jd_text_for_llm,
    )
    jd_analysis = post_process_jd_analysis(
        jd_analysis,
        role_family_id=str(jd_analysis.get("role_family") or "master"),
    )

    # Deterministic credential scan over the cleaned JD text — catches
    # credentials the LLM correctly excluded from skills (so the sidecar
    # is empty) but that are explicitly listed in the JD. Merges with
    # any sidecar-derived credentials already in jd_analysis["credentials"].
    try:
        _cred_drops: list = []
        scanned = extract_credentials_from_jd(
            jd_text_for_llm,
            boilerplate_blob=boilerplate_blob,
            drops_out=_cred_drops,
        )
        if _cred_drops:
            _meta = dict(jd_analysis.get("lexicon_meta") or {})
            _meta["boilerplate_dropped_credentials"] = (
                list(_meta.get("boilerplate_dropped_credentials") or [])
                + _cred_drops
            )
            jd_analysis["lexicon_meta"] = _meta
            logger.info(
                "credential scan: dropped %d offer/boilerplate phrases — %s",
                len(_cred_drops), [d["phrase"] for d in _cred_drops],
            )
        existing_creds = jd_analysis.get("credentials") or {}
        jd_analysis["credentials"] = {
            "required":    _dedup_keep_order(
                list(existing_creds.get("required") or [])
                + scanned["required"]
            ),
            "preferred":   _dedup_keep_order(
                list(existing_creds.get("preferred") or [])
                + scanned["preferred"]
            ),
            "eligibility": _dedup_keep_order(
                list(existing_creds.get("eligibility") or [])
                + scanned["eligibility"]
            ),
        }
    except Exception:  # noqa: BLE001
        logger.warning("credential scan: failed", exc_info=True)

    # Essential vs Desirable deterministic clamp — move skills between
    # required ↔ preferred where the JD's section headers contradict
    # the LLM's bucketing (classic miss: "Basic computer and smartphone
    # working knowledge" sits under Desirable but the LLM put it in
    # required.technical). Idempotent; no-op when no section headers.
    try:
        from app.services.skills.post_process import clamp_by_jd_sections
        jd_analysis = clamp_by_jd_sections(jd_analysis, jd_text)
    except Exception:  # noqa: BLE001 — never block on a heuristic
        logger.warning("section clamp: failed", exc_info=True)

    # Off-setting boilerplate demotion: for a residential aged-care JD
    # whose About-Us / brand prose leaks "disability support" or
    # "mental health support" into required skills, move them to
    # preferred so they don't drive the required-match score.
    # Deterministic; conservative (only RESIDENTIAL currently).
    try:
        from app.services.eval.writers import _classify_jd_setting
        from app.services.skills.post_process import demote_off_setting_keywords
        _setting = _classify_jd_setting(jd_text, jd_analysis)
        jd_analysis = demote_off_setting_keywords(jd_analysis, _setting)
    except Exception:  # noqa: BLE001 — never block on a heuristic
        logger.warning("off-setting demotion: failed", exc_info=True)

    # Best-effort: record any unknown phrases (lexicon gaps) to the
    # rolling JSONL log so weekly reviews can promote high-frequency
    # phrases into the lexicon. Pipeline never blocks on tracking.
    try:
        from datetime import datetime
        from app.services.skills.unknown_tracker import record_unknown_phrases
        record_unknown_phrases(
            role_family_id=str(jd_analysis.get("role_family") or "master"),
            job_title=str(jd_analysis.get("job_title") or "") or None,
            lexicon_meta=jd_analysis.get("lexicon_meta"),
            timestamp=datetime.utcnow().isoformat(),
        )
    except Exception:  # noqa: BLE001 — observability must never block
        logger.debug("unknown_tracker: failed to record", exc_info=True)

    return jd_analysis
