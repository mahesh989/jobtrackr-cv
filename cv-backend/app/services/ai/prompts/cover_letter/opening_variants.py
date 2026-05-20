"""
Opening paragraph variants prompt — Phase 11.

Single call returns a JSON array of 3-4 structurally distinct paragraph-1
openers. Each uses one of four named structural patterns so the user can see
WHY the variants differ, not just that they differ.

The caller passes the same rich context as the main generate prompt (voice
sample, CV, story, company fact, JD) because strong variants need full
context to make specific, non-invented claims.

Output format:
  {"variants": [{"id": "A", "text": "...", "pattern_label": "..."}, ...]}
"""

VARIANTS_SYSTEM = """\
You are generating a set of opening paragraph options for one cover letter. \
The candidate's writing sample, CV, story, and the job details are provided.

Write each opening as if the same person who wrote the sample is writing the \
cover letter — their rhythm, their vocabulary, their sentence length. \
Do not produce generic openers and then adjust; write in their voice from the \
first word of each option.

Every factual claim in an opener must be supported by the candidate's CV. \
Do not invent achievements, numbers, employers, dates, tools, or skills.

Return ONLY a JSON object in this exact structure — no commentary before or \
after it:
{
  "variants": [
    {"id": "A", "text": "...", "pattern_label": "Perspective from tenure"},
    {"id": "B", "text": "...", "pattern_label": "Counterintuitive observation"},
    {"id": "C", "text": "...", "pattern_label": "Perspective from an unusual path"},
    {"id": "D", "text": "...", "pattern_label": "Before/after contrast in thinking"}
  ]
}

Include all four variants (A, B, C, D) unless the candidate's CV makes one \
pattern genuinely inapplicable — in that case, omit it and return 3 variants.

Each opener: 2-4 sentences, 30-60 words. No more."""


VARIANTS_USER_TEMPLATE = """\
<voice_sample>
{voice_sample}
</voice_sample>

<candidate_cv>
{cv_text}
</candidate_cv>

<primary_story>
{primary_story}
</primary_story>

<role>{role}</role>
<company>{company_name}</company>
<company_fact>{company_fact}</company_fact>

<jd_context>
{jd_priorities}
</jd_context>

<rules_for_every_opener>
Each opener MUST:
  - Open with a substantive claim the candidate has formed from their actual \
experience — something only this person could write.
  - Name the role somewhere in the paragraph.
  - Include one concrete qualifier drawn from the CV (an experience, \
achievement, or skill — not a personality trait).
  - Be written in the candidate's voice (see <voice_sample> for register, \
rhythm, and vocabulary).

Each opener MUST NOT:
  - Begin with any role-first sentence: "The [Role] at [Company]...", \
"I am applying for...", "I am writing to...", "I am thrilled...", \
"I am excited...", "I admire...", "I would like to..."
  - State what the candidate "brings" or how they "line up" with the role.
  - Explain why the role appeals in the first sentence.
  - Use any of: "leverage", "synergy", "track record", "results-driven", \
"dynamic", "robust", "proven", "passionate", "perfect fit", "ideal candidate".
  - Invent any fact not in <candidate_cv>.
</rules_for_every_opener>

<patterns>
Produce exactly one opener per pattern. The first sentence of each must use a \
structurally different approach from the others.

PATTERN A — Perspective drawn from tenure:
  The opener makes a claim about something the candidate learned or concluded \
from sustained time doing a specific kind of work. The insight is the hook — \
the role and company appear after it.
  Example shape: "[Duration] of [specific work type] taught me that \
[non-obvious conclusion about the work]."

PATTERN B — Counterintuitive observation about the work:
  The opener leads with something surprising the candidate discovered is true \
about the type of work — not about the candidate themselves, but about the \
nature of the work. Candidate experience follows.
  Example shape: "The most [counterintuitive thing] about [type of work] is \
[what the candidate now understands]."

PATTERN C — Perspective shaped by an unusual path:
  The opener foregrounds a non-linear or unexpected aspect of the candidate's \
background and shows what it changed about how they approach the work. Only \
valid if the CV shows a genuine transition or unusual path.
  Example shape: "Moving from [domain A] into [domain B] changed how I \
[see / approach / read / understand] [specific aspect of the work]."

PATTERN D — Before/after contrast in how the candidate thinks or works:
  The contrast is about a change in perspective or approach — NOT a \
quantitative outcome (metric results belong in paragraph 3). The opener shows \
a genuine shift in how the candidate thinks, caused by a real experience.
  Example shape: "Before [experience/transition], I thought [X]. After, I \
understood [Y]. That shift is why [role] at [company] is the natural next step."
  IMPORTANT: the contrast must be about thinking or method, not a number. \
"Before: 11 days processing time. After: 4 days." is a metric result — use \
it in paragraph 3, not here. If no genuine thinking-shift exists in the CV, \
omit Pattern D and return 3 variants.
</patterns>

Generate the four openers now. Return the JSON object only."""
