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
import re
from typing import Any, Dict, List, Tuple

from app.services.ai.client import AIClient, AIClientError

logger = logging.getLogger(__name__)

_BULLET_PREFIXES = ("- ", "* ", "• ")
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

# The summary section, whatever the family calls it. Fact-checked as prose (one
# claim) alongside the bullets — it is the most-read line and otherwise passes
# through every gate untouched (only length-clamped), so a reframed domain /
# seniority / specialisation using CV-only words would reach the user unverified.
_SUMMARY_SECTIONS = {
    "career highlights", "professional summary", "summary", "profile",
}

# Only verify bullets in narrative/achievement sections. Skills lines aren't
# bullets, Education bullets are stripped upstream, and the Career Highlights
# prose is handled by the two-sentence clamp — so in practice the bullets we
# collect are Experience + Projects, exactly the claim-bearing lines.
_VERIFY_SECTIONS = {
    "professional experience", "clinical experience", "work experience",
    "experience", "projects",
}

_VERIFY_SYSTEM = """You are a strict CV fact-checker. You are given a candidate's
ORIGINAL CV, the SUMMARY from a TAILORED version of that CV, and a numbered list
of achievement bullets from that tailored version. Decide, for the summary and
for EACH bullet, whether it is ENTAILED by the original CV — i.e. a reasonable
reader of the original would agree it is true.

Rules:
- A claim is NOT entailed if it adds a metric/number, a scope, a seniority, a
  job title, a technology, a domain/specialisation, or an outcome that the
  original CV does not support.
- Reframing wording is fine if the underlying fact is the same. Adding a NEW
  fact is not.
- When a BULLET is not entailed, REPAIR it: rewrite it as the strongest version
  the original CV fully supports (drop the unsupported clause/number). If nothing
  truthful is left, set its repair to "REMOVE".
- When the SUMMARY is not entailed, REPAIR it: rewrite it as AT MOST TWO
  sentences using only facts the original CV supports — drop any invented domain,
  specialisation, seniority, scale, or proper noun. Never set the summary repair
  to "REMOVE".
- Be conservative: if unsure whether the original supports a claim, mark it not
  entailed and repair it down.

Return JSON:
{"summary": {"entailed": <bool>, "repair": <string or null>},
 "results": [{"id": <int>, "entailed": <bool>, "repair": <string or null>}]}
For bullets, "repair" is null when entailed, else the rewritten bullet text (no
leading "- ") or the literal "REMOVE". For the summary, "repair" is null when
entailed, else the rewritten <=2-sentence summary text."""

_VERIFY_USER = """ORIGINAL CV:
\"\"\"
{cv_text}
\"\"\"

TAILORED SUMMARY TO CHECK:
\"\"\"
{summary}
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


def _collect_summary(markdown: str) -> Tuple[List[int], str] | None:
    """Return (prose_line_indices, joined_text) for the summary section, or None.

    Collects the non-empty, non-bullet lines under the summary heading. After the
    two-sentence clamp runs upstream this is normally a single line, but we handle
    several defensively.
    """
    lines = markdown.split("\n")
    in_scope = False
    idxs: List[int] = []
    for i, ln in enumerate(lines):
        if ln.startswith("## "):
            in_scope = ln[3:].strip().lower() in _SUMMARY_SECTIONS
            continue
        if not in_scope:
            continue
        s = ln.strip()
        if not s or s[:2] in ("- ", "* ") or s.startswith("•"):
            continue
        idxs.append(i)
    if not idxs:
        return None
    return idxs, " ".join(lines[i].strip() for i in idxs)


def _truncate_sentences(text: str, n: int) -> str:
    parts = [s.strip() for s in _SENT_SPLIT_RE.split(text.strip()) if s.strip()]
    return " ".join(parts[:n])


def _apply(
    markdown: str,
    edits: Dict[int, str | None],
    prose_idxs: "frozenset[int] | set[int]" = frozenset(),
) -> str:
    """edits maps line_index → replacement text (None = delete the line).

    Indices in prose_idxs are written as plain prose (no bullet prefix, no forced
    period) — used for the summary; all other indices get bullet treatment.
    """
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
        text = repl.strip()
        if idx in prose_idxs:
            lines[idx] = f"{indent}{text}"
            continue
        prefix = next((p for p in _BULLET_PREFIXES if stripped.startswith(p)), "- ")
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
    summary = _collect_summary(tailored_md)
    report: Dict[str, Any] = {
        "checked": 0, "repaired": 0, "removed": 0, "flagged": [], "summary": None,
    }
    if not bullets and not summary:
        return tailored_md, report

    bullets = bullets[:max_bullets]
    numbered = "\n".join(f"{n+1}. {text}" for n, (_idx, text) in enumerate(bullets)) or "(none)"
    summary_text = summary[1] if summary else "(none)"

    try:
        data = await client.complete_json(
            system=_VERIFY_SYSTEM,
            user=_VERIFY_USER.format(
                cv_text=original_cv_text, summary=summary_text, bullets=numbered,
            ),
            max_tokens=3072,
            temperature=0.0,
        )
    except (AIClientError, Exception) as exc:  # noqa: BLE001 — best-effort, never crash the writer
        logger.warning("verify_claims: AI call failed (%s) — skipping verification", exc)
        report["error"] = str(exc)
        report["degraded"] = True  # honesty gate did not run — surface it, don't claim verified
        return tailored_md, report

    results = (data or {}).get("results")
    if bullets and not isinstance(results, list):
        report["error"] = "malformed results"
        report["degraded"] = True
        return tailored_md, report
    if not isinstance(results, list):
        results = []

    edits: Dict[int, str | None] = {}
    prose_idxs: set[int] = set()
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

    # Summary entailment — repair-down to <=2 supported sentences (never removed).
    sm = (data or {}).get("summary")
    if summary and isinstance(sm, dict) and sm.get("entailed") is False:
        repair = sm.get("repair")
        if isinstance(repair, str) and repair.strip():
            new_text = _truncate_sentences(repair, 2)
            if new_text:
                idxs, original_summary = summary
                edits[idxs[0]] = new_text
                prose_idxs.add(idxs[0])
                for j in idxs[1:]:
                    edits[j] = None
                report["summary"] = {"action": "repaired", "to": new_text}
                report["flagged"].append(
                    {"text": original_summary, "action": "summary_repaired", "to": new_text}
                )

    if not edits:
        return tailored_md, report
    return _apply(tailored_md, edits, prose_idxs), report
