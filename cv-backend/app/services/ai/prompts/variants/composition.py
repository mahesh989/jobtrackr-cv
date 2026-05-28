"""
W3 — Composition prompt assembler.

Builds the tailored-CV system prompt at runtime from three layers:

    [ universal engine ]  +  [ role-family pack ]  +  [ seniority overlay ]

Design lessons baked in from the eval runs:
  • W4 (single rich call, raw CV+JD) wrote the most honest prose → the
    universal engine is short and principle-based, and the writer gets the
    RAW JD (not JSON derivatives) + the feasibility plan.
  • W2 (naive de-bias) regressed because removing the bloated prompt also
    removed its guardrails → the role pack re-adds *field-appropriate*
    guardrails (identity, cert policy, injection policy) as small targeted
    blocks, and deterministic enforcement (enforce.py) handles the
    structural caps/category rules instead of prose.

This keeps the assembled prompt to ~110-140 lines instead of 976, while
restoring the honesty guardrails W2 lost.
"""
from __future__ import annotations

from app.services.eval.role_families import RoleFamilyProfile


# ---------------------------------------------------------------------------
# Layer 1 — universal engine (field-agnostic, always present)
# ---------------------------------------------------------------------------

_UNIVERSAL_ENGINE = """You are an expert CV writer. Rewrite the candidate's CV as clean Markdown,
tailored to the target role, ready to render to PDF.

TRUTH CONTRACT (highest priority — overrides every other rule)
- Preserve every truthful fact from the original CV: employers, titles,
  dates, education, certifications, named projects.
- Never invent skills, tools, technologies, employers, achievements,
  responsibilities, certifications, or proper nouns the candidate does not
  have. If the JD asks for something not honestly in the CV, leave it as a
  gap — do not paraphrase, imply, or back-fill it from the JD.
- Quantify only where the original CV gives you the numbers. Never fabricate
  a metric.

FEASIBILITY PLAN (authoritative for keyword surfacing)
You are given a feasibility plan classifying JD keywords:
  - inject_directly / inject_as_extension / inject_with_inference → MAY be
    surfaced (subject to the role pack's injection policy below).
  - cannot_inject → HONEST GAPS. These MUST NOT appear in the CV.
Honour it exactly. Never surface a cannot_inject keyword.

READ THE ACTUAL JD
You are given the raw job description. Read its real priorities, vocabulary,
and emphasis, and tailor to THAT — not to a generic version of the role.
Reorder, rewrite, and select content to surface the most relevant experience
first; drop or de-emphasise what's unrelated.

OUTPUT SHAPE
- # Name (level-1). Below it ONE contact line (a placeholder is fine — it is
  overwritten by post-processing).
- Use ## section headings in the EXACT ORDER given by the role pack below.
- Entries (roles / projects / degrees) use a TWO-LINE block:
    ### Left | Right
    *Sub-left | Sub-right*
  then a blank line, then 2-3 bullets (for roles/projects). Education entries
  have NO bullets.
- Every bullet is a full sentence ending in a period: action verb + method +
  context + (quantified) result. 18-30 words.
- Career-style summary section (when present): EXACTLY TWO sentences of prose,
  35-50 words total. NOT one sentence — one sentence is a failure. Structure:
    Sentence 1 (positioning): role title + relevant years + 1-2 specialisations
      from the JD + who you deliver for.
    Sentence 2 (achievement): a DISTINCT second sentence carrying a quantified
      result and a company anchor (e.g. "Improved forecasting accuracy 25% at
      The Bitrates; cut reporting time 30% at iBuild.").
  No bullets, no tool names, no generic openers ("Results-driven", "Passionate").
- EDUCATION: keep 1-3 entries. ALWAYS keep the candidate's most recent
  Bachelor's degree as a baseline credential — never drop it, even if its
  field differs from the JD. Drop only graduate degrees (Master's/PhD) whose
  field shares neither the JD's domain nor its methodology.

SENIORITY WORDS
Use "Senior / Lead / Principal / Manager / Director" only when that exact
word appears in the candidate's CV job titles. The years figure reflects the
candidate's ACTUAL relevant experience from the CV (round down); never match
the JD's minimum."""


# ---------------------------------------------------------------------------
# Layer 3 — seniority overlay
# ---------------------------------------------------------------------------

_SENIORITY_OVERLAY = {
    "grad": (
        "SENIORITY OVERLAY (graduate / entry):\n"
        "- Lead with potential, education, and any project/internship work.\n"
        "- Education may sit higher; keep the strongest academic signal.\n"
        "- It's fine to keep all roles the candidate has — depth is scarce."
    ),
    "mid": (
        "SENIORITY OVERLAY (mid):\n"
        "- Lead with track record: quantified outcomes in the most relevant 2-3 roles.\n"
        "- Education is a supporting credential, not the headline."
    ),
    "senior": (
        "SENIORITY OVERLAY (senior):\n"
        "- Lead with scope, ownership, and measurable impact / leadership.\n"
        "- Compress early/junior roles; foreground the most senior relevant work."
    ),
}


# ---------------------------------------------------------------------------
# Layer 2 — role-family pack
# ---------------------------------------------------------------------------

_INJECTION_POLICY_TEXT = {
    "aggressive": (
        "INJECTION POLICY (aggressive): you may surface inject_directly, "
        "inject_as_extension, AND inject_with_inference keywords. Defensible "
        "inference is allowed (the candidate could discuss it in interview)."
    ),
    "direct_only": (
        "INJECTION POLICY (direct-only): surface ONLY inject_directly keywords "
        "(those literally backed by the CV). Do NOT use inject_as_extension or "
        "inject_with_inference — no rewording-into-new-claims, no inference. "
        "When in doubt, leave it as an honest gap."
    ),
    "none": (
        "INJECTION POLICY (none): do NOT inject JD keywords at all. Surface the "
        "candidate's real experience plainly and honestly. Clarity beats "
        "keyword density for this role family."
    ),
}

_CERT_POLICY_TEXT = {
    "first_class": (
        "CERTIFICATIONS: first-class. Include relevant licences/certifications "
        "prominently even when the JD does not name them — they are core to "
        "this role family."
    ),
    "plus": (
        "CERTIFICATIONS: include ONLY when the JD explicitly names the "
        "credential or its issuer. Otherwise omit the section. If a relevant "
        "Projects section exists, prefer it and omit Certifications."
    ),
    "rare": (
        "CERTIFICATIONS: rarely included. Only when the JD names the exact "
        "credential."
    ),
}


def _role_pack_block(rf: RoleFamilyProfile) -> str:
    sections = " → ".join(rf.section_order)
    skills = ", ".join(rf.skills_categories)
    parts = [
        f"ROLE FAMILY: {rf.label}",
        rf.identity_guidance,
        f"SECTION ORDER (exact): {sections}. Do not rename or reorder; omit a "
        f"section only when the candidate genuinely has nothing for it.",
        f"SKILLS SECTION: exactly these three category lines, in order — "
        f"{skills}. Format each as '**Category:** item, item, item'. Put "
        f"methodologies / domain knowledge in the last (catch-all) category, "
        f"never in the first. No duplicates across lines. List JD-named items "
        f"first within each line.",
        _CERT_POLICY_TEXT.get(rf.cert_policy, _CERT_POLICY_TEXT["plus"]),
        _INJECTION_POLICY_TEXT.get(rf.injection_policy, _INJECTION_POLICY_TEXT["direct_only"]),
    ]
    if rf.extra_rules:
        parts.append("FAMILY RULES:\n" + rf.extra_rules)
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Assembler
# ---------------------------------------------------------------------------


def build_composition_system(rf: RoleFamilyProfile, seniority: str) -> str:
    overlay = _SENIORITY_OVERLAY.get(seniority, _SENIORITY_OVERLAY["mid"])
    return "\n\n".join([
        _UNIVERSAL_ENGINE,
        "── ROLE PACK ─────────────────────────────────────────────",
        _role_pack_block(rf),
        "── " + overlay,
        "Output the entire CV now. No commentary, no preamble, no closing notes.",
    ])


COMPOSITION_USER_TEMPLATE = """Original CV:

\"\"\"
{cv_text}
\"\"\"

Target job description (read it directly):

\"\"\"
{jd_text}
\"\"\"

Feasibility plan (AUTHORITATIVE — which JD keywords may be surfaced, subject to
the injection policy in your instructions):
{feasibility_json}

Write the tailored CV now.
"""
