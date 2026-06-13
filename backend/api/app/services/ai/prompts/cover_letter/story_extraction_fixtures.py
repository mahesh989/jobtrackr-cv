"""
Hand-written fixtures for story_extraction.py prompt quality validation.

These fixtures are qualitative smoke tests — story extraction calls a live AI
model (BYOK), so output is not deterministic. Each fixture documents concrete
PASS criteria that an auditor evaluates after running the model, not strict
equality assertions.

The auditor (Task 4) must call run_fixture_check() with a real AI client and
confirm each fixture's PASS criteria are met.

To manually smoke-test from the cv-backend directory:

    python -c "
    import asyncio, os
    from app.services.ai.client import make_ai_client
    from app.services.ai.prompts.cover_letter.story_extraction_fixtures import run_fixture_check

    # Set your preferred provider key in the environment before running:
    #   export ANTHROPIC_API_KEY=sk-ant-...
    #   export OPENAI_API_KEY=sk-...
    asyncio.run(run_fixture_check(
        provider='anthropic',
        api_key=os.environ['ANTHROPIC_API_KEY'],
    ))
    "

Each fixture is evaluated against:
  1. story_count:  len(result['stories']) is within [expected_min, expected_max]
  2. quality:      all strings in required_quality_criteria are manually verified
                   by reading the printed output
  3. no_fabrication: numbers[] contains only values present verbatim in cv_text
"""
from __future__ import annotations

import asyncio
import json
import textwrap


# ---------------------------------------------------------------------------
# Fixture 1 — RICH_CV
# Senior engineering manager with 5+ quantified achievements across two roles.
#
# Expected:
#   story_count     ≥ 4, ≤ 8  (6 clear achievements in the text)
#   numbers[] populated on most stories (multiple explicit metrics throughout)
#   tags non-empty on all stories
#   year populated for all stories (all roles have explicit date ranges)
#   no generic responsibility bullets extracted as stories
#
# PASS criteria (verify by reading model output):
#   P1 — All extracted stories contain at least one StoryNumber with a value
#        that appears verbatim in the cv_text (e.g. "320,000", "2,400ms",
#        "87%"). No invented numbers.
#   P2 — No story is a generic responsibility restatement (e.g. "Managed
#        engineering team", "Led migrations"). All stories reference a specific
#        outcome with direction and magnitude.
#   P3 — At least one story has domain containing "software" or "engineering".
#   P4 — tags arrays are non-empty; no tag appears outside the advisory
#        vocabulary (leadership, technical, client_facing, etc.).
#   P5 — diagnostic is null (stories were found).
# ---------------------------------------------------------------------------
RICH_CV = {
    "name": "RICH_CV",
    "cv_text": textwrap.dedent("""\
        Alex Chen — Senior Engineering Manager

        EXPERIENCE

        Engineering Manager | TechFlow Analytics | 2021–Present
        - Grew engineering team from 4 to 18 engineers over 24 months; established
          structured onboarding that brought new hires to full productivity in 6 weeks
          (industry average: 12 weeks)
        - Led migration of legacy monolith to microservices architecture; reduced p99
          API latency from 2,400ms to 180ms and cut infrastructure costs by $320,000/year
        - Raised automated test coverage from 12% to 87% over 18 months; production
          incidents fell from 14/month to 2/month
        - Managed largest enterprise client (Meridian Capital, $3.8M ARR); resolved a
          6-month escalation and negotiated a 3-year contract renewal

        Senior Software Engineer | DataBridge Pty Ltd | 2018–2021
        - Designed and shipped a real-time data pipeline processing 4.2B events/day;
          replaced a brittle batch system responsible for 3 major outages in 2019
        - Built internal tooling that automated 80% of QA regression testing, saving
          400 engineering hours per quarter
        - Mentored 5 junior engineers; 4 promoted to mid-level within 18 months

        Software Engineer | Nexus Digital | 2015–2018
        - Reduced flagship SaaS page-load time from 8.2s to 1.1s via frontend
          optimisation and CDN restructuring; bounce rate fell 28%
    """),
    "expected_story_count_min": 4,
    "expected_story_count_max": 8,
    "required_quality_criteria": [
        "P1 — All story numbers[] values appear verbatim in cv_text; none fabricated",
        "P2 — No story is a generic responsibility; all have specific named outcomes",
        "P3 — At least one story has domain containing 'software' or 'engineering'",
        "P4 — tags arrays are non-empty; all values within advisory vocabulary",
        "P5 — diagnostic is null",
    ],
    "notes": (
        "Dense senior CV with 8 explicit quantified achievements. Model should extract "
        "4–8 of them. The team growth story (4→18 engineers), latency reduction "
        "(2,400ms→180ms), test coverage (12%→87%), and data pipeline (4.2B events/day) "
        "are the clearest signal stories and must all be represented. The mentoring "
        "story (5 juniors, 4 promoted) is borderline — may or may not be extracted. "
        "Any story about 'working with the engineering team' without an outcome is a FAIL."
    ),
}

# ---------------------------------------------------------------------------
# Fixture 2 — SPARSE_CV
# Junior developer with one explicit quantified achievement, the rest is
# responsibilities and intern work.
#
# Expected:
#   story_count     ≥ 1, ≤ 3  (one clear metric + possibly the portfolio site)
#   numbers[] may be empty on some stories (acceptable for junior CVs)
#   no fabricated achievements from the responsibility bullets
#
# PASS criteria (verify by reading model output):
#   P1 — The page-load story (6.2s → 1.4s) is extracted and contains those
#        two values in its numbers[]. This is the only explicit metric.
#   P2 — Responsibility bullets are NOT extracted as stories:
#        "Attended weekly standups", "Assisted with code reviews",
#        "Participated in sprint planning", "Helped maintain the website"
#        must not appear as story titles or one_line values.
#   P3 — If a story is extracted for the portfolio/task management project,
#        its numbers[] is empty [] (no metrics given) — no fabrication.
#   P4 — diagnostic is null if at least 1 story is found.
# ---------------------------------------------------------------------------
SPARSE_CV = {
    "name": "SPARSE_CV",
    "cv_text": textwrap.dedent("""\
        Jordan Riley — Junior Software Developer

        EXPERIENCE

        Junior Developer | Startwell Agency | 2023–Present
        - Assisted with code reviews and participated in sprint planning
        - Helped maintain the company website using WordPress
        - Worked with the senior developer on client onboarding improvements
        - Reduced page load time for a client e-commerce site from 6.2s to 1.4s
          by optimising image compression and implementing lazy loading
        - Attended weekly standups and contributed to team retrospectives
        - Fixed small bugs in the internal admin dashboard

        Intern | TechStart Bootcamp | 2022–2023
        - Completed coursework in React, Node.js, and SQL
        - Built a personal portfolio site using Next.js and deployed on Vercel
        - Contributed to a group project building a task management app

        EDUCATION
        Bachelor of Computer Science | University of Queensland | 2022
    """),
    "expected_story_count_min": 1,
    "expected_story_count_max": 3,
    "required_quality_criteria": [
        "P1 — Page-load story (6.2s → 1.4s) is extracted with those values in numbers[]",
        "P2 — Responsibility bullets (standups, code reviews, WordPress maintenance) NOT extracted",
        "P3 — Any project-based stories have numbers[] = [] if no metric given; no fabrication",
        "P4 — diagnostic is null if at least 1 story found",
    ],
    "notes": (
        "Junior CV with exactly one explicit metric (page-load 6.2s→1.4s). Model must "
        "extract this and only this as a numbers-bearing story. Responsibility bullets "
        "must be filtered out entirely. The portfolio site and task management app are "
        "borderline — extraction without fabricated metrics is acceptable; extraction "
        "with invented 'numbers' is a FAIL. Story count of 1 is a passing result if "
        "the quality criteria are met."
    ),
}

# ---------------------------------------------------------------------------
# Fixture 3 — GENERIC_CV
# All responsibility listings, no concrete outcomes anywhere. Should produce
# 0 stories and a non-null diagnostic.
#
# Expected:
#   story_count     = 0
#   diagnostic      non-null; mentions absence of concrete outcomes or metrics
#   numbers[]       n/a (no stories returned)
#
# PASS criteria (verify by reading model output):
#   P1 — stories array is empty [].
#   P2 — diagnostic is non-null and non-empty.
#   P3 — diagnostic text references the absence of concrete outcomes or metrics
#        (e.g. "job descriptions", "no measurable outcomes", "responsibilities").
#   P4 — No story objects are fabricated from the responsibility bullets.
#        Specifically: "Managed a team of 12 staff" must not appear as a story
#        with invented numbers (e.g. fabricated "reduced turnover by 20%").
# ---------------------------------------------------------------------------
GENERIC_CV = {
    "name": "GENERIC_CV",
    "cv_text": textwrap.dedent("""\
        Sam Morgan — Operations Manager

        EXPERIENCE

        Operations Manager | RetailCo | 2020–Present
        - Responsible for day-to-day operations management across 3 retail locations
        - Managed a team of 12 staff including rostering and performance reviews
        - Liaised with suppliers and managed procurement processes
        - Drove cross-functional alignment between sales, operations, and finance teams
        - Responsible for stakeholder management at the executive level
        - Coordinated team meetings and managed internal communications
        - Oversaw compliance with company policies and procedures
        - Assisted with the development of operational processes and documentation

        Operations Coordinator | ServiceGroup | 2017–2020
        - Supported the operations team with administrative tasks and scheduling
        - Maintained records and documentation for operational activities
        - Participated in process improvement initiatives across the business
        - Communicated with clients and resolved issues as they arose
        - Assisted management with reporting and performance tracking
    """),
    "expected_story_count_min": 0,
    "expected_story_count_max": 2,
    "required_quality_criteria": [
        "P1 — stories array is empty [] OR contains at most 2 stories with zero fabricated numbers",
        "P2 — diagnostic is non-null and non-empty",
        "P3 — diagnostic text references absence of concrete outcomes or measurable results",
        "P4 — No story has fabricated metrics — if extracted, numbers[] must be []",
    ],
    "notes": (
        "Pure responsibility listing. No outcome, no metric, no before/after. "
        "Model should return stories=[] with a diagnostic message. If the model "
        "extracts 1–2 stories (e.g. treating '3 retail locations' as a scope metric), "
        "this is acceptable only if numbers[] is [] and the story describes a genuine "
        "achievement context — not a responsibility restatement with invented numbers. "
        "Any story containing a fabricated metric (e.g. 'reduced costs by X%' with X "
        "not in the cv_text) is an automatic FAIL regardless of story count."
    ),
}

# ---------------------------------------------------------------------------
# Canonical list — used by run_fixture_check()
# ---------------------------------------------------------------------------
FIXTURES: list[dict] = [RICH_CV, SPARSE_CV, GENERIC_CV]


# ---------------------------------------------------------------------------
# Manual smoke-test runner
# ---------------------------------------------------------------------------

async def run_fixture_check(
    provider: str,
    api_key: str,
    model: str | None = None,
) -> None:
    """
    Run all three fixtures through extract_stories() with a real AI client.

    Prints story counts, story summaries, and the PASS criteria for each
    fixture. The auditor reads the output and confirms each P-criterion manually.

    Usage (from backend/api/):
        python -c "
        import asyncio, os
        from app.services.ai.prompts.cover_letter.story_extraction_fixtures import run_fixture_check
        asyncio.run(run_fixture_check('anthropic', os.environ['ANTHROPIC_API_KEY']))
        "
    """
    from app.services.ai.client import make_ai_client
    from app.services.stories.story_extractor import extract_stories

    client = make_ai_client(provider, api_key, model)

    for fixture in FIXTURES:
        print(f"\n{'='*60}")
        print(f"FIXTURE: {fixture['name']}")
        print(f"Expected story count: {fixture['expected_story_count_min']}–"
              f"{fixture['expected_story_count_max']}")
        print("=" * 60)

        result = await extract_stories(client, fixture["cv_text"])
        stories = result["stories"]
        diagnostic = result["diagnostic"]

        count_ok = (
            fixture["expected_story_count_min"]
            <= len(stories)
            <= fixture["expected_story_count_max"]
        )
        count_status = "✓" if count_ok else "✗"
        print(f"\n{count_status} Story count: {len(stories)} "
              f"(expected {fixture['expected_story_count_min']}–"
              f"{fixture['expected_story_count_max']})")

        if diagnostic:
            print(f"  diagnostic: {diagnostic!r}")

        for i, s in enumerate(stories):
            print(f"\n  Story {i + 1}: {s['title']}")
            print(f"    domain:   {s['domain']}")
            print(f"    year:     {s.get('year')}")
            print(f"    one_line: {s['one_line']}")
            print(f"    numbers:  {json.dumps(s['numbers'])}")
            print(f"    tags:     {s['tags']}")
            print(f"    detailed: {s['detailed'][:120]}...")

        print(f"\nMANUAL PASS CRITERIA — verify each by reading output above:")
        for criterion in fixture["required_quality_criteria"]:
            print(f"  [ ] {criterion}")

        print(f"\nNOTES: {fixture['notes']}")


if __name__ == "__main__":
    import os
    # Default to Anthropic if ANTHROPIC_API_KEY is set, else OpenAI
    if os.environ.get("ANTHROPIC_API_KEY"):
        asyncio.run(run_fixture_check("anthropic", os.environ["ANTHROPIC_API_KEY"]))
    elif os.environ.get("OPENAI_API_KEY"):
        asyncio.run(run_fixture_check("openai", os.environ["OPENAI_API_KEY"]))
    else:
        print("Set ANTHROPIC_API_KEY or OPENAI_API_KEY to run fixture checks.")
