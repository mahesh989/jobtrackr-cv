"""The tailored-CV invariant set — one declared list, applied on both sides
of every AI step.

WHY THIS EXISTS
---------------
``verify_claims`` (and the summary-floor retry after it) are AI steps that
REWRITE the tailored CV. Every deterministic pass that ran before them can
therefore be undone: a stripped Certifications section comes back, a stamped
credential line is reworded, a recovered degree disappears again.

Until this module existed, the remedy was a hand-maintained second sequence
of "re-run" calls inside ``_writer_w8_verified``. That sequence was a strict
SUBSET of the passes applied pre-verify, and the gap was invisible: adding a
pass pre-verify silently created a new post-verify hole, and nothing tested
that the two sides agreed. PRs #249-#257 each fixed one instance of that gap,
reactively, after a user report; ``docs/POST_VERIFY_INVARIANTS.md`` lists the
17 that were still open when this module was written.

THE RULE
--------
There is ONE list — ``INVARIANTS`` below. It is applied by
``apply_invariants`` after the composition AI call, again after
``verify_claims``, and again after the summary-floor retry. Anything that
belongs in "a structurally valid tailored CV" goes in the list; adding it
there gives it a pre- AND post-verify life automatically, and
``tests/test_post_verify_invariants.py`` fails if a pass is called on only
one side.

WHAT MAY *NOT* GO IN THE LIST
-----------------------------
* **AI calls.** The list is deterministic and synchronous by construction.
  The escalation path stays as it is: deterministic repair first, then the
  single AI rewrite in ``_ensure_career_highlights_floor`` for the defects a
  deterministic pass cannot fix (garbled prose, tool names, too many
  specialisations) — never in-place prose surgery.
* **Non-idempotent / ordering-sensitive passes.** ``to_canonical`` and
  ``restore_and_order`` rename headings in opposite directions; running them
  twice would rename a document out of the shape every other pass expects.
  ``test_invariants_are_a_fixpoint`` pins idempotency for everything here.

ORDER IS LOAD-BEARING
---------------------
The sequence mirrors the pre-verify order it replaced. Constraints that
already cost an incident each:

* ``_promote_qualification_cert_to_education`` → ``_strip_certs_when_excluded``
  → ``_strip_certs_when_projects_exist`` (promote an AQF qual out before the
  section is dropped; see credentials.py).
* ``split_awards_and_certifications`` runs BEFORE the cert strips — it can
  itself materialise a fresh ``## Certifications`` heading out of mixed
  Awards content.
* ``stamp_credentials`` runs BEFORE the awards split so it can dedupe against
  Registration content.
* ``recap_summary_preserving_anchors`` runs BEFORE ``_enforce_company_anchor``
  — the anchor pass appends and is budget-aware, so capping after it would
  trim the anchor straight back off (see employers.py).
* ``_enforce_summary_s1_title_case`` runs BEFORE ``_enforce_summary_opener``
  so an inserted JD title keeps the JD's own casing.
* The cap-aware skills tail (``enforce_skills_section`` →
  ``_inject_approved_skills`` → ``force_inject_missed_approved``) must not be
  followed by another ``enforce_skills_section``: that truncates the
  just-placed approved keywords off the tail (the pre-Fix-C regression).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from app.services.cv.contact_line import (
    stamp_availability_in_summary,
    stamp_credentials,
    stamp_references,
)
from app.services.eval.enforce import enforce_skills_section, reroute_skills_by_lexicon
from app.services.eval.enforce_w8 import ensure_bachelor
from app.services.eval.writers.awards import (
    _normalise_awards_entries,
    _relabel_awards_only_certifications,
    _strip_ungrounded_credentials,
    ensure_awards,
    split_awards_and_certifications,
)
from app.services.eval.writers.bridges import _apply_setting_bridge
from app.services.eval.writers.experience import (
    normalise_date_formats,
    normalise_experience_tense,
    sort_experience_chronologically,
)
from app.services.eval.writers.honesty_guard import (
    enforce_credential_claims,
    enforce_source_dates,
    enforce_source_settings,
    pin_skills_section_labels,
)
from app.services.eval.writers.injection import (
    _drop_subsumed_generic_skills,
    _inject_approved_skills,
    _move_misplaced_technical_skills,
    _surface_cv_named_tools,
    _surface_matched_skills,
    force_inject_missed_approved,
)
from app.services.eval.writers.skills_section import (
    _dedupe_skills_across_lines,
    _normalise_skills_case,
    _strip_non_skill_phrases,
)
from app.services.eval.writers.spelling_case import (
    canonicalise_body_spelling,
    normalise_heading_title_case,
)
from app.services.eval.writers.summary_anchors import _apply_display_heading
from app.services.pipeline.steps.tailored_cv import (
    _dedup_career_highlights,
    _dedup_project_bullets,
    _enforce_company_anchor,
    _enforce_education_count,
    _enforce_other_skills_chars,
    _enforce_summary_opener,
    _enforce_summary_s1_title_case,
    _flag_vague_anchor,
    _inject_missing_skills,
    _lowercase_generic_care_phrases,
    _promote_qualification_cert_to_education,
    _strip_certs_when_excluded,
    _strip_certs_when_projects_exist,
    _strip_education_bullets,
    build_family_label_map,
    recap_summary_preserving_anchors,
)

logger = logging.getLogger(__name__)


@dataclass
class InvariantContext:
    """Everything the deterministic passes need, resolved once per run.

    Built by ``build_context`` so the pre-verify and post-verify applications
    are provably given the same inputs — a mismatched ``cv_text`` between the
    two sides would reintroduce exactly the class of divergence this module
    exists to close.
    """

    #: The SOURCE view every pass grounds against: the original CV with any
    #: roles the JD's vertical excludes already filtered out. One field, not
    #: two: giving some passes the unfiltered CV lets them re-surface a role
    #: composition that was deliberately excluded (C67), and giving the two
    #: sides of verify_claims different views is the divergence this module
    #: exists to prevent.
    cv_text: str
    jd_text: str
    jd_analysis: Dict[str, Any]
    role_family: Any
    vertical: Optional[str] = None
    contact_details: Optional[Dict[str, Any]] = None
    feasibility: Optional[Dict[str, Any]] = None
    matching: Optional[Dict[str, Any]] = None
    cert_policy: str = ""
    jd_setting: str = ""
    jd_job_title: str = ""
    #: False when the JD's own job title is not backed by the CV's role
    #: family — the opener enforcer then flags rather than fabricating an
    #: identity the CV cannot support.
    title_supported: bool = True
    #: Accumulated user-facing rewrite notes (surfaced as run quality_flags).
    notes: List[str] = field(default_factory=list)

    @property
    def skills_headline_label(self) -> Optional[str]:
        """Nursing's already-resolved care/clinical/core subtype label, else
        None (other families keep the family-level fallback)."""
        if self.role_family.id != "nursing":
            return None
        return self.role_family.skills_categories[0]

    @property
    def injects_skills(self) -> bool:
        """False for the "none" injection policy (trades), where the minimal
        Skills section is intentional."""
        return self.role_family.injection_policy != "none"


#: A pass: ``(markdown, ctx) -> markdown``. Notes are appended to ``ctx.notes``.
InvariantFn = Callable[[str, InvariantContext], str]


@dataclass(frozen=True)
class Invariant:
    name: str
    fn: InvariantFn


def _noting(fn: Callable[..., Any]) -> Callable[..., str]:
    """Adapt a ``(md, ...) -> (md, notes)`` guard into an invariant pass."""

    def _call(md: str, ctx: InvariantContext, *args: Any, **kwargs: Any) -> str:
        md, notes = fn(md, *args, **kwargs)
        for note in notes:
            if note not in ctx.notes:
                ctx.notes.append(note)
        return md

    return _call


def _opener(md: str, ctx: InvariantContext) -> str:
    """Forbidden-opener strip + title-honesty gate, with its own note."""
    out = _enforce_summary_opener(
        md, ctx.jd_job_title, title_supported=ctx.title_supported
    )
    if out != md:
        note = (
            "Adjusted the summary opener to the candidate's CV-aligned role title"
            if ctx.title_supported else
            "Summary opener: the JD's role title isn't supported by the CV's "
            "experience — flagged for a manual title rather than fabricating alignment"
        )
        if note not in ctx.notes:
            ctx.notes.append(note)
    return out


#: The invariant set. One ordered list, applied on BOTH sides of every AI
#: step. See the module docstring for what may not be added here.
INVARIANTS: tuple[Invariant, ...] = (
    # ── Grounding ────────────────────────────────────────────────────────
    # An AI step can rewrite/reintroduce a fabricated credential entry into a
    # Certifications/Checks section; anything it fabricates was never checked
    # against the source CV at all (C22p).
    Invariant("strip_ungrounded_credentials",
              lambda md, c: _strip_ungrounded_credentials(md, c.cv_text)),

    # ── Awards section shape ─────────────────────────────────────────────
    # An AI step can rewrite the Awards/Certifications section into a messy
    # shape (e.g. a description promoted to ###).
    Invariant("relabel_awards_only_certifications",
              lambda md, c: _relabel_awards_only_certifications(md)),
    Invariant("normalise_awards_entries",
              lambda md, c: _normalise_awards_entries(md)),

    # ── Skills: hygiene, then honest re-surfacing ────────────────────────
    # The 80-char Other Skills cap runs BEFORE the injectors, mirroring
    # _enforce_structure's own ordering — capping after them would truncate
    # the keywords they just placed.
    Invariant("enforce_other_skills_chars",
              lambda md, c: _enforce_other_skills_chars(md, max_chars=80)),
    Invariant("enforce_skills_section", lambda md, c: enforce_skills_section(md)),
    Invariant("inject_missing_skills",
              lambda md, c: _inject_missing_skills(
                  md, c.feasibility,
                  family_label_map=build_family_label_map(c.role_family),
              )),
    # Re-surface JD terms the matcher confirmed but a rewrite dropped, so the
    # tailored CV never scores BELOW the original on keywords it already had.
    Invariant("surface_matched_skills",
              lambda md, c: _surface_matched_skills(
                  md, c.matching or {}, original_cv_text=c.cv_text,
              ) if c.injects_skills else md),
    # CV-named brand tools (BESTMed, Leecare, …) are the candidate's own
    # differentiators — a rewrite must not be allowed to drop them.
    Invariant("surface_cv_named_tools",
              lambda md, c: _surface_cv_named_tools(md, c.cv_text, c.role_family)
              if c.injects_skills else md),
    Invariant("move_misplaced_technical_skills",
              lambda md, c: _move_misplaced_technical_skills(md, c.role_family)
              if c.injects_skills else md),
    Invariant("strip_non_skill_phrases", lambda md, c: _strip_non_skill_phrases(md)),
    Invariant("reroute_skills_by_lexicon",
              lambda md, c: reroute_skills_by_lexicon(md, c.vertical)),
    Invariant("enforce_skills_section_after_reroute",
              lambda md, c: enforce_skills_section(md)),
    Invariant("normalise_skills_case", lambda md, c: _normalise_skills_case(md)),
    Invariant("dedupe_skills_across_lines",
              lambda md, c: _dedupe_skills_across_lines(md)),

    # ── Deterministic content recovery ───────────────────────────────────
    # A dropped baseline degree / award is re-added from the source CV.
    # Grounded by construction: both read from cv_text.
    Invariant("ensure_bachelor", lambda md, c: ensure_bachelor(md, c.cv_text)),
    Invariant("ensure_awards", lambda md, c: ensure_awards(md, c.cv_text)),

    # ── User-authoritative stamps ────────────────────────────────────────
    # The user's saved profile — not the model — is the authority on which
    # credentials and referees they actually have. Honesty-critical.
    Invariant("stamp_credentials",
              lambda md, c: stamp_credentials(md, c.contact_details, c.role_family.id)),
    Invariant("stamp_references",
              lambda md, c: stamp_references(md, c.contact_details)),

    # ── Certifications / Education structure ─────────────────────────────
    Invariant("split_awards_and_certifications",
              lambda md, c: split_awards_and_certifications(md)),
    Invariant("normalise_awards_entries_after_split",
              lambda md, c: _normalise_awards_entries(md)),
    Invariant("promote_qualification_cert_to_education",
              lambda md, c: _promote_qualification_cert_to_education(md, c.cert_policy)),
    Invariant("strip_certs_when_excluded",
              lambda md, c: _strip_certs_when_excluded(md, c.cert_policy)),
    Invariant("strip_certs_when_projects_exist",
              lambda md, c: _strip_certs_when_projects_exist(md, c.cert_policy)),
    Invariant("enforce_education_count",
              lambda md, c: _enforce_education_count(md, max_entries=3)),
    Invariant("strip_education_bullets", lambda md, c: _strip_education_bullets(md)),
    Invariant("dedup_career_highlights", lambda md, c: _dedup_career_highlights(md)),
    Invariant("dedup_project_bullets", lambda md, c: _dedup_project_bullets(md)),

    # ── Experience + body text normalisation ─────────────────────────────
    Invariant("sort_experience_chronologically",
              lambda md, c: sort_experience_chronologically(md)),
    Invariant("normalise_experience_tense",
              lambda md, c: normalise_experience_tense(md)),
    Invariant("canonicalise_body_spelling",
              lambda md, c: canonicalise_body_spelling(md)),
    Invariant("normalise_heading_title_case",
              lambda md, c: normalise_heading_title_case(md)),
    Invariant("normalise_date_formats", lambda md, c: normalise_date_formats(md)),

    # ── Summary honesty ──────────────────────────────────────────────────
    # Deterministic S1 setting bridge — only where the CV's Experience
    # evidences the target setting, otherwise S1 stays as-is rather than
    # fabricate cross-setting experience (C82).
    Invariant("apply_setting_bridge",
              lambda md, c: _apply_setting_bridge(
                  md, c.jd_setting, cv_text=c.cv_text,
              )),
    Invariant("enforce_source_dates",
              lambda md, c: _noting(enforce_source_dates)(md, c, c.cv_text)),
    Invariant("enforce_source_settings",
              lambda md, c: _noting(enforce_source_settings)(md, c, c.cv_text)),
    Invariant("pin_skills_section_labels",
              lambda md, c: _noting(pin_skills_section_labels)(
                  md, c, c.role_family.id,
                  resolved_headline_label=c.skills_headline_label,
              )),
    Invariant("enforce_credential_claims",
              lambda md, c: _noting(enforce_credential_claims)(md, c, c.contact_details)),
    Invariant("enforce_summary_s1_title_case",
              lambda md, c: _enforce_summary_s1_title_case(md)),
    Invariant("enforce_summary_opener", _opener),
    Invariant("lowercase_generic_care_phrases",
              lambda md, c: _lowercase_generic_care_phrases(md)),

    # ── Cap-aware skills injection tail ──────────────────────────────────
    # Hard cap FIRST so each line is at DEFAULT_SKILL_CAPS before injection,
    # then cap-aware inject. NOTHING may re-cap after this point.
    Invariant("enforce_skills_section_before_inject",
              lambda md, c: enforce_skills_section(md)),
    Invariant("inject_approved_skills",
              lambda md, c: _inject_approved_skills(md, c.feasibility)),
    Invariant("drop_subsumed_generic_skills",
              lambda md, c: _drop_subsumed_generic_skills(md)),
    Invariant("normalise_skills_case_after_inject",
              lambda md, c: _normalise_skills_case(md)),
    Invariant("dedupe_skills_across_lines_after_inject",
              lambda md, c: _dedupe_skills_across_lines(md)),
    # Belt-and-braces for approved keywords the regular injector dropped via
    # a label mismatch (category=technical on a family with no Technical
    # Skills line).
    Invariant("force_inject_missed_approved",
              lambda md, c: _noting(force_inject_missed_approved)(md, c, c.feasibility)),

    # ── Summary caps + anchors ───────────────────────────────────────────
    Invariant("flag_vague_anchor", lambda md, c: _flag_vague_anchor(md)),
    Invariant("recap_summary_preserving_anchors",
              lambda md, c: recap_summary_preserving_anchors(md)),
    Invariant("enforce_company_anchor",
              lambda md, c: _enforce_company_anchor(md, c.cv_text)),

    # ── Final stamps / display ───────────────────────────────────────────
    # The availability note and the displayed summary heading are stamped
    # LAST: an AI step can bundle the italic "*Available: …*" line into the
    # summary prose and delete it (OPS-31), and can add or remove the years
    # figure the heading choice is derived from (C83).
    Invariant("stamp_availability_in_summary",
              lambda md, c: stamp_availability_in_summary(
                  md, c.contact_details, c.role_family.id,
              )),
    Invariant("apply_display_heading", lambda md, c: _apply_display_heading(md)),
)

#: Fast membership check for tests and callers.
INVARIANT_NAMES: tuple[str, ...] = tuple(inv.name for inv in INVARIANTS)


def apply_invariants(markdown: str, ctx: InvariantContext) -> str:
    """Apply every invariant, in order, to ``markdown``.

    Call this after EVERY AI step that can touch the document. It is
    deterministic, synchronous and idempotent, so a redundant call costs
    only CPU — while a missing one is precisely the bug class this module
    was written to close.
    """
    for inv in INVARIANTS:
        try:
            markdown = inv.fn(markdown, ctx)
        except Exception:  # noqa: BLE001
            # One malfunctioning pass must not cost the user their CV: log
            # it, keep the markdown as it stood, and carry on. Silently
            # dropping the exception is deliberate — every pass here is a
            # repair, not a gate.
            logger.exception("invariant %s failed; keeping markdown unchanged", inv.name)
    return markdown


def build_context(
    *,
    cv_text: str,
    jd_text: str,
    jd_analysis: Optional[Dict[str, Any]],
    role_family: Any,
    vertical: Optional[str] = None,
    contact_details: Optional[Dict[str, Any]] = None,
    feasibility: Optional[Dict[str, Any]] = None,
    matching: Optional[Dict[str, Any]] = None,
    jd_setting: str = "",
) -> InvariantContext:
    """Resolve the invariant context once per run.

    ``cv_text`` must be the ROLE-FILTERED view (see InvariantContext).

    ``title_supported`` is derived here rather than at the call sites: the
    honesty rule is that the JD's job title may only become the summary
    opener when it shares the candidate's own role family — inserting an
    off-axis title ("Pharmacy Technician" on an aged-care CV) fabricates an
    identity the CV cannot support.
    """
    from app.services.eval.role_families import resolve_role_family

    jd_analysis = jd_analysis or {}
    cv_family = resolve_role_family(None, {"summary": cv_text}).id
    return InvariantContext(
        cv_text=cv_text,
        jd_text=jd_text,
        jd_analysis=jd_analysis,
        role_family=role_family,
        vertical=vertical,
        contact_details=contact_details,
        feasibility=feasibility,
        matching=matching,
        cert_policy=getattr(role_family, "cert_policy", "") or "",
        jd_setting=jd_setting,
        jd_job_title=str(jd_analysis.get("job_title") or ""),
        title_supported=cv_family == role_family.id,
    )
