"""
Single-call cover letter generation prompt — Phase 10.4 refactor.

Replaces the three-pass (skeleton → voice transfer → burstiness) pipeline
with one call to the user's chosen model. The model receives:
  - A voice sample (verbatim) as the register anchor
  - The candidate's CV as the source of truth for facts
  - The primary story (and optional secondary) for paragraph 3
  - Role + company + company hook + JD priorities for tailoring
  - The four-paragraph rubric with per-paragraph intent and constraints
  - A list of anti-patterns to steer away from

Output is the body only — header, salutation, and sign-off are added by
the delivery template layer (Phase 10.6).

Honesty retry: on Gate 1 failure, the orchestrator re-renders USER_TEMPLATE
with HONESTY_RETRY_TEMPLATE filled in (rather than empty), feeding the
unsupported-claims list back to the model for one corrective pass.
"""
from typing import Any, Dict, List, Optional


SYSTEM = """\
You are writing one cover letter on behalf of a specific candidate for a \
specific job. The candidate's writing sample, CV, and the job details are \
provided below. Write the letter as if the same person who wrote the sample \
is now writing the cover letter — their rhythm, their vocabulary, their \
quirks. Do not write a generic cover letter and then adjust; write in their \
voice from the first word.

Every factual claim in the letter must be supported by the candidate's CV. \
Do not invent achievements, numbers, employers, dates, tools, or skills. \
If you cannot find support for something in the CV, omit it.

Return only the four-paragraph body. No greeting, no header, no sign-off, \
no commentary."""


USER_TEMPLATE = """\
<voice_sample>
{voice_sample}
</voice_sample>

<candidate_cv>
{cv_text}
</candidate_cv>

<primary_story>
{primary_story}
</primary_story>

<secondary_story>
{secondary_story}
</secondary_story>

<role>{role}</role>
<company>{company_name}</company>
<company_fact>{company_fact}</company_fact>

<jd_context>
{jd_priorities}
</jd_context>

<architecture>
Write a four-paragraph cover letter body. Each paragraph has an intent and \
constraints. Choose the wording, the order of ideas within the paragraph, \
and the sentence structure yourself.

PARAGRAPH 1 — Attention + qualification (2-4 sentences)
  Intent: Grab attention with a substantive claim the candidate has formed \
from their own experience — something only this person could write. The \
paragraph as a whole must name the role and include one concrete qualifier; \
the FIRST SENTENCE does not.

  FIRST SENTENCE RULE — the opening sentence must NOT:
    - describe the role
    - state what the candidate "brings" or how they "line up" with the role
    - explain why the role appeals

  Those are all role-first patterns and they produce bland openings. \
The opening sentence must make a substantive claim the candidate has \
formed from their actual experience.

  If the candidate's CV shows a career transition or an unusual path, that \
is often the strongest opening material — a perspective only this person \
could plausibly have formed.

  Examples (do not copy these words — they are shapes, not text to reuse):

    Pattern A — perspective drawn from tenure:
      "Eighteen months of running incident response taught me that the \
loudest alerts are almost never the ones that matter."

    Pattern B — counterintuitive observation about the work:
      "The most useful thing I learned writing technical documentation is \
that good docs are mostly about deciding what to leave out."

    Pattern C — perspective shaped by an unusual path:
      "Moving from clinical research into product analytics changed how I \
read a dashboard — I now look first at what is missing."

  Each of these makes a claim only this person could plausibly have formed. \
None of them describes the role or explains why the role appeals — that \
material belongs in paragraph 2.

  Subsequent sentences in paragraph 1 should bridge from the opening claim \
to a concrete qualifier from the CV (an experience, achievement, or skill — \
not a personality trait) and name the role being applied for. When the role \
expects a formal qualification, licence, registration, or certification that \
the candidate holds (e.g. a required certificate or professional \
registration), name THAT credential HERE in paragraph 1 — it is the headline \
qualifier and must not be left to surface only in the closing paragraph.

  Must: name the role explicitly somewhere in the paragraph; include one \
concrete qualifier drawn from the CV.
  Must not: open the paragraph with "Hi,", "Hello,", "Dear", "I admire", \
"I am writing", "I am thrilled", "I'm excited", "I would like to", or any \
greeting. Must not open with "The [Role] at [Company]..." or any "role + \
verb explaining appeal" construction.

PARAGRAPH 2 — Why this company (3-5 sentences)
  Intent: Show this application is informed, not generic. Anchor on the \
<company_fact>. Connect that specific fact to the candidate's own motivation \
or background.
  Must: reference the specific <company_fact>; connect it to something \
concrete about the candidate.

  EXISTING RELATIONSHIP — first check <candidate_cv>: if the candidate \
already works for, previously worked for, or completed a placement at this \
company (or a clearly related entity that shares the company's name), they \
are NOT an outsider. Do NOT write "I've followed your work", "I've long \
admired you", or any framing that pretends they are discovering the company \
from the outside — that misrepresents a real relationship and reads as false. \
Lead instead from that genuine connection (what they have seen of the \
organisation from the inside); an internal/known candidate's first-hand \
knowledge is the strongest possible "why this company" signal.

  Must not: use "your innovative culture", "leading company", "great place \
to work", or any vague compliment that could apply to any employer.

PARAGRAPH 3 — What you contribute (4-7 sentences)
  Intent: The substantive proof. Tell the primary story with concrete \
numbers, named tools, real outcomes. If a secondary story exists and fits, \
add it briefly at the end.
  Must: include at least one number or named outcome from the primary story.

  STRUCTURAL VARIETY — the sentences must not share the same skeleton.

    WEAK (avoid this pattern — sentences all built around "I [verb]ed X, \
which [resulted in / led to / meant] Y"):
      "I automated data extraction, which improved accuracy by 20%. \
I worked with developers on analytics components, which improved \
processing speed by 25%. I built dashboards in Power BI, which reduced \
reporting time by 30%."

    STRONGER (varied structures — situation, action, consequence, detail):
      "At [employer], the analyst team was rebuilding the same report every \
Monday morning. I automated the extraction in Python, which cut the work \
from three hours to fifteen minutes and improved accuracy by 20%. The team \
kept the script and adapted it for three other data sources over the next \
quarter."

  The examples above use illustrative content. Apply the structural pattern \
to the candidate's own story — do not reuse the example sentences, phrasing, \
or employer details.

  TEXTURE — include at least one of the following texture elements, drawn \
from the candidate's actual experience:
    - A colleague's reaction or behaviour change (e.g. "the team kept the \
script", "the manager started checking the dashboard before her 9am \
meetings", "the developers wanted to know how it worked").
    - What changed about the work afterwards (e.g. "the same pattern is \
now used for three other data sources", "we stopped having Monday morning \
data fire drills").
    - What was hard or unexpected (e.g. "the data was inconsistent across \
sources, so I had to build reconciliation logic", "the first version was \
too slow, so I redesigned the query").
    - A specific moment that captured the work's impact (e.g. "the client \
saw the dashboard for the first time and asked to redesign their weekly \
meeting around it").
  Statistics alone do not prove the work happened. A texture detail proves \
there was a real situation, real people, real consequences.

  Must not: invent facts not in <candidate_cv>; deploy statistics as a \
bullet-point list in prose form; copy any of the example sentences above \
verbatim — they are structural patterns to imitate, not phrases to use; \
re-tell an experience, placement, employer, or anecdote already used in \
paragraph 2 (P2's company connection and P3's proof must draw on DIFFERENT \
material), or repeat any distinctive phrase more than once across the letter \
(e.g. do not lean on "person-centred" or any signature term in every \
paragraph).

PARAGRAPH 4 — Close (1-3 sentences)
  Intent: Thank the reader. Reiterate interest in this specific role at \
this specific company. Signal availability for next steps.
  Must: name the role or company specifically (not "this opportunity" or \
"your team"); include appreciation; signal availability.
  Must not: use "I look forward to" in any form, "I am excited", "Thank you \
for your consideration of my application", or any template-sounding sign-off \
phrase. Do not write "Kind regards" or any sign-off — that line is added by \
the template layer.
</architecture>

<anti_patterns>
The following phrases appear in generic AI-generated cover letters. Do not \
use any of them or close variations:
  - "I am writing to express"
  - "I am thrilled / excited / passionate"
  - "genuinely excited", "truly excited", "really excited about this opportunity"
  - "I admire your work"
  - "I've followed your work closely", "I have followed [company] closely", \
"I've long admired"
  - "this opportunity" used as a vague stand-in for the actual named role
  - "It is clear that"
  - "fits with my career goals"
  - "aligns with my passion"
  - "perfect fit", "ideal candidate"
  - "leverage", "synergy", "track record", "results-driven", "dynamic", \
"robust", "proven"
  - "I look forward to hearing from you"
  - "Worth it." (do not insert sentence fragments that do not fit the \
rhythm of the sentence before them)
  - "in today's fast-paced world"
  - "Furthermore,", "Moreover,", "Additionally,"
</anti_patterns>
{honesty_retry_block}
Write the four-paragraph body now. Target 250 to 400 words total."""


# Filled in only when generation is being retried after a Gate 1 honesty
# failure. On the first attempt this is an empty string.
HONESTY_RETRY_TEMPLATE = """
<previous_attempt_issues>
A previous attempt at this cover letter included claims not supported by \
the candidate's CV:
{unsupported_claims}
Rewrite the body without these claims and without inventing any other \
facts not in <candidate_cv>.
</previous_attempt_issues>
"""


# ── Phase 11: body-only variants (P2-P4 from a chosen P1) ────────────────────

SYSTEM_BODY_ONLY = """\
You are writing paragraphs 2, 3, and 4 of one cover letter on behalf of a \
specific candidate for a specific job. Paragraph 1 is already written and \
provided — do not rewrite or paraphrase it.

The candidate's writing sample, CV, and the job details are provided below. \
Write paragraphs 2-4 as if the same person who wrote the sample is continuing \
the letter — their rhythm, their vocabulary, their quirks. Do not produce \
generic text and then adjust; write in their voice throughout.

Every factual claim must be supported by the candidate's CV. Do not invent \
achievements, numbers, employers, dates, tools, or skills. If you cannot find \
support for something in the CV, omit it.

Return only paragraphs 2, 3, and 4 — three paragraphs of plain prose. \
No greeting, no header, no sign-off, no commentary, and do not include \
paragraph 1."""


USER_TEMPLATE_BODY_ONLY = """\
<voice_sample>
{voice_sample}
</voice_sample>

<candidate_cv>
{cv_text}
</candidate_cv>

<primary_story>
{primary_story}
</primary_story>

<secondary_story>
{secondary_story}
</secondary_story>

<role>{role}</role>
<company>{company_name}</company>
<company_fact>{company_fact}</company_fact>

<jd_context>
{jd_priorities}
</jd_context>

<chosen_opening>
{chosen_opening}
</chosen_opening>

<architecture>
Paragraph 1 is fixed — it is in <chosen_opening> above. Do NOT rewrite, \
restate, or paraphrase it. Your task is to write paragraphs 2, 3, and 4 only.

COHERENCE REQUIREMENT — P2 must build on the perspective or claim established \
in P1. It must not restart from a different angle or restate what P1 already \
said. The letter must read as if one person wrote all four paragraphs in \
sequence, with P1 establishing a frame that the rest develops.

PARAGRAPH 2 — Why this company (3-5 sentences)
  Intent: Show this application is informed, not generic. Anchor on the \
<company_fact>. Connect that specific fact to the candidate's own motivation \
or background, building naturally from the angle P1 established.
  Must: reference the specific <company_fact>; connect it to something \
concrete about the candidate.

  EXISTING RELATIONSHIP — first check <candidate_cv>: if the candidate \
already works for, previously worked for, or completed a placement at this \
company (or a clearly related entity that shares the company's name), they \
are NOT an outsider. Do NOT write "I've followed your work", "I've long \
admired you", or any framing that pretends they are discovering the company \
from the outside — that misrepresents a real relationship and reads as false. \
Lead instead from that genuine connection (what they have seen of the \
organisation from the inside); an internal/known candidate's first-hand \
knowledge is the strongest possible "why this company" signal.

  Must not: use "your innovative culture", "leading company", "great place \
to work", or any vague compliment that could apply to any employer.

PARAGRAPH 3 — What you contribute (4-7 sentences)
  Intent: The substantive proof. Tell the primary story with concrete \
numbers, named tools, real outcomes. If a secondary story exists and fits, \
add it briefly at the end.
  Must: include at least one number or named outcome from the primary story.

  STRUCTURAL VARIETY — the sentences must not share the same skeleton.

    WEAK (avoid this pattern — sentences all built around "I [verb]ed X, \
which [resulted in / led to / meant] Y"):
      "I automated data extraction, which improved accuracy by 20%. \
I worked with developers on analytics components, which improved \
processing speed by 25%. I built dashboards in Power BI, which reduced \
reporting time by 30%."

    STRONGER (varied structures — situation, action, consequence, detail):
      "At [employer], the analyst team was rebuilding the same report every \
Monday morning. I automated the extraction in Python, which cut the work \
from three hours to fifteen minutes and improved accuracy by 20%. The team \
kept the script and adapted it for three other data sources over the next \
quarter."

  The examples above use illustrative content. Apply the structural pattern \
to the candidate's own story — do not reuse the example sentences, phrasing, \
or employer details.

  TEXTURE — include at least one of the following texture elements, drawn \
from the candidate's actual experience:
    - A colleague's reaction or behaviour change (e.g. "the team kept the \
script", "the manager started checking the dashboard before her 9am \
meetings", "the developers wanted to know how it worked").
    - What changed about the work afterwards (e.g. "the same pattern is \
now used for three other data sources", "we stopped having Monday morning \
data fire drills").
    - What was hard or unexpected (e.g. "the data was inconsistent across \
sources, so I had to build reconciliation logic", "the first version was \
too slow, so I redesigned the query").
    - A specific moment that captured the work's impact (e.g. "the client \
saw the dashboard for the first time and asked to redesign their weekly \
meeting around it").
  Statistics alone do not prove the work happened. A texture detail proves \
there was a real situation, real people, real consequences.

  Must not: invent facts not in <candidate_cv>; deploy statistics as a \
bullet-point list in prose form; copy any of the example sentences above \
verbatim — they are structural patterns to imitate, not phrases to use; \
re-tell an experience, placement, employer, or anecdote already used in \
paragraph 2 (P2's company connection and P3's proof must draw on DIFFERENT \
material), or repeat any distinctive phrase more than once across the letter \
(e.g. do not lean on "person-centred" or any signature term in every \
paragraph).

PARAGRAPH 4 — Close (1-3 sentences)
  Intent: Thank the reader. Reiterate interest in this specific role at \
this specific company. Signal availability for next steps.
  Must: name the role or company specifically (not "this opportunity" or \
"your team"); include appreciation; signal availability.
  Must not: use "I look forward to" in any form, "I am excited", "Thank you \
for your consideration of my application", or any template-sounding sign-off \
phrase. Do not write "Kind regards" or any sign-off — that line is added by \
the template layer.
</architecture>

<anti_patterns>
The following phrases appear in generic AI-generated cover letters. Do not \
use any of them or close variations:
  - "I am writing to express"
  - "I am thrilled / excited / passionate"
  - "genuinely excited", "truly excited", "really excited about this opportunity"
  - "I admire your work"
  - "I've followed your work closely", "I have followed [company] closely", \
"I've long admired"
  - "this opportunity" used as a vague stand-in for the actual named role
  - "It is clear that"
  - "fits with my career goals"
  - "aligns with my passion"
  - "perfect fit", "ideal candidate"
  - "leverage", "synergy", "track record", "results-driven", "dynamic", \
"robust", "proven"
  - "I look forward to hearing from you"
  - "Worth it." (do not insert sentence fragments that do not fit the \
rhythm of the sentence before them)
  - "in today's fast-paced world"
  - "Furthermore,", "Moreover,", "Additionally,"
</anti_patterns>
{honesty_retry_block}
Write paragraphs 2, 3, and 4 now. Target 200 to 320 words total."""


# ── Helpers used by the orchestrator to format inputs before .format() ────────

def format_story(story: Optional[Dict[str, Any]]) -> str:
    """Format a story dict into a labelled prose block for the prompt."""
    if not story:
        return "(none available)"
    parts: List[str] = []
    title = story.get("title")
    if title:
        parts.append(f"Title: {title}")
    one_line = story.get("one_line")
    if one_line:
        parts.append(f"Summary: {one_line}")
    detailed = story.get("detailed")
    if detailed:
        parts.append(f"Detail: {detailed}")
    numbers = story.get("numbers") or []
    formatted_nums: List[str] = []
    for n in numbers:
        if isinstance(n, dict):
            metric = n.get("metric", "")
            value = n.get("value", "")
            if metric and value:
                formatted_nums.append(f"{metric}: {value}")
            elif value:
                formatted_nums.append(str(value))
        elif n:
            formatted_nums.append(str(n))
    if formatted_nums:
        parts.append("Concrete numbers: " + "; ".join(formatted_nums))
    return "\n".join(parts) if parts else "(story has no usable content)"


def format_unsupported_claims(claims: List[str]) -> str:
    """Bullet-format a list of unsupported claims for the retry block."""
    if not claims:
        return "  (no specific claims listed)"
    return "\n".join(f"  - {c}" for c in claims if c)
