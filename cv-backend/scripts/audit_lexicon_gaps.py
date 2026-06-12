"""Aggregate lexicon gaps across runs to drive promotion decisions.

The JD-analysis pipeline writes two diagnostic streams:

  • ``unknown_phrases.jsonl`` (see ``app/services/skills/unknown_tracker.py``)
    — every phrase the per-vertical lexicon didn't recognise, appended one
    line per occurrence.  ``UNKNOWN_PHRASES_LOG`` env overrides the path.

  • ``lexicon_meta.ungrounded`` entries in the JD-analysis result —
    skills the Phase 1 groundedness gate dropped, captured in production
    logs as ``"groundedness gate (family=…): dropped N ungrounded skill(s)"``.
    A regex extractor pulls the structured payload back out of a log file
    if one is supplied.

Run from cv-backend/:

    python scripts/audit_lexicon_gaps.py \\
        --unknown /tmp/jobtrackr_unknown_phrases.jsonl \\
        --top 30 \\
        --out /tmp/lexicon_gaps.json

Both inputs are optional — pass whichever you have. Output is a JSON report
listing the top-N unknown phrases (by occurrence count, grouped by vertical
and bucket) and a separate top-N of ungrounded drops (by reason).

No DB access, no AI calls — pure offline triage.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple


# ---------------------------------------------------------------------------
# Unknown-phrase JSONL — one line per occurrence
# ---------------------------------------------------------------------------

def _iter_jsonl(path: Path) -> Iterable[Dict[str, Any]]:
    if not path.exists():
        return
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                # Skip malformed lines silently — observability stream is
                # best-effort upstream.
                continue


def aggregate_unknowns(jsonl_path: Path) -> List[Dict[str, Any]]:
    """Return phrases sorted by occurrence count desc.

    Key on ``(vertical, bucket, phrase_lower)`` so the same phrase landing in
    different buckets is counted separately — that's actually useful signal
    for deciding which category to promote it into.
    """
    counts: Counter = Counter()
    examples: Dict[Tuple[str, str, str], Dict[str, Any]] = {}

    for entry in _iter_jsonl(jsonl_path):
        phrase = (entry.get("phrase") or "").strip()
        if not phrase:
            continue
        vertical = (entry.get("vertical") or entry.get("role_family") or "unknown").lower()
        bucket = (entry.get("category") or entry.get("bucket") or "unknown").lower()
        key = (vertical, bucket, phrase.lower())
        counts[key] += 1
        if key not in examples:
            examples[key] = {
                "vertical": vertical,
                "bucket": bucket,
                "phrase": phrase,
                "first_seen_job_title": entry.get("job_title"),
            }

    out: List[Dict[str, Any]] = []
    for key, count in counts.most_common():
        rec = dict(examples[key])
        rec["count"] = count
        out.append(rec)
    return out


# ---------------------------------------------------------------------------
# Ungrounded drops — parsed back out of production log lines
# ---------------------------------------------------------------------------
#
# The Phase 1 groundedness gate emits a single line per JD analysis that
# dropped any skills:
#
#   INFO ... groundedness gate (family=nursing): dropped 2 ungrounded skill(s)
#     — [('person-centred care', 'evidence_not_in_jd'), ('teamwork', 'no_evidence')]
#
# We parse the ``family=`` tag and the trailing tuple list. Lines without
# the tag are skipped.

_FAMILY_RE = re.compile(r"groundedness gate \(family=([^)]+)\): dropped \d+ ungrounded skill\(s\) — (.+)$")
_TUPLE_RE = re.compile(r"\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)")


def aggregate_ungrounded(log_path: Path) -> List[Dict[str, Any]]:
    """Return ungrounded drops sorted by occurrence count desc, keyed on
    ``(vertical, skill, reason)``."""
    if not log_path.exists():
        return []

    counts: Counter = Counter()
    for raw in log_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        m = _FAMILY_RE.search(raw)
        if not m:
            continue
        family, tuples_blob = m.group(1), m.group(2)
        for skill, reason in _TUPLE_RE.findall(tuples_blob):
            counts[(family.lower(), skill.lower(), reason.lower())] += 1

    out: List[Dict[str, Any]] = []
    for (family, skill, reason), count in counts.most_common():
        out.append({
            "vertical": family, "skill": skill, "reason": reason, "count": count,
        })
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _default_unknown_path() -> Path:
    return Path(os.environ.get(
        "UNKNOWN_PHRASES_LOG", "/tmp/jobtrackr_unknown_phrases.jsonl",
    ))


def main(argv: List[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--unknown", type=Path, default=_default_unknown_path(),
                   help="path to unknown_phrases.jsonl (default $UNKNOWN_PHRASES_LOG)")
    p.add_argument("--logs", type=Path, default=None,
                   help="optional path to a production log file to scan for ungrounded drops")
    p.add_argument("--top", type=int, default=30,
                   help="top-N candidates per stream (default 30)")
    p.add_argument("--out", type=Path, default=None,
                   help="optional JSON output path (default stdout)")
    args = p.parse_args(argv)

    unknowns = aggregate_unknowns(args.unknown)
    ungrounded = aggregate_ungrounded(args.logs) if args.logs else []

    # Per-vertical-bucket grouping for the unknowns: triagers care about the
    # whole list for one bucket, not a global mix.
    grouped: Dict[str, Dict[str, List[Dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for rec in unknowns:
        grouped[rec["vertical"]][rec["bucket"]].append(rec)

    top_grouped: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    for vertical, by_bucket in grouped.items():
        top_grouped[vertical] = {
            bucket: items[: args.top] for bucket, items in by_bucket.items()
        }

    report = {
        "unknown_phrases_path": str(args.unknown),
        "logs_path": str(args.logs) if args.logs else None,
        "top_per_bucket": top_grouped,
        "top_unknowns_overall": unknowns[: args.top],
        "top_ungrounded": ungrounded[: args.top],
        "totals": {
            "unique_unknowns": len(unknowns),
            "unique_ungrounded": len(ungrounded),
            "unknown_occurrences": sum(r["count"] for r in unknowns),
            "ungrounded_occurrences": sum(r["count"] for r in ungrounded),
        },
    }

    blob = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out:
        args.out.write_text(blob, encoding="utf-8")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(blob)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
