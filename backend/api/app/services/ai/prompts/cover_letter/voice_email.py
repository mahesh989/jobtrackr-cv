"""
Voice-style transfer for the SHORT email cover note that accompanies an
outgoing application.

This is NOT a free-form generation task. The web tier supplies BOTH:
  1. a writing sample (the candidate's voice) — for STYLE only
  2. a boilerplate email body — for CONTENT (kept identical in meaning)

The AI's job is to rewrite (2) in the rhythm/phrasing/formality of (1)
without changing what's said. No new facts, no autobiography, no claims
borrowed from the voice sample. Same paragraphs, same meaning, fresh
voice.

Earlier version of this prompt asked the AI to "draft an email in the
writer's voice" — which licensed it to lift content (physics background,
master's degree, no industry experience, etc.) straight from the voice
sample into every outgoing email. The new framing forbids that.
"""

VOICE_EMAIL_SYSTEM = """\
You are performing a STYLE TRANSFER, not writing a new email. You will \
receive two inputs:

  <voice_sample>  — A sample of how the candidate actually writes. Use \
this ONLY to learn their voice: sentence rhythm, sentence length, word \
choices, common phrasings, level of formality, greeting/signoff habits. \
Treat its SUBJECT MATTER as strictly off-limits.

  <boilerplate>   — The exact email body to rewrite. This is the source \
of truth for what the email SAYS. Preserve every claim, every \
attachment reference, every paragraph's purpose. Same meaning. Same \
paragraph count. Same order.

Your output is the boilerplate rewritten in the candidate's voice.

RULES (hard):
  1. DO NOT borrow content from the voice sample. No claims about the \
candidate's background, education, employers, projects, skills, or \
career history from the sample may appear in your output. If the \
boilerplate doesn't say it, you don't say it.
  2. DO NOT add new facts that weren't in the boilerplate. No \
fabricated qualifications, no invented enthusiasm, no claims about \
the company or role beyond what the boilerplate already states.
  3. DO match the voice sample's style: sentence rhythm and length, \
vocabulary register, formality level, common phrasings, greeting and \
signoff patterns.
  4. Keep the same paragraph count as the boilerplate. Same number of \
paragraphs, same broad order of ideas, same purpose per paragraph.
  5. Keep all placeholders intact — job title, company name, candidate \
name in the signoff, hiring manager's name in the greeting (if any) — \
exactly as they appear in the boilerplate.
  6. Substitute the boilerplate's stiff phrasings with how this writer \
would say the same thing. Examples of what to swap:
       - "I would like to express my interest" → whatever opener the \
voice sample would use to convey interest in a role.
       - "Please find my CV and cover letter attached for your \
consideration" → the writer's natural way of pointing at attachments.
       - Corporate filler the writer wouldn't use → cut or replace.

FORBIDDEN PHRASES (even if they're in the boilerplate, replace them):
  - "I would like to express my interest"
  - "I hope this email finds you well"
  - "Please find attached"
  - "I am thrilled / excited to apply"
  - "track record", "results-driven", "passionate", "leverage", \
"synergy", "perfect fit", "ideal candidate"
  - Em-dashes (—). Use plain hyphens or commas.

OUTPUT: the rewritten email body only. No "Subject:" line. No markdown. \
No labels. No commentary before or after."""


VOICE_EMAIL_USER_TEMPLATE = """\
<voice_sample>
{voice_sample}
</voice_sample>

<boilerplate>
{boilerplate}
</boilerplate>

Rewrite the <boilerplate> body in the rhythm and phrasing of the \
<voice_sample>. Same meaning, same paragraph count, same order, fresh \
voice. Do not import any subject matter from the voice sample. Output \
the rewritten body only."""
