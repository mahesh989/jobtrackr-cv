"""
W8.1 — per-claim entailment verification (Stage 6 of the target architecture).

The entity-level grounding check (grounding.py) catches fabricated proper nouns,
but NOT reframed or inflated claims that use only words already in the CV — e.g.
"improved accuracy by 25%" when the source gives no number, or "led a team" when
the source says "worked in a team". This module adds a claim-level check:

  one focused AI call, small clean context (source CV + the tailored bullets),
  asking for each bullet: is it ENTAILED by the source CV? If not, repair it to
  the strongest truthful version, or REMOVE it if nothing truthful remains.

Deterministic application: non-entailed bullets are replaced with their repair or
dropped. The call is best-effort — any failure returns the CV unchanged so the
writer never crashes. No per-case prompt tokens (the prompt is fixed and field-
agnostic); the "advanced" part is the architecture (a separate verification
pass), not a bigger writer prompt.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Tuple

from app.services.ai.client import AIClient, AIClientError

logger = logging.getLogger(__name__)

_BULLET_PREFIXES = ("- ", "* ", "• ")

# Only verify bullets in narrative/achievement sections. Skills lines aren't
# bullets, Education bullets are stripped upstream, and the Career Highlights
# prose is handled by the two-sentence clamp — so in practice the bullets we
# collect are Experience + Projects, exactly the claim-bearing lines.
_VERIFY_SECTIONS = {
    "professional experience", "clinical experience", "work experience",
    "experience", "projects",
}

_VERIFY_SYSTEM = """You are a strict CV fact-checker. You are given a candidate's
ORIGINAL CV and a numbered list of achievement bullets taken from a TAILORED
version of that CV. For EACH bullet decide whether it is ENTAILED by the original
CV — i.e. a reasonable reader of the original would agree the bullet is true.

Rules:
- A bullet is NOT entailed if it adds a metric/number, a scope, a seniority, a
  technology, a domain, or an outcome that the original CV does not support.
- Reframing wording is fine if the underlying fact is the same. Adding a NEW fact
  is not.
- When a bullet is not entailed, REPAIR it: rewrite it as the strongest version
  that the original CV fully supports (drop the unsupported clause/number). If
  nothing truthful is left, set repair to "REMOVE".
- Be conservative: if unsure whether the original supports a claim, mark it not
  entailed and repair it down.

Return JSON: {"results": [{"id": <int>, "entailed": <bool>, "repair": <string or null>}]}.
"repair" is null when entailed is true; otherwise it is the rewritten bullet text
(no leading "- ") or the literal "REMOVE"."""

_VERIFY_USER = """ORIGINAL CV:
\"\"\"
{cv_text}
\"\"\"

TAILORED BULLETS TO CHECK:
{bullets}

Return the JSON object now."""


def _collect_bullets(markdown: str) -> List[Tuple[int, str]]:
    """Return [(line_index, bullet_text_without_prefix), ...] for verifiable sections."""
    lines = markdown.split("\n")
    out: List[Tuple[int, str]] = []
    in_scope = False
    for i, ln in enumerate(lines):
        if ln.startswith("## "):
            in_scope = ln[3:].strip().lower() in _VERIFY_SECTIONS
            continue
        if not in_scope:
            continue
        stripped = ln.lstrip()
        for p in _BULLET_PREFIXES:
            if stripped.startswith(p):
                out.append((i, stripped[len(p):].strip()))
                break
    return out


def _apply(markdown: str, edits: Dict[int, str | None]) -> str:
    """edits maps line_index → replacement text (None = delete the line)."""
    lines = markdown.split("\n")
    drop: set[int] = set()
    for idx, repl in edits.items():
        if idx < 0 or idx >= len(lines):
            continue
        if repl is None:
            drop.add(idx)
            continue
        original = lines[idx]
        stripped = original.lstrip()
        indent = original[: len(original) - len(stripped)]
        prefix = next((p for p in _BULLET_PREFIXES if stripped.startswith(p)), "- ")
        text = repl.strip()
        if not text.endswith((".", "!", "?")):
            text += "."
        lines[idx] = f"{indent}{prefix}{text}"
    return "\n".join(l for i, l in enumerate(lines) if i not in drop)


async def verify_claims(
    client: AIClient,
    tailored_md: str,
    original_cv_text: str,
    *,
    max_bullets: int = 40,
) -> Tuple[str, Dict[str, Any]]:
    """
    Check each tailored bullet for entailment against the source CV; repair or
    drop the ones that aren't entailed. Returns (new_markdown, report). Never
    raises — on any error returns the input unchanged with an error in report.
    """
    bullets = _collect_bullets(tailored_md)
    report: Dict[str, Any] = {"checked": 0, "repaired": 0, "removed": 0, "flagged": []}
    if not bullets:
        return tailored_md, report

    bullets = bullets[:max_bullets]
    numbered = "\n".join(f"{n+1}. {text}" for n, (_idx, text) in enumerate(bullets))

    try:
        data = await client.complete_json(
            system=_VERIFY_SYSTEM,
            user=_VERIFY_USER.format(cv_text=original_cv_text, bullets=numbered),
            max_tokens=2048,
            temperature=0.0,
        )
    except (AIClientError, Exception) as exc:  # noqa: BLE001 — best-effort, never crash the writer
        logger.warning("verify_claims: AI call failed (%s) — skipping verification", exc)
        report["error"] = str(exc)
        return tailored_md, report

    results = (data or {}).get("results")
    if not isinstance(results, list):
        report["error"] = "malformed results"
        return tailored_md, report

    edits: Dict[int, str | None] = {}
    report["checked"] = len(bullets)
    for r in results:
        if not isinstance(r, dict):
            continue
        try:
            n = int(r.get("id"))
        except (TypeError, ValueError):
            continue
        pos = n - 1
        if pos < 0 or pos >= len(bullets):
            continue
        if r.get("entailed") is True:
            continue
        line_idx, original_text = bullets[pos]
        repair = r.get("repair")
        if isinstance(repair, str) and repair.strip().upper() == "REMOVE":
            edits[line_idx] = None
            report["removed"] += 1
            report["flagged"].append({"text": original_text, "action": "removed"})
        elif isinstance(repair, str) and repair.strip():
            edits[line_idx] = repair
            report["repaired"] += 1
            report["flagged"].append({"text": original_text, "action": "repaired", "to": repair.strip()})
        else:
            # not entailed but no usable repair → drop it (conservative).
            edits[line_idx] = None
            report["removed"] += 1
            report["flagged"].append({"text": original_text, "action": "removed"})

    if not edits:
        return tailored_md, report
    return _apply(tailored_md, edits), report
