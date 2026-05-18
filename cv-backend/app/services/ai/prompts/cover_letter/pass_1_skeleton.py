"""
Pass 1 prompt — Skeleton draft.

Cheap model (Haiku / GPT-4o-mini). Output is intentionally bland — plain
prose bones, no flourishes. The voice transfer in Pass 2 adds the character.

Inputs (format placeholders):
  {role}            — job title from the JD
  {company_name}    — company name
  {company_hook}    — the ONE selected company fact to anchor paragraph 1
  {jd_priorities}   — top 3-4 priorities extracted from the JD
  {story_one_line}  — one-line summary of the selected story
  {story_detailed}  — 100-200 word detailed story narrative
  {story_numbers}   — concrete metrics from the story (e.g. "35% cost reduction")
  {cv_summary}      — 3-line tailored CV summary
  {word_count}      — target word count (default 170)
"""

PASS_1_SYSTEM = """\
You are a professional cover letter writer. Your job is to produce a \
cover letter skeleton — plain, factual, and well-structured. No AI-typical \
language. No enthusiasm clichés. No "I am writing to express". Just clear \
prose that communicates the facts.

Return the cover letter text only. No subject line, no greeting, no sign-off, \
no commentary."""

PASS_1_USER_TEMPLATE = """\
Write a {word_count}-word cover letter skeleton for this application.

Role: {role}
Company: {company_name}
Company hook (use this as the paragraph 1 opener): {company_hook}
JD top priorities: {jd_priorities}
Candidate's relevant story: {story_one_line}
Story detail: {story_detailed}
Key metrics from story: {story_numbers}
Candidate CV summary: {cv_summary}

Required structure:
- Paragraph 1 (2 sentences): Open with the company hook as a specific \
observation — not a vague compliment. The bridge sentence must connect that \
specific observation to a concrete aspect of the candidate's background or \
the role. Banned bridges: "this focus on X matches my background", \
"this aligns with my passion", "I share this commitment", \
"It's clear they have a big impact".
- Paragraph 2 (4-5 sentences): The selected story with concrete numbers. \
Name the role and company where the work happened. Show the action and the \
result. Vary sentence structure — do not repeat "I [verb]ed X, which [led \
to / resulted in / meant] Y" more than once.
- Paragraph 3 (1-2 sentences): Brief close naming the role explicitly. \
Do not use "I look forward to hearing from you" or any variation. \
End with quiet confidence.

Word count: {word_count}. No greetings, no sign-off. Plain prose only."""
