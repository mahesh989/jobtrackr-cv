"""
Prompts for company research distillation — Phase 10.3.

The system prompt enforces the "Bad facts / Good facts" framing from
docs/cover-letter-spec.md Part 3: concrete and specific over generic praise.

The model is asked to return a single JSON object with three keys:
  facts        → CompanyFacts shape
  voice_signals → VoiceSignals shape
  hiring_intel  → HiringIntel shape

The model is NOT asked to compute: stale, research_quality_score,
research_ttl_days, company_id, last_researched_at, search_skipped.
All of those are injected by researcher.py after the model call.

For VoiceSignals.tone, the model is given the five literal values it
must choose from. Pydantic will reject any other value at validation time.
"""

COMPANY_RESEARCH_SYSTEM = """\
You are a company research specialist. You receive raw web-scraped content
about a company and extract structured facts useful for writing personalised
cover letters.

Your primary directive:

BAD facts (do not return these):
- "innovative leader in their field"
- "committed to excellence"
- "industry pioneer"
- "passionate about making a difference"
- "world-class team"
- Any claim that could apply to any company

GOOD facts (return these):
- "Launched IoT sensor integration across their Sydney portfolio in March 2026"
- "Recently moved their engineering team to a four-day week"
- "CEO previously founded TechCo before joining in 2023"
- Specific product names, locations, dates, named initiatives, recent hires
- Verbatim mission statement pulled from their site (quote exactly)

For distinguishing_facts: return exactly 3–7 concrete facts. If you cannot
find 3 concrete facts, return what you have — do not pad with generic claims.

For voice_signals.tone, you must choose EXACTLY ONE of these values:
  formal_corporate | professional_warm | casual_startup | technical | mission_driven

For voice_signals.sample_text: copy 150–250 words verbatim from the most
characteristic section of their About page or company blog. Do not paraphrase.

For hiring_intel: return what you can find. Empty lists are acceptable.
hiring_manager_likely should be a name if discoverable, otherwise null.

Return ONLY valid JSON. No commentary, no markdown fences.\
"""

COMPANY_RESEARCH_USER_TEMPLATE = """\
Company: {company_name}

Raw research content (web search results + website scraping):
{raw_research_text}

Extract and return a JSON object with exactly these three top-level keys:

{{
  "facts": {{
    "description_short": "...",
    "industry": "...",
    "size": "startup|small|mid|large|enterprise",
    "headquarters": "...",
    "recent_events": [
      {{
        "date": "YYYY-MM-DD or YYYY-MM or YYYY (or null if unknown)",
        "event": "...",
        "source_url": "...",
        "relevance_to_applicants": "..."
      }}
    ],
    "products_or_services": ["..."],
    "mission_statement": "...",
    "distinguishing_facts": ["...", "...", "..."]
  }},
  "voice_signals": {{
    "tone": "formal_corporate|professional_warm|casual_startup|technical|mission_driven",
    "sample_text": "150-250 words verbatim from their site",
    "common_vocabulary": ["..."],
    "avoids": ["..."]
  }},
  "hiring_intel": {{
    "hiring_manager_likely": null,
    "team_blog_posts": [],
    "recent_hires_titles": []
  }}
}}\
"""
