"""Phase 2 — lexicon post-process integration.

Validates the JD-analysis + CV-categorisation post-pass against the
EXACT skill lists from the Hardi / Nepean nursing runs that motivated
this rewrite. If any of these assertions break, the leak is back.
"""
from __future__ import annotations

import pytest

from app.services.skills.post_process import (
    _demote_conditional_required_to_preferred,
    _has_credential_marker,
    _is_au_unit_code,
    _looks_like_language,
    _split_conditional_phrase,
    enrich_required_skills_from_jd_body,
    post_process_cv_skills,
    post_process_jd_analysis,
    post_process_skills,
)


# ---------------------------------------------------------------------------
# The Hardi JD — actual skills lists from the user's analysis paste
# ---------------------------------------------------------------------------


HARDI_JD_RAW = {
    "job_title": "assistant in nursing (ain)",
    "role_family": "nursing",
    "required_skills": {
        "technical": [
            "clinical assessments",
            "clinical observations",
            "wound management",
            "continence management",
            "resident charting and documentation",
            "computer skills",
            "writing skills",
        ],
        "soft_skills": [
            "effective verbal communication",
            "effective written communication",
            "organisation",
            "time management",
            "ability to work in a team",
            "ability to work autonomously",
            "empathetic nature",
            "tolerant nature",
            "patient nature",
            "duty of care mindset",
        ],
        "domain_knowledge": [
            "personal care for elderly residents",
            "risk management in care settings",
            "aged care policies and procedures",
        ],
    },
    "preferred_skills": {
        "technical": [],
        "soft_skills": [],
        "domain_knowledge": [
            "australian permanent residency or citizenship",
        ],
    },
}


class TestHardiJdPostProcess:

    @pytest.fixture(scope="class")
    def processed(self):
        return post_process_jd_analysis(HARDI_JD_RAW, role_family_id="nursing")

    def test_eligibility_dropped_from_preferred(self, processed):
        """`australian permanent residency or citizenship` was the only
        preferred CARE skill in the Hardi run. After post-process it
        must NOT be in skills and must be tagged as eligibility."""
        all_pref = []
        for cat in ("technical", "soft_skills", "domain_knowledge"):
            all_pref.extend(processed["preferred_skills"][cat])
        assert "australian permanent residency or citizenship" not in [s.lower() for s in all_pref]
        assert "australian permanent residency or citizenship" in [
            s.lower() for s in processed["lexicon_meta"]["preferred"]["eligibility"]
        ]

    def test_personal_safety_and_aged_care_policies_dropped_as_noise(self, processed):
        """Two CARE skills in the Hardi raw are framework/noise phrases.
        Both must vanish from skills and be tagged as noise."""
        all_req = []
        for cat in ("technical", "soft_skills", "domain_knowledge"):
            all_req.extend(s.lower() for s in processed["required_skills"][cat])
        # The raw had "risk management in care settings" and
        # "aged care policies and procedures" — both are noise.
        assert "risk management in care settings" not in all_req
        assert "aged care policies and procedures" not in all_req
        noise_list = [s.lower() for s in processed["lexicon_meta"]["required"]["noise"]]
        assert "risk management in care settings" in noise_list
        assert "aged care policies and procedures" in noise_list

    def test_clinical_skills_moved_from_technical_to_domain(self, processed):
        """The LLM put `wound management`, `continence management`,
        `clinical assessments`, `clinical observations`, `resident
        charting and documentation` in `technical` (→ would render as
        Other Skills for nursing). Lexicon must move them to
        domain_knowledge (→ Care Skills)."""
        dom = [s.lower() for s in processed["required_skills"]["domain_knowledge"]]
        tech = [s.lower() for s in processed["required_skills"]["technical"]]
        assert "wound care" in dom              # wound management → wound care
        assert "continence care" in dom         # continence management → continence care
        assert "clinical assessments" in dom
        assert "clinical observations" in dom
        assert "clinical documentation" in dom  # resident charting → clinical documentation
        # NONE of these should be left in technical
        for kw in ("wound care", "continence care", "clinical assessments",
                   "clinical observations", "clinical documentation",
                   "wound management", "continence management"):
            assert kw not in tech, f"{kw!r} should have moved out of technical"

    def test_other_skills_only_real_tech_skills(self, processed):
        """For nursing, `technical` (→ Other Skills line) must only hold
        genuine tools/software/computing. After the move-out of
        clinical items, the only survivors are `computer skills` and
        `writing skills` (kept where the LLM put them — they're soft
        skills semantically, but writing skills isn't in our lexicon
        as a canonical-bucket-correcting entry so it stays where LLM
        placed it)."""
        tech = processed["required_skills"]["technical"]
        # Whatever survives, it must NOT be a clinical skill or a noise/credential.
        forbidden = {
            "wound management", "wound care", "continence management",
            "continence care", "clinical assessments", "clinical observations",
            "resident charting", "resident charting and documentation",
            "clinical documentation", "australian permanent residency or citizenship",
            "personal safety and risk management",
        }
        for s in tech:
            assert s.lower() not in forbidden, f"junk leaked into technical: {s!r}"

    def test_soft_skills_canonicalised(self, processed):
        """Variants like `effective verbal communication`, `ability to
        work in a team` should resolve to canonical entries."""
        soft = [s.lower() for s in processed["required_skills"]["soft_skills"]]
        # `effective verbal communication` → canonical `verbal communication`
        assert "verbal communication" in soft
        # `effective written communication` → canonical `written communication`
        assert "written communication" in soft
        # `ability to work in a team` → canonical `teamwork`
        assert "teamwork" in soft
        # `ability to work autonomously` → canonical `working autonomously`
        assert "working autonomously" in soft

    def test_sidecar_records_moves(self, processed):
        """Audit trail must show clinical skills were moved from technical."""
        moved = processed["lexicon_meta"]["required"]["moved"]
        moved_phrases = {m["phrase"].lower(): m for m in moved}
        for kw in ("wound management", "continence management",
                   "resident charting and documentation"):
            assert kw in moved_phrases, f"{kw!r} should appear in moved"
            entry = moved_phrases[kw]
            assert entry["from"] == "technical"
            assert entry["to"] == "domain_knowledge"

    def test_lexicon_meta_exposed(self, processed):
        meta = processed["lexicon_meta"]
        assert meta["role_family"] == "nursing"
        assert meta["vertical"] == "nursing"
        assert "required" in meta and "preferred" in meta


# ---------------------------------------------------------------------------
# Idempotence + master/general fallback
# ---------------------------------------------------------------------------


class TestStructural:

    def test_idempotent(self):
        """Re-running post_process on its own output must be a no-op."""
        once = post_process_jd_analysis(HARDI_JD_RAW, role_family_id="nursing")
        twice = post_process_jd_analysis(once, role_family_id="nursing")
        # The lexicon_meta itself changes (re-processed against the cleaned
        # skills, so the dropped/moved lists are now empty) — but the SKILLS
        # themselves must be unchanged.
        for bucket in ("required_skills", "preferred_skills"):
            for cat in ("technical", "soft_skills", "domain_knowledge"):
                assert sorted(once[bucket][cat]) == sorted(twice[bucket][cat])

    def test_master_family_still_strips_noise(self):
        """Master / general family has no vertical lexicon. We must still
        strip universal noise (sector-agnostic)."""
        raw = {
            "required_skills": {
                "technical": ["python", "police check"],
                "soft_skills": [],
                "domain_knowledge": [],
            },
            "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }
        out = post_process_jd_analysis(raw, role_family_id="master")
        tech = [s.lower() for s in out["required_skills"]["technical"]]
        assert "python" in tech  # kept (no vertical lex, but not noise)
        assert "police check" not in tech  # dropped as credential
        assert "police check" in [
            s.lower() for s in out["lexicon_meta"]["required"]["credential"]
        ]

    def test_unknown_phrase_kept_in_llm_bucket(self):
        """A phrase the lexicon doesn't know stays in the LLM-assigned
        bucket (safe fallback) and is recorded in sidecar.unknown."""
        raw = {
            "required_skills": {
                "technical": ["some-future-framework-nobody-has-heard-of"],
                "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }
        out = post_process_jd_analysis(raw, role_family_id="tech")
        assert "some-future-framework-nobody-has-heard-of" in out["required_skills"]["technical"]
        unknowns = [u["phrase"] for u in out["lexicon_meta"]["required"]["unknown"]]
        assert "some-future-framework-nobody-has-heard-of" in unknowns


# ---------------------------------------------------------------------------
# Qualification / nursing-course-progress filter
# ---------------------------------------------------------------------------


class TestNursingCourseProgressIsCredential:
    """Regression for the Australian Unity AIN run (2026-06-10): the JD asked
    for 'completed first year of nursing course' and it landed in Other Skills
    instead of being filtered as a credential.

    Nursing-course progression is a QUALIFICATION descriptor, not a skill —
    same category as 'Bachelor of Nursing' or 'Certificate IV in Ageing Support'.
    Must route to sidecar['credential']."""

    from app.services.skills.post_process import _is_qualification_phrase

    @pytest.mark.parametrize("phrase", [
        "completed first year of nursing course",
        "Completed First Year of Nursing Course",
        "completed first year of nursing",
        "completed second year of nursing studies",
        "completed third year of midwifery",
        "completed first year of medicine",
        "first year of nursing course",
        "First Year of Nursing",
        "third year medical student",
        "year 2 of nursing course",
        "year one of nursing studies",
        "completed bachelor of nursing",
        "completed diploma of nursing",
        "completed certificate III in aged care",
        "completed nursing degree",
    ])
    def test_qualification_progress_phrases_caught(self, phrase):
        from app.services.skills.post_process import _is_qualification_phrase
        assert _is_qualification_phrase(phrase), f"{phrase!r} should be filtered as a qualification"

    @pytest.mark.parametrize("phrase", [
        # These read superficially like qualifications but aren't — the regex
        # must NOT route them to credentials (they'd disappear from Skills).
        "first year of employment",
        "first year experience",
        "first year graduate program",   # ambiguous; conservatively keep as skill
        "year 2 of employment",
        "year of experience in nursing",
        # Real skills — non-negotiable
        "person-centred care",
        "medication administration",
        "aged care",
        "dementia care",
        "communication",
        "teamwork",
    ])
    def test_real_skills_not_falsely_filtered(self, phrase):
        from app.services.skills.post_process import _is_qualification_phrase
        assert not _is_qualification_phrase(phrase), f"{phrase!r} must NOT be filtered (it's a real skill / not a qual)"


# ---------------------------------------------------------------------------
# CV-side noise filter
# ---------------------------------------------------------------------------


class TestCvSideNoiseFilter:

    def test_universal_noise_stripped_from_cv_buckets(self):
        """The CV categoriser may bucket eligibility/credentials as
        skills. The post-process must strip them."""
        cv = {
            "technical": ["bestmed", "medmobile", "police check"],
            "soft_skills": ["empathy", "australian work rights"],
            "domain_knowledge": ["dementia care", "personal safety and risk management"],
        }
        cleaned, sidecar = post_process_cv_skills(cv)
        # noise + creds + eligibility gone from skills
        assert "police check" not in [s.lower() for s in cleaned["technical"]]
        assert "australian work rights" not in [s.lower() for s in cleaned["soft_skills"]]
        assert "personal safety and risk management" not in [
            s.lower() for s in cleaned["domain_knowledge"]
        ]
        # real skills survive
        assert "bestmed" in [s.lower() for s in cleaned["technical"]]
        assert "medmobile" in [s.lower() for s in cleaned["technical"]]
        assert "empathy" in [s.lower() for s in cleaned["soft_skills"]]
        assert "dementia care" in [s.lower() for s in cleaned["domain_knowledge"]]
        # sidecar tracks what was dropped (keys are SINGULAR — match NoiseT)
        assert "police check" in [s.lower() for s in sidecar["credential"]]
        assert "australian work rights" in [s.lower() for s in sidecar["eligibility"]]
        assert "personal safety and risk management" in [
            s.lower() for s in sidecar["noise"]
        ]

    def test_clean_cv_passes_through_unchanged(self):
        """A CV with already-clean buckets must round-trip identically."""
        cv = {
            "technical": ["bestmed", "medmobile"],
            "soft_skills": ["empathy", "teamwork"],
            "domain_knowledge": ["dementia care", "personal care", "manual handling"],
        }
        cleaned, sidecar = post_process_cv_skills(cv)
        assert cleaned == cv
        assert sidecar["credential"] == []
        assert sidecar["eligibility"] == []
        assert sidecar["noise"] == []


# ---------------------------------------------------------------------------
# Tech vertical sanity (Phase 2 isn't tech-only, but must not regress it)
# ---------------------------------------------------------------------------


class TestTechVertical:

    def test_tech_jd_moves_and_canonicalises(self):
        raw = {
            "required_skills": {
                "technical": ["python", "ReactJS", "postgres", "aws"],
                "soft_skills": ["agile"],   # mis-bucketed as soft by LLM
                "domain_knowledge": ["machine learning"],
            },
            "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
        }
        out = post_process_jd_analysis(raw, role_family_id="tech")
        tech = [s for s in out["required_skills"]["technical"]]
        dom = [s for s in out["required_skills"]["domain_knowledge"]]
        # canonicalised
        assert "Python" in tech
        assert "React" in tech
        assert "PostgreSQL" in tech
        assert "AWS" in tech
        # `agile` moved from soft to domain
        assert "agile" in dom
        assert "agile" not in out["required_skills"]["soft_skills"]
        # ML stays in domain
        assert "machine learning" in dom


# ---------------------------------------------------------------------------
# JD-body lexicon scan — closes the empty-Care-Skills variance on
# prose-heavy nursing JDs that the IT-centric JD analysis prompt missed.
# ---------------------------------------------------------------------------


_AUSTRALIAN_UNITY_JD_TEXT = """The assistant in nursing / care companion provides daily care
and companionship to aged care residents within a household-style living environment. The
role focuses on building strong relationships with residents, families, and colleagues
while maintaining safety through adherence to health and safety guidelines.

Required:
- relationship building
- teamwork
- reliability
- empathy
- flexibility for afternoon and night shifts
- current NDISWC

Responsibilities:
- support residents with daily personal care and companionship
- build strong, trusting relationships with residents, their families, and team members
- follow health and safety guidelines to keep residents, colleagues, and self safe
- work afternoon and night shifts with consistent availability across weekdays
- contribute to a homelike, community-focused environment for residents"""


def _au_unity_jd_analysis(domain_extras=None):
    """Build the exact LLM-side-shape jd_analysis the user's Australian Unity
    run produced (empty domain_knowledge, ndiswc leak, etc.). `domain_extras`
    lets a test pretend the LLM did extract something."""
    return {
        "job_title": "assistant in nursing",
        "summary": "AIN providing daily care and companionship to aged care residents.",
        "responsibilities": [
            "support residents with daily personal care and companionship",
            "build strong, trusting relationships with residents and families",
            "follow health and safety guidelines",
            "work afternoon and night shifts",
        ],
        "required_skills": {
            "technical": ["current ndiswc"],
            "soft_skills": [
                "relationship building", "teamwork", "reliability", "empathy",
                "flexibility for afternoon and night shifts",
            ],
            "domain_knowledge": list(domain_extras or []),
        },
        "preferred_skills": {
            "technical": [], "soft_skills": [], "domain_knowledge": [],
        },
    }


class TestJdBodyLexiconScan:
    def test_australian_unity_surfaces_care_skills(self):
        """The exact JD that produced 57% initial in the user's screenshot.
        After enrichment, domain_knowledge must be non-empty so presence-aware
        ATS scoring doesn't redistribute 25 points onto a single noise leak."""
        jd = _au_unity_jd_analysis()
        out = enrich_required_skills_from_jd_body(
            jd, _AUSTRALIAN_UNITY_JD_TEXT, role_family_id="nursing",
        )
        dk = out["required_skills"]["domain_knowledge"]
        assert dk, "JD body lexicon scan must populate domain_knowledge"
        dk_lower = [s.lower() for s in dk]
        # Personal care literal in responsibilities
        assert "personal care" in dk_lower
        # aged care is now a sector label stripped everywhere (Phase C)
        assert "aged care" not in dk_lower

    def test_no_double_add_when_llm_already_extracted_canonical(self):
        """When the LLM already pulled `personal care` into domain_knowledge,
        the scan must not duplicate it."""
        jd = _au_unity_jd_analysis(domain_extras=["personal care"])
        out = enrich_required_skills_from_jd_body(
            jd, _AUSTRALIAN_UNITY_JD_TEXT, role_family_id="nursing",
        )
        dk = out["required_skills"]["domain_knowledge"]
        assert dk.count("personal care") == 1

    def test_no_double_add_when_llm_extracted_variant(self):
        """When the LLM extracted a VARIANT (e.g. `personal care delivery`),
        the canonical is considered already-present — don't re-add."""
        jd = _au_unity_jd_analysis(domain_extras=["personal care delivery"])
        out = enrich_required_skills_from_jd_body(
            jd, _AUSTRALIAN_UNITY_JD_TEXT, role_family_id="nursing",
        )
        dk_lower = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
        # canonical not re-added
        assert dk_lower.count("personal care") == 0
        # the variant the LLM emitted stays (will be canonicalised by
        # post_process_jd_analysis later — separate concern)
        assert "personal care delivery" in dk_lower

    def test_noop_for_unknown_role_family(self):
        """master / unknown family → no vertical lexicon → return unchanged."""
        jd = _au_unity_jd_analysis()
        out = enrich_required_skills_from_jd_body(
            jd, _AUSTRALIAN_UNITY_JD_TEXT, role_family_id="master",
        )
        # Identity (no mutation)
        assert out is jd or out["required_skills"]["domain_knowledge"] == []

    def test_noop_when_no_scannable_text_anywhere(self):
        """With no jd_text AND no summary AND no responsibilities → no additions."""
        jd = {
            "job_title": "test",
            "summary": "",
            "responsibilities": [],
            "required_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = enrich_required_skills_from_jd_body(
            jd, "", role_family_id="nursing",
        )
        assert out["required_skills"]["domain_knowledge"] == []

    def test_respects_schema_cap_of_10(self):
        """Pre-existing 9 items + many JD-body hits → cap at 10 total."""
        jd = _au_unity_jd_analysis(domain_extras=[
            "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9",
        ])
        out = enrich_required_skills_from_jd_body(
            jd, _AUSTRALIAN_UNITY_JD_TEXT, role_family_id="nursing",
        )
        assert len(out["required_skills"]["domain_knowledge"]) <= 10

    def test_scans_responsibilities_field(self):
        """A skill present ONLY in jd_analysis.responsibilities (not in jd_text
        parameter) must still be picked up — JDs are sometimes truncated and
        the structured responsibilities list is the cleaner signal."""
        jd = _au_unity_jd_analysis()
        # Pass empty jd_text — responsibilities alone must trigger matches
        out = enrich_required_skills_from_jd_body(
            jd, "", role_family_id="nursing",
        )
        # No jd_text, but responsibilities mention "personal care" + "aged care"
        # via summary too. Actually summary too is non-empty so scan should hit.
        dk_lower = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
        assert "personal care" in dk_lower or "aged care" in dk_lower

    def test_word_boundary_does_not_match_substring(self):
        """The lexicon entry 'feeding' must not match 'breastfeeding' or
        unrelated word fragments."""
        jd = {
            "job_title": "test",
            "summary": "Role involves breastfeeding research and pacemaker monitoring.",
            "responsibilities": [],
            "required_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = enrich_required_skills_from_jd_body(
            jd, "Role involves breastfeeding research.", role_family_id="nursing",
        )
        # 'feeding' (variant of 'feeding assistance') should NOT match
        # 'breastfeeding' due to \b regex anchor.
        dk_lower = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
        assert "feeding assistance" not in dk_lower


# ---------------------------------------------------------------------------
# Phase 2 — multi-bucket recall floor
# ---------------------------------------------------------------------------
# The recall floor scans the JD body against the per-vertical lexicon for
# ALL THREE buckets (technical / soft_skills / domain_knowledge), not just
# domain_knowledge. Closes paraphrase misses ("commitment to allocated
# shifts" → reliability) and per-run variance on the soft_skills side.


def _empty_jd_analysis(jd_text: str, *, summary: str = "", responsibilities=None):
    """Build a jd_analysis with all buckets empty — the harshest test of
    the recall floor (every match must come from the JD body scan)."""
    return {
        "job_title": "assistant in nursing",
        "summary": summary,
        "responsibilities": list(responsibilities or []),
        "required_skills": {
            "technical": [], "soft_skills": [], "domain_knowledge": [],
        },
        "preferred_skills": {
            "technical": [], "soft_skills": [], "domain_knowledge": [],
        },
        "_jd_text": jd_text,
    }


class TestRecallFloorAllBuckets:
    """Recall floor policy:
      • soft_skills — DISABLED. The lexicon canonicalisation crosses word
        families ("compassionate" → canonical "empathy", "flexible" →
        "adaptability"), which violates the JD-analysis prompt's verbatim
        rule. The LLM already extracts 6-9 soft skills per JD; the
        groundedness gate filters hallucinations. No augmentation needed.
      • technical + domain_knowledge — still active. These are deterministic
        lexicon matches and the canonicals are stable word-family rewrites
        ("commercial cleaning" canonical surfaces from "industrial cleaning"
        variants — same noun, same role).
    """

    def test_soft_skills_recall_disabled(self):
        """JD body contains lexicon variants of soft canonicals, but the
        floor must NOT inject them — soft-skill recall is intentionally off
        to preserve the JD's surface phrasing."""
        jd_text = (
            "We need someone compassionate who is flexible with shifts and "
            "works well as part of a team."
        )
        jd = _empty_jd_analysis(jd_text)
        out = enrich_required_skills_from_jd_body(
            jd, jd_text, role_family_id="nursing",
        )
        soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
        # None of these canonicals — emanating from different word families —
        # should be auto-injected into soft_skills by the floor.
        for canon in ("empathy", "adaptability", "teamwork"):
            assert canon not in soft, (
                f"{canon} re-injected from a cross-family variant — the "
                "soft-skills recall floor must remain disabled"
            )

    def test_domain_knowledge_recall_still_active(self):
        """domain_knowledge floor remains on — the recall safety net was
        added specifically to fix the empty-domain-bucket variance issue."""
        jd_text = (
            "Provide personal care and emotional support to residents."
        )
        jd = _empty_jd_analysis(jd_text)
        out = enrich_required_skills_from_jd_body(
            jd, jd_text, role_family_id="nursing",
        )
        dom = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
        assert "personal care" in dom
        assert "emotional support" in dom

    def test_per_bucket_cap_respected_when_full(self):
        """Cap still honoured for the still-active buckets."""
        jd_text = "Provide personal care, mobility support, falls prevention."
        ten_existing = [f"dom_{i}" for i in range(10)]
        jd = _empty_jd_analysis(jd_text)
        jd["required_skills"]["domain_knowledge"] = list(ten_existing)
        out = enrich_required_skills_from_jd_body(
            jd, jd_text, role_family_id="nursing",
        )
        # Cap honoured — list length never exceeds 10
        assert len(out["required_skills"]["domain_knowledge"]) == 10
        for kw in ten_existing:
            assert kw in out["required_skills"]["domain_knowledge"]


# ---------------------------------------------------------------------------
# Pattern-based recognisers: conditional clauses, languages, VET unit codes.
# All three surfaced from a single Australian Unity AIN JD that produced
# "current ndiswc or willingness to apply" as REQUIRED, "cantonese language"
# under Care Skills, and "hlthps007 unit" as a skill.
# ---------------------------------------------------------------------------


class TestConditionalClauseDetection:
    def test_trailing_or_willingness_to_apply(self):
        stripped, was = _split_conditional_phrase(
            "current ndiswc or willingness to apply"
        )
        assert was is True
        assert stripped == "current ndiswc"

    def test_trailing_or_willing_to_obtain(self):
        stripped, was = _split_conditional_phrase(
            "first aid certificate or willing to obtain"
        )
        assert was is True
        assert "first aid certificate" in stripped

    def test_trailing_eligibility_to_apply(self):
        stripped, was = _split_conditional_phrase(
            "police check eligibility to apply"
        )
        assert was is True
        assert stripped == "police check"

    def test_plain_skill_unchanged(self):
        stripped, was = _split_conditional_phrase("teamwork")
        assert was is False
        assert stripped == "teamwork"

    def test_does_not_strip_if_nothing_left(self):
        """Safety guard: a phrase that is ENTIRELY a conditional clause has
        no extractable skill, so we leave it alone rather than emit a blank."""
        stripped, was = _split_conditional_phrase("willing to apply")
        # The strip would leave nothing → don't claim it was conditional.
        assert was is False


class TestConditionalDemoter:
    def test_demotes_to_preferred_with_stripped_text(self):
        jd = {
            "required_skills": {
                "technical": ["current ndiswc or willingness to apply"],
                "soft_skills": ["teamwork", "empathy"],
                "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = _demote_conditional_required_to_preferred(jd)
        assert "current ndiswc" in out["preferred_skills"]["technical"]
        # Conditional REMOVED from required; the unrelated soft skills stay.
        assert out["required_skills"]["technical"] == []
        assert out["required_skills"]["soft_skills"] == ["teamwork", "empathy"]

    def test_noop_when_no_conditional_entries(self):
        jd = {
            "required_skills": {
                "technical": ["python"],
                "soft_skills": ["teamwork"],
                "domain_knowledge": [],
            },
            "preferred_skills": {
                "technical": [], "soft_skills": [], "domain_knowledge": [],
            },
        }
        out = _demote_conditional_required_to_preferred(jd)
        # Same object returned when nothing changed (idempotency contract).
        assert out is jd or out["required_skills"] == jd["required_skills"]


class TestLanguageDetection:
    def test_x_language_pattern(self):
        for lang in ("cantonese language", "greek language", "arabic language",
                     "mandarin language"):
            assert _looks_like_language(lang), f"missed: {lang}"

    def test_speaking_pattern(self):
        assert _looks_like_language("spanish-speaking")
        assert _looks_like_language("italian speaker")
        assert _looks_like_language("fluent in mandarin")

    def test_sign_language_is_not_a_language_skill(self):
        """Sign language is a clinical communication competency, not a
        spoken/written language entry — keep as a normal skill."""
        assert not _looks_like_language("sign language")

    def test_body_language_is_not_a_language_skill(self):
        assert not _looks_like_language("body language")

    def test_plain_skills_are_not_languages(self):
        for s in ("teamwork", "communication", "personal care", "wound care"):
            assert not _looks_like_language(s)

    def test_languages_route_to_technical_in_nursing(self):
        """Issue from user: 'cantonese language' was under Care Skills.
        After fix, languages must land in `technical` (Other Skills)."""
        skills = {
            "technical": [],
            "soft_skills": [],
            "domain_knowledge": ["cantonese language", "greek language",
                                 "arabic language"],
        }
        clean, side = post_process_skills(skills, role_family_id="nursing")
        assert "cantonese language" in clean["technical"]
        assert "greek language" in clean["technical"]
        assert "arabic language" in clean["technical"]
        assert clean["domain_knowledge"] == []
        # Each was MOVED from domain_knowledge → technical.
        assert len(side["moved"]) == 3
        assert all(m["from"] == "domain_knowledge" and m["to"] == "technical"
                   for m in side["moved"])


class TestAuUnitCodeDetection:
    def test_common_vet_codes(self):
        for code in ("HLTHPS007", "HLTAID011", "CHCCCS015", "BSBWHS311",
                     "SITXFSA001", "CPPGNA3001"):
            assert _is_au_unit_code(code), f"missed: {code}"

    def test_code_with_unit_suffix(self):
        assert _is_au_unit_code("hlthps007 unit")
        assert _is_au_unit_code("CHCCCS015 unit")

    def test_random_alphanumeric_does_not_match(self):
        for s in ("ABC123", "XYZ999", "random text"):
            assert not _is_au_unit_code(s)

    def test_plain_skills_do_not_match(self):
        for s in ("first aid", "teamwork", "wound care", "BESTMed"):
            assert not _is_au_unit_code(s)

    def test_unit_code_routes_to_credential(self):
        """'hlthps007 unit' as a JD skill is a qualification component, not
        a competency — must end up in sidecar.credential."""
        skills = {
            "technical": ["hlthps007 unit"],
            "soft_skills": [], "domain_knowledge": [],
        }
        clean, side = post_process_skills(skills, role_family_id="nursing")
        assert "hlthps007 unit" not in clean["technical"]
        assert "hlthps007 unit" in side["credential"]


class TestAustralianUnityEndToEnd:
    """End-to-end on the exact JD shape the user reported. All three
    pattern fixes must apply together via post_process_jd_analysis."""

    _JD = {
        "job_title": "assistant in nursing",
        "required_skills": {
            "technical": ["current ndiswc or willingness to apply"],
            "soft_skills": ["relationship building", "teamwork", "reliability",
                            "empathy"],
            "domain_knowledge": [],
        },
        "preferred_skills": {
            "technical": ["hlthps007 unit"],
            "soft_skills": [],
            "domain_knowledge": ["cantonese language", "greek language",
                                 "arabic language"],
        },
    }

    def test_all_three_fixes_apply_together(self):
        out = post_process_jd_analysis(self._JD, role_family_id="nursing")

        # 1. Conditional demoter: ndiswc moves from required → preferred,
        #    stripped of "or willingness to apply". Then the credential
        #    filter strips "current ndiswc" → sidecar.credential.
        assert out["required_skills"]["technical"] == []
        pref_creds = out["lexicon_meta"]["preferred"]["credential"]
        assert any("ndiswc" in c.lower() for c in pref_creds)

        # 2. Unit code: hlthps007 unit → sidecar.credential, NOT a skill.
        assert "hlthps007 unit" not in out["preferred_skills"]["technical"]
        assert any("hlthps007" in c.lower() for c in pref_creds)

        # 3. Languages: moved from domain_knowledge (Care Skills) to
        #    technical (Other Skills).
        pref_tech = [s.lower() for s in out["preferred_skills"]["technical"]]
        assert "cantonese language" in pref_tech
        assert "greek language" in pref_tech
        assert "arabic language" in pref_tech
        assert out["preferred_skills"]["domain_knowledge"] == []


class TestEmbeddedCredentialMarkers:
    """Catch credential leakage when the marker is mid-phrase (the leading-
    anchored qualification detector misses these). Real Opal HealthCare JD."""

    def test_detector_catches_certificate_at_iv_level(self):
        assert _has_credential_marker("individual support at certificate iv level")
        assert _has_credential_marker("aged care at certificate iv level")
        assert _has_credential_marker("aged care at cert iv level")
        assert _has_credential_marker("aged care at certificate 4 level")

    def test_detector_catches_slashed_cert(self):
        """Real Uniting JD pattern: 'aged care (certificate iii/iv)'."""
        assert _has_credential_marker("aged care (certificate iii/iv)")
        assert _has_credential_marker("aged care (certificate iii / iv)")
        assert _has_credential_marker("aged care (cert iii or iv)")
        assert _has_credential_marker("individual support certificate iii in ageing")

    def test_detector_catches_credential_paren_tails(self):
        """Real Anglicare + Nurselink JDs: parenthetical credential indicators
        after a skill-shaped head."""
        # Anglicare — Cert III area listing
        assert _has_credential_marker("individual support (ageing, home and community)")
        assert _has_credential_marker("individual support (aged, home, and community)")
        # Nurselink — immunisation
        assert _has_credential_marker(
            "infection prevention and control (immunisation requirements)"
        )
        # Anglicare round-5 variant
        assert _has_credential_marker("infection prevention (vaccination awareness)")
        # AHPRA registration
        assert _has_credential_marker("registered nurse registration (ahpra)")

    def test_paren_tail_does_NOT_fire_on_clarifying_parens(self):
        """Clarifying parentheticals (tool synonyms, abbreviations) must
        stay; only credential-flavoured tails are stripped."""
        assert not _has_credential_marker("medication management (bestmed)")
        assert not _has_credential_marker("emr (electronic medical record)")
        assert not _has_credential_marker("personal care (showering, dressing)")

    def test_detector_catches_medication_endorsement(self):
        assert _has_credential_marker("medication endorsement (hlthps007 unit)")
        assert _has_credential_marker("medication endorsement")
        assert _has_credential_marker("medication endorsement (HLTHPS007)")

    def test_detector_catches_embedded_unit_codes(self):
        assert _has_credential_marker("experience with HLTAID011")
        assert _has_credential_marker("training in CHCCCS015")

    def test_detector_does_not_false_fire_on_real_skills(self):
        assert not _has_credential_marker("individual support")
        assert not _has_credential_marker("aged care")
        assert not _has_credential_marker("personal care")
        assert not _has_credential_marker("dementia care")
        assert not _has_credential_marker("clinical documentation")

    def test_jd_analysis_routes_embedded_credentials_to_sidecar(self):
        """The real Opal HealthCare JD that surfaced this issue."""
        jd = {
            "required_skills": {"technical": [], "soft_skills": [],
                                "domain_knowledge": ["individual support", "aged care"]},
            "preferred_skills": {"technical": [], "soft_skills": [],
                                 "domain_knowledge": [
                                     "individual support at certificate iv level",
                                     "aged care at certificate iv level",
                                     "medication endorsement (hlthps007 unit)",
                                 ]},
        }
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        pref_dom = out["preferred_skills"]["domain_knowledge"]
        # Care Skills bucket must NOT contain any of the three credential phrases.
        for phrase in (
            "individual support at certificate iv level",
            "aged care at certificate iv level",
            "medication endorsement (hlthps007 unit)",
        ):
            assert phrase not in pref_dom, f"{phrase} still leaking to Care Skills"
        # All three should be in the preferred credential sidecar.
        pref_creds = out["lexicon_meta"]["preferred"]["credential"]
        assert any("certificate iv" in c.lower() for c in pref_creds)
        assert any("medication endorsement" in c.lower() for c in pref_creds)
