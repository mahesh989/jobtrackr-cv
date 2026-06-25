"""Manual/service-vertical JD-analysis prompt hints."""

JD_ANALYSIS_HINTS = """\
VERTICAL CONTEXT — this is a CLEANING / MANUAL / TRADES role.
Bucket with this field in mind:
- domain_knowledge: cleaning knowledge and compliance — commercial cleaning,
  deep cleaning, bathroom cleaning, vacuuming, mopping, dusting, waste
  management, chemical handling, PPE use, infection control, WHS / work health
  and safety, food safety.
- technical: named EQUIPMENT only — floor scrubber, polisher, industrial
  cleaning machine, pressure washer, forklift, EWP. The ACT of cleaning is
  domain_knowledge, not technical.
- soft_skills: cross-role behaviours — reliability, attention to detail,
  working autonomously, following instructions, time management, teamwork.
"""
