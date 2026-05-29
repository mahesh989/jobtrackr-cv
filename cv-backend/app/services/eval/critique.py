"""
Stage 5 — AI critique-and-repair (the quality counterpart to W8.1's honesty
verifier).

verify_claims (verify.py) answers ONE question: "is every bullet TRUE?" It strips
inflation but it cannot tell you the CV is weakly targeted — a draft can be 100%
honest and still bury the JD's core skills, over-weight an off-axis role, or lead
with a vague summary. This module adds the missing pass:

  one focused AI call acting as a senior recruiter + ATS reviewer. It reads the
  JD, the tailored draft, and the ORIGINAL CV, then returns a REVISED draft that
  is better targeted — stronger summary, JD themes surfaced, off-axis weight
  trimmed, weak bullets sharpened — WITHOUT inventing a single fact.

Honesty is enforced by construction, not trust:
  1. The prompt hard-bans adding any tool/metric/scope/domain not in the original.
  2. The family's injection_policy tunes strictness (nursing/manual = no
     inference at all; tech = synonym/parent surfacing allowed).
  3. The caller re-runs the FULL deterministic enforce layer (ungrounded-strip,
     caps, structure, family order) AND the entailment verifier on the result —
     so any fact the critique slips in is mechanically removed afterward. The
     critique can only ever make things WORSE-honest if the safety net fails,
     and the safety net is the same proven code the verified path already uses.

Best-effort: any failure (AI error, malformed/short/empty revision, no headings)
returns the input unchanged so the writer never crashes or regresses.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Tuple

from app.services.ai.client import AIClient, AIClientError
from app.services.eval.role_families import RoleFamilyProfile

logger = logging.getLogger(__name__)


_CRITIQUE_SYSTEM = """You are a senior technical recruiter and ATS expert editing
a candidate's already-tailored CV so it competes harder for ONE specific job —
without ever lying.

You are given: the JOB DESCRIPTION, the candidate's ORIGINAL CV (the only source
of truth), and a DRAFT tailored CV. Produce a REVISED tailored CV that beats the
draft on JD-fit and impact.

NON-NEGOTIABLE HONESTY (the revision is mechanically fact-checked afterward, so
violations are wasted effort):
- Use ONLY facts present in the ORIGINAL CV. Never add a tool, technology,
  metric, number, employer, scope, seniority, domain, certification or outcome
  the original does not state.
- Rewording and reframing are fine; new facts are not. If the draft has a number
  the original supports, keep it; never invent one.
{honesty_policy}

WHAT TO IMPROVE (only using truthful material):
- SUMMARY: lead with the JD's core role + the candidate's genuinely matching
  specialisations and strongest honest signal. Cut filler and off-axis identity.
- JD THEMES: when the JD emphasises a theme (e.g. data quality, stakeholder
  reporting, patient safety, reliability), surface the candidate's REAL adjacent
  work that evidences it. Mirror the JD's outcome vocabulary on achievements the
  CV truly supports — never on ones it doesn't.
- SCALE: when the JD stresses volume/scale and the original CV contains real
  figures (record counts, dataset sizes, user/site/patient/transaction volumes),
  surface them. Never invent a figure.
- WEIGHT BY RELEVANCE: on-axis roles carry 2-3 bullets; a largely off-axis role
  (its title/domain doesn't match the JD's discipline) gets EXACTLY ONE bullet —
  its single most transferable achievement. Keep reverse-chronological order; do
  not reorder or delete whole roles.
- ON-AXIS FACET: when you keep an off-axis role/project, frame it by the facet
  that matches the JD, not its off-axis aspect.
- BULLETS: sharpen vague bullets into specific, outcome-first lines. Keep every
  real metric; never add one.
- DO NOT change section headings, add or remove sections, or alter contact info,
  dates, employers, or education — structure is owned downstream. Edit only the
  prose inside Summary, Experience, Projects and Skills.

Return JSON:
{{"issues": [<=5 short strings naming the biggest JD-fit gaps you fixed],
  "revised_cv": "<the full revised CV in the SAME markdown structure as the draft>"}}
If the draft is already strong and you would change nothing material, return it
unchanged as revised_cv with issues: []."""


_CRITIQUE_USER = """JOB DESCRIPTION:
\"\"\"
{jd_text}
\"\"\"

ORIGINAL CV (the ONLY source of truth — every fact in your revision must trace to here):
\"\"\"
{cv_text}
\"\"\"

DRAFT TAILORED CV TO IMPROVE:
\"\"\"
{draft_md}
\"\"\"

Return the JSON object now."""


def _honesty_policy_block(rf: RoleFamilyProfile) -> str:
    """Family-specific strictness line injected into the system prompt."""
    if rf.injection_policy == "none":
        return (
            "- This is a trust-first field: do NOT infer or imply ANY skill, "
            "check, or competency. Surface only what the original states, plainly."
        )
    if rf.injection_policy == "direct_only":
        return (
            "- NEVER infer a competency the original does not state; surface only "
            "skills literally present. (In licensed/regulated fields an invented "
            "skill is a registration-fraud and safety risk.)"
        )
    # aggressive (tech/data): honest synonym + child->parent surfacing allowed
    return (
        "- You MAY surface a JD term the original genuinely justifies as a synonym "
        "or parent of something the candidate has (e.g. CV says PostgreSQL -> JD's "
        "'SQL' is fair). Never claim a domain the CV doesn't support."
    )


def _looks_like_cv(md: str) -> bool:
    """A usable revision has real markdown section headings and enough body."""
    if not md or len(md.strip()) < 200:
        return False
    return md.count("##") >= 2


async def critique_and_repair(
    client: AIClient,
    draft_md: str,
    original_cv_text: str,
    jd_text: str,
    rf: RoleFamilyProfile,
) -> Tuple[str, Dict[str, Any]]:
    """
    Run one JD-aware critique pass and return (revised_markdown, report).

    Never raises: on any AI error or unusable revision, returns draft_md unchanged
    with the reason in report["error"]. The caller is expected to re-run the
    deterministic enforce layer + entailment verifier on the result.
    """
    report: Dict[str, Any] = {"applied": False, "issues": []}
    if not _looks_like_cv(draft_md):
        report["error"] = "draft too short to critique"
        return draft_md, report

    system = _CRITIQUE_SYSTEM.format(honesty_policy=_honesty_policy_block(rf))
    user = _CRITIQUE_USER.format(
        jd_text=jd_text, cv_text=original_cv_text, draft_md=draft_md,
    )

    try:
        data = await client.complete_json(
            system=system,
            user=user,
            max_tokens=6144,
            temperature=0.3,
        )
    except (AIClientError, Exception) as exc:  # noqa: BLE001 — best-effort
        logger.warning("critique_and_repair: AI call failed (%s) — keeping draft", exc)
        report["error"] = str(exc)
        return draft_md, report

    revised = (data or {}).get("revised_cv")
    issues = (data or {}).get("issues")
    if isinstance(issues, list):
        report["issues"] = [str(x) for x in issues][:5]

    if not isinstance(revised, str) or not _looks_like_cv(revised):
        report["error"] = "revision missing or not a usable CV"
        return draft_md, report

    revised = revised.strip()
    report["applied"] = revised != draft_md.strip()
    return revised, report
