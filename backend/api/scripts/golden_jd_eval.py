"""Golden-JD regression harness — CLI entry point.

Phase 4 of the JD-extraction quality programme. See
``backend/api/docs/PHASE_2_PLUS_STATUS.md`` for the rationale; see
``tests/golden/harness.py`` for the shared evaluation library.

Two modes:

  • ``--mock`` (default) — replays each JD through the deterministic
    post-process chain using its recorded LLM-output fixture under
    ``tests/golden/fixtures/<id>.json``. No AI calls; cheap and
    deterministic. Same code path the in-suite test runs.

  • ``--live`` — calls the actual JD-analysis LLM (BYOK key in env)
    for every corpus JD, then runs the deterministic chain. Slow,
    costs tokens, used when you want a real-world snapshot.

Output: a JSON report under ``tests/golden/reports/<timestamp>.json``
(when ``--out`` is omitted, prints to stdout). Pass ``--summary`` to also
print a Markdown summary table.

Usage::

    python scripts/golden_jd_eval.py                 # mock mode, stdout
    python scripts/golden_jd_eval.py --summary       # mock + Markdown
    python scripts/golden_jd_eval.py --live          # real AI; needs key
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import List


# Make ``backend/api/`` importable so tests.golden.harness resolves whether
# this script is run from backend/api/ or elsewhere.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tests.golden.harness import (  # noqa: E402
    GOLDEN_DIR,
    EvalResult,
    evaluate,
    evaluate_all_mock,
    load_corpus,
)


def _markdown_summary(results: List[EvalResult]) -> str:
    lines: List[str] = [
        "| JD id | vertical | precision | recall | halluc | missed |",
        "|---|---|---:|---:|---:|---:|",
    ]
    for r in results:
        lines.append(
            f"| {r.jd_id} | {r.vertical} | {r.precision:.2f} | {r.recall:.2f} | "
            f"{len(r.hallucinations)} | {len(r.missed)} |"
        )
    macro_p = sum(r.precision for r in results) / len(results) if results else 0.0
    macro_r = sum(r.recall for r in results) / len(results) if results else 0.0
    total_h = sum(len(r.hallucinations) for r in results)
    total_m = sum(len(r.missed) for r in results)
    lines.append(
        f"| **aggregate** | — | **{macro_p:.2f}** | **{macro_r:.2f}** | "
        f"**{total_h}** | **{total_m}** |"
    )
    return "\n".join(lines)


def _serialise(results: List[EvalResult]) -> List[dict]:
    return [asdict(r) for r in results]


def _run_live() -> List[EvalResult]:
    """Live mode — calls the real JD-analysis LLM. Imports the runner lazily
    so mock mode doesn't pull in the AI client stack."""
    try:
        import asyncio

        from app.services.ai.client import build_ai_client  # type: ignore
        from app.services.pipeline.steps.jd_analysis import run_jd_analysis  # type: ignore
    except Exception as exc:  # noqa: BLE001
        print(f"live mode unavailable: {exc}", file=sys.stderr)
        sys.exit(2)

    async def _go() -> List[EvalResult]:
        client = build_ai_client()
        results: List[EvalResult] = []
        for jd in load_corpus():
            analysis = await run_jd_analysis(client, jd.body)
            results.append(evaluate(jd, analysis))
        return results

    return asyncio.run(_go())


def main(argv: List[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--live", action="store_true",
                   help="call real AI (BYOK key required) instead of fixtures")
    p.add_argument("--out", type=Path, default=None,
                   help="optional JSON output path (default stdout)")
    p.add_argument("--summary", action="store_true",
                   help="also print a Markdown summary table to stderr")
    args = p.parse_args(argv)

    results = _run_live() if args.live else evaluate_all_mock()

    report = {
        "mode": "live" if args.live else "mock",
        "corpus_root": str(GOLDEN_DIR),
        "results": _serialise(results),
        "aggregate": {
            "macro_precision": (
                sum(r.precision for r in results) / len(results)
            ) if results else 0.0,
            "macro_recall": (
                sum(r.recall for r in results) / len(results)
            ) if results else 0.0,
            "total_hallucinations": sum(len(r.hallucinations) for r in results),
            "total_missed": sum(len(r.missed) for r in results),
            "n_jds": len(results),
        },
    }

    blob = json.dumps(report, indent=2, ensure_ascii=False)
    if args.out:
        args.out.write_text(blob, encoding="utf-8")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(blob)

    if args.summary:
        print(_markdown_summary(results), file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
