"""
Pass 3 prompt — Burstiness and imperfection injection.

Cheap model (Haiku / GPT-4o-mini). Final humanisation pass. The model
is given a specific checklist of micro-edits to make the letter feel
more like genuine human writing and less like AI output.

This pass must not change facts or alter the voice character established
in Pass 2 — only the structural variety and banned phrases are targeted.

Inputs (format placeholders):
  {pass_2_letter}    — the Pass 2 voice-transferred letter to refine
  {company_name}     — company name (for opener check)
  {role}             — job role (for opener check)
"""

PASS_3_SYSTEM = """\
You are an editor making targeted micro-edits to a cover letter. Your job \
is to apply a specific checklist of changes — nothing more. Do not rewrite \
the letter. Do not change any facts. Do not alter the tone or voice. \
Make only the edits listed in the checklist.

Return the edited letter only. No commentary."""

PASS_3_USER_TEMPLATE = """\
Here is a cover letter to edit:

---
{pass_2_letter}
---

Apply ALL of the following edits:

1. Sentence variance check:
   - Ensure at least one sentence is under 8 words.
   - Ensure at least one sentence is over 20 words.
   - Ensure no three consecutive sentences are within 5 words of each other \
in length (measure by word count; adjust the middle sentence if needed).
   If any of these conditions already hold, leave those sentences alone.

2. Human texture (add exactly ONE of the following — pick the most natural fit \
for the existing text; do not add more than one):
   - A brief declarative fragment for emphasis. Keep it professional — NOT \
casual phrases like "Worth it." or "Simple as that." Do not copy these \
examples; write something specific to the letter content.
   - An em-dash aside within a sentence
   - A parenthetical remark
   - A sentence that starts with a conjunction (And, But, So)
   If one of these already appears naturally, this step is complete — \
do not add another.

2b. Structural pattern check:
   - If two or more sentences in the same paragraph share the same grammatical \
skeleton (e.g. "I [verb]ed X, which [led to / resulted in / meant] Y"), \
rewrite the second instance so it uses a different construction. \
Do not change the facts — only the sentence structure.

3. Banned phrase removal — if any of the following phrases appear, \
replace them with plain language that fits the existing voice:
   "I am writing to express", "I am excited", "I'm excited", "passionate", \
"synergy", "leverage", "track record", "results-driven", "proven", "dynamic", \
"robust", "I look forward to hearing", "in today's", "fast-paced", \
"Furthermore,", "Additionally,", "Moreover,"

4. Specificity check: the letter must contain at least one concrete number, \
name, or place from the candidate's experience. If none is present, add one \
that is consistent with the story already described — do not invent new facts.

5. Opener check: the letter must NOT start with any of these (or close \
variations):
   "I am writing", "I'm reaching out", "Dear Hiring Manager, I am", \
"I would like to", "My name is"
   If the opener matches, rewrite only the opening sentence.

Output the final edited letter only. No commentary."""
