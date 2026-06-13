"""Aggregate unknown skill phrases across runs to drive lexicon growth.

When the per-vertical lexicon doesn't recognise a phrase, the JD/CV
post-processor leaves it in the LLM's bucket as a safe fallback and records
it in ``lexicon_meta.required.unknown`` (and the preferred side equivalent).
Today those entries are only logged — nothing aggregates them, so the only
way to discover lexicon gaps is the manual ``/beta/skills-audit`` page.

This tracker appends every unknown phrase to a rolling JSONL file. A weekly
review (or admin page) can read the file, count by phrase, and surface the
top-N candidates for lexicon promotion.

Design notes:
  • Append-only JSONL so concurrent runs don't clobber.
  • Best-effort writes — never raise. Tracking is observability, not a
    pipeline dependency.
  • One JSONL line per phrase, not per run, so post-hoc analysis can
    `wc -l | grep | sort | uniq -c` directly.
  • Configurable path via env so tests / local dev write somewhere safe.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Iterable, List

logger = logging.getLogger(__name__)

# Env-overridable path. Default puts the file under the repo's writable
# storage area; production should override to a persistent disk path.
_DEFAULT_PATH = os.environ.get(
    "UNKNOWN_PHRASES_LOG",
    "/tmp/jobtrackr_unknown_phrases.jsonl",
)


def record_unknown_phrases(
    *,
    role_family_id: str,
    job_title: str | None,
    lexicon_meta: Dict[str, Any] | None,
    timestamp: str | None = None,
    path: str | None = None,
) -> int:
    """Append each unknown phrase to the rolling JSONL log.

    Returns the count of lines written (0 if no unknowns, or on error).
    Safe to call unconditionally — silently no-ops on missing data, write
    errors, or disabled tracking.

    The timestamp argument is REQUIRED for production calls (caller passes
    an ISO string from `datetime.now().isoformat()`). Inside the workflow
    runtime where `Date.now()` is unavailable, the caller is expected to
    stamp it from the request layer.
    """
    if not lexicon_meta:
        return 0

    phrases = _collect_unknown(lexicon_meta)
    if not phrases:
        return 0

    target = Path(path or _DEFAULT_PATH)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as fh:
            written = 0
            for phrase, bucket, category in phrases:
                fh.write(json.dumps({
                    "phrase": phrase,
                    "role_family": role_family_id,
                    "job_title": job_title,
                    "bucket": bucket,
                    "category": category,
                    "timestamp": timestamp,
                }) + "\n")
                written += 1
            return written
    except OSError as exc:
        logger.warning("unknown_tracker: write failed (%s): %s", target, exc)
        return 0


def _collect_unknown(lexicon_meta: Dict[str, Any]) -> List[tuple[str, str, str]]:
    """Flatten lexicon_meta.{required,preferred}.unknown into (phrase, bucket, category) tuples.

    ``unknown`` is a list of {phrase, category} dicts (see post_process.py
    sidecar structure). We tolerate other shapes defensively — anything
    unparseable is silently dropped.
    """
    out: List[tuple[str, str, str]] = []
    for bucket in ("required", "preferred"):
        side = lexicon_meta.get(bucket) or {}
        unknown_list = side.get("unknown") or []
        if not isinstance(unknown_list, list):
            continue
        for entry in unknown_list:
            if isinstance(entry, dict):
                phrase = str(entry.get("phrase") or "").strip()
                category = str(entry.get("category") or "")
            elif isinstance(entry, str):
                phrase, category = entry.strip(), ""
            else:
                continue
            if phrase:
                out.append((phrase, bucket, category))
    return out


def summarise_log(
    path: str | None = None, top_n: int = 50
) -> List[Dict[str, Any]]:
    """Read the JSONL log and return top-N phrases by frequency.

    Best-effort: missing file → empty list. Malformed lines skipped silently.
    Used by admin / cron — not by the pipeline.
    """
    target = Path(path or _DEFAULT_PATH)
    if not target.exists():
        return []

    counts: Dict[str, Dict[str, Any]] = {}
    try:
        with target.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                key = (rec.get("phrase") or "").strip().lower()
                if not key:
                    continue
                entry = counts.setdefault(key, {
                    "phrase": rec.get("phrase"),
                    "count": 0,
                    "role_families": set(),
                    "categories": set(),
                })
                entry["count"] += 1
                if rec.get("role_family"):
                    entry["role_families"].add(rec["role_family"])
                if rec.get("category"):
                    entry["categories"].add(rec["category"])
    except OSError:
        return []

    ranked = sorted(counts.values(), key=lambda e: e["count"], reverse=True)
    # Convert sets → sorted lists for JSON-friendliness.
    for e in ranked:
        e["role_families"] = sorted(e["role_families"])
        e["categories"] = sorted(e["categories"])
    return ranked[:top_n]
