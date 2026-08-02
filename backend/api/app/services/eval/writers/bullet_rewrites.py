"""Targeted bullet rewrites — extracted from writers._impl.

Rewrites individual experience bullets to carry missing JD keywords without
touching the rest of the document.
Self-contained; moved verbatim (own module logger).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, Optional, Tuple
import asyncio
import re

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Targeted bullet rewrite pass.
#
# After composition + verify_claims + all deterministic passes, some
# inject_as_extension keywords from the feasibility plan may still be absent
# from the generated CV — the composition LLM paraphrased instead of applying
# the approved rewrite. This pass detects missed items and runs one small,
# focused LLM call per bullet to incorporate the keyword.
#
# Only fires for inject_as_extension (not inject_directly — those are Skills
# section items already handled by _inject_approved_skills; not
# inject_with_inference — inference is too speculative for auto-rewrite).
#
# Role-category labels (home care, aged care, disability support …) reach this
# function and are correctly injected into bullets/summary — they are NOT
# filtered here. The Skills-section filter (_ROLE_CATEGORY_LABELS) runs
# separately in _approved_skill_entries and reroute_skills_by_lexicon.
# ---------------------------------------------------------------------------

_BULLET_MARKERS: Tuple[str, ...] = ("- ", "* ", "• ")

def _kw_norm(text: str) -> str:
    """Lower + collapse non-alphanumerics to single spaces, padded for substring checks."""
    return " " + re.sub(r"[^a-z0-9]+", " ", text.lower()).strip() + " "

async def _targeted_bullet_rewrites(
    client: "AIClient",
    markdown: str,
    feasibility: Optional[Dict[str, Any]],
) -> str:
    """Inject missed inject_as_extension keywords into experience bullets.

    For each approved extension keyword absent from the generated CV, find the
    most relevant experience bullet, then run ONE focused LLM call per bullet
    that incorporates ALL keywords routed to it. Grouping by bullet is what
    makes this collision-proof: two keywords sharing the same evidence (and
    therefore the same target bullet) are handled in a single rewrite rather
    than two concurrent calls that clobber each other's write.

    Each call's result is kept only if at least one of its keywords actually
    landed in the rewrite — otherwise the original bullet is preserved (the LLM
    paraphrased without using the phrase, so the rewrite buys nothing and risks
    fidelity loss).

    Returns the markdown unchanged when there are no missed items (zero latency
    cost on a clean run).
    """
    plan = (feasibility or {}).get("feasibility_plan") or {}
    extensions = plan.get("inject_as_extension") or []
    if not extensions:
        return markdown

    md_norm = _kw_norm(markdown)

    def _kw_present_in(text_norm: str, kw: str) -> bool:
        kn = _kw_norm(kw).strip()
        return bool(kn) and (" " + kn + " ") in text_norm

    missed = [
        e for e in extensions
        if isinstance(e, dict)
        and str(e.get("keyword") or "").strip()
        and not _kw_present_in(md_norm, str(e.get("keyword")))
    ]
    if not missed:
        return markdown

    logger.info(
        "targeted_bullet_rewrites: %d missed inject_as_extension item(s): %s",
        len(missed), [str(e.get("keyword")) for e in missed],
    )

    lines = markdown.split("\n")

    # Locate ## Skills section so we never rewrite Skills lines.
    skills_start = next(
        (i for i, ln in enumerate(lines) if ln.strip().lower() == "## skills"), None
    )
    skills_end = len(lines)
    if skills_start is not None:
        for i in range(skills_start + 1, len(lines)):
            if lines[i].startswith("## "):
                skills_end = i
                break

    def _is_experience_bullet(i: int, line: str) -> bool:
        stripped = line.strip()
        if not stripped.startswith(_BULLET_MARKERS):
            return False
        if ":**" in stripped:      # Skills label line, e.g. "- **Care Skills:** ..."
            return False
        if skills_start is not None and skills_start < i < skills_end:
            return False
        return True

    def _find_best_bullet(evidence: str) -> Optional[int]:
        """Index of the experience bullet that best matches `evidence`."""
        ev_words = set(re.sub(r"[^a-z0-9 ]+", " ", evidence.lower()).split())
        if not ev_words:
            return None
        best_idx, best_score = None, 0
        for i, line in enumerate(lines):
            if not _is_experience_bullet(i, line):
                continue
            lw = set(re.sub(r"[^a-z0-9 ]+", " ", line.lower()).split())
            score = len(ev_words & lw)
            if score > best_score:
                best_score, best_idx = score, i
        return best_idx if best_score >= 3 else None

    # Group missed keywords by target bullet index. Each entry carries its
    # keyword + the plan's suggested_rewrite (a strong, pre-vetted reference).
    by_bullet: Dict[int, list] = {}
    for entry in missed:
        kw = str(entry.get("keyword") or "").strip()
        evidence = str(entry.get("evidence") or "").strip()
        if not evidence:
            logger.info("targeted_bullet_rewrites: no evidence for %r — skipped", kw)
            continue
        idx = _find_best_bullet(evidence)
        if idx is None:
            logger.info("targeted_bullet_rewrites: no matching bullet for %r — skipped", kw)
            continue
        by_bullet.setdefault(idx, []).append({
            "keyword": kw,
            "suggested_rewrite": str(entry.get("suggested_rewrite") or "").strip(),
        })

    if not by_bullet:
        return markdown

    def _strip_marker(line: str) -> str:
        s = line.strip()
        for mk in _BULLET_MARKERS:
            if s.startswith(mk):
                return s[len(mk):].strip()
        return s.lstrip("-*•").strip()

    async def _rewrite_bullet(idx: int, items: list) -> Optional[tuple]:
        original = _strip_marker(lines[idx])
        keywords = [it["keyword"] for it in items]
        kw_block = "\n".join(f"- {it['keyword']}" for it in items)
        ref_block = "\n".join(
            f"- {it['suggested_rewrite']}" for it in items if it["suggested_rewrite"]
        )
        try:
            rewritten = await client.complete(
                system=(
                    "You are a CV bullet editor. Rewrite the provided experience bullet "
                    "to naturally incorporate ALL of the listed keyword phrases. "
                    "Rules: preserve every existing fact verbatim; do not invent new "
                    "claims, employers, metrics, or credentials; every listed keyword "
                    "must appear in your rewrite; keep it to one concise sentence. "
                    "Return only the rewritten bullet text — no dash prefix, no commentary."
                ),
                user=(
                    f"Keywords to incorporate:\n{kw_block}\n\n"
                    f"Bullet to rewrite:\n{original}\n\n"
                    + (f"Reference rewrites (already vetted for honesty):\n{ref_block}\n"
                       if ref_block else "")
                ),
                max_tokens=220,
                temperature=0.2,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("targeted_bullet_rewrites: LLM call failed for bullet %d: %s", idx, exc)
            return None

        if not rewritten or len(rewritten.strip()) < 20:
            return None
        candidate = rewritten.strip()
        cand_norm = _kw_norm(candidate)
        landed = [k for k in keywords if _kw_present_in(cand_norm, k)]
        if not landed:
            logger.info(
                "targeted_bullet_rewrites: bullet %d rewrite dropped — no keyword landed (%s)",
                idx, keywords,
            )
            return None
        if len(landed) < len(keywords):
            logger.info(
                "targeted_bullet_rewrites: bullet %d partial — landed %s of %s",
                idx, landed, keywords,
            )
        return (idx, "- " + candidate, landed)

    results = await asyncio.gather(*[
        _rewrite_bullet(idx, items) for idx, items in by_bullet.items()
    ])

    applied = 0
    for item in results:
        if item:
            idx, new_line, landed = item
            lines[idx] = new_line
            applied += 1
            logger.info("targeted_bullet_rewrites: applied bullet %d, landed %s", idx, landed)

    logger.info("targeted_bullet_rewrites: %d/%d bullet(s) rewritten", applied, len(by_bullet))
    return "\n".join(lines)
