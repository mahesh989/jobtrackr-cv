"""Nursing-vertical JD-analysis prompt hints."""

JD_ANALYSIS_HINTS = """\
VERTICAL CONTEXT — this is a NURSING / AGED-CARE / DISABILITY-CARE role.
Bucket with this field in mind:
- domain_knowledge: care settings and clinical/care knowledge — aged care,
  residential aged care, home care, community care, disability support, dementia
  care, palliative care, person-centred care, medication administration, wound
  care, infection control, manual handling, activities of daily living, personal
  care, pressure area care, continence care, mobility support.
- soft_skills: interpersonal qualities, INCLUDING cultural ones — compassion,
  empathy, teamwork, communication, patience, "working with culturally and
  linguistically diverse people" / "CALD" → cultural sensitivity (this is a SOFT
  skill, NOT domain knowledge — it describes how the worker relates to people,
  not a clinical procedure).
- technical: named care SOFTWARE / equipment only — Leecare, Manad, eMMS,
  electronic medication management system, hoists. The ACT of using them
  (medication administration, manual handling) is domain_knowledge, not technical.
"""
