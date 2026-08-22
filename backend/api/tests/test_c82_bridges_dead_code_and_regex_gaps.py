"""C82 — regression tests for bridges.py dead-code revival + regex gaps.

Findings from the C79 writers/* read-through (documented in
~/.claude/plans/C78-C81-INSTRUCTIONS.md, not in this repo):

  #1 — _apply_setting_bridge (the deterministic S1 fabrication-repair pass
       introduced by 1336734e to fix a REAL reported fabrication — a
       residential-only candidate's tailored CV claiming "acute clinical
       settings") was disconnected from the production pipeline by
       0628a5d1 ("route summary only through apply_w3_gates"). The
       function, its evidence gates, and extras["jd_setting"] plumbing
       were all left in place; only the call site inside
       _writer_w8_verified was deleted. apply_w3_gates has zero
       setting/bridge-related logic, so nothing replaced it — this is a
       live regression, not an intentional consolidation.

  #3 — _CV_HOSPITAL_MARKERS_RE / _CV_THEATRE_MARKERS_RE miss plural /
       suffixed real-CV phrasing ("medical wards", "surgical wards",
       "acute settings", "acute wards", "anaesthetist", "anaesthetics",
       "theatres").

  #4 — the aged-care exclusion on the "registered nurse" alternative is
       defeated by the sibling bare "rn" alternative, which has no such
       exclusion.

  #5 — _CV_HOME_MARKERS_RE doesn't match the hyphenated "home-based care"
       form (only whitespace-separated "home based care").

Independent adversarial review of the #1 fix went five rounds (each round
found a NEW realistic pure-residential-aged-care CV phrasing that made the
restored HOSPITAL bridge fabricate "acute clinical settings" — bare RN/EN,
same-line-only aged-care exclusions, bare "hospital"/"acute care"/"clinical
placement" in bullets, employer-heading-name matching, and finally even
ward/unit-specific vocabulary like "emergency department"/"ICU"/"coronary
care" mentioned as something an aged-care worker escalates a RESIDENT to,
not evidence of their own workplace). No vocabulary-matching heuristic
survived scrutiny, so the HOSPITAL bridge itself was disabled — see
_SETTING_BRIDGES's comment in bridges.py. HOME/NDIS/THEATRE were not found
broken by any review round and are unchanged.
"""
from __future__ import annotations

import inspect
import re

from app.services.eval.writers import _impl
from tests.test_post_verify_invariants import assert_invariant_runs_after_verify
from app.services.eval.writers.bridges import (
    _apply_setting_bridge,
    _build_jd_setting_block,
    _cv_has_hospital_experience,
    _cv_has_home_care_experience,
    _cv_has_theatre_experience,
    _SETTING_HOME,
    _SETTING_HOSPITAL,
)


# ---------------------------------------------------------------------------
# #1 — dead-code revival
# ---------------------------------------------------------------------------


def test_C82_writer_w8_verified_calls_apply_setting_bridge_after_verify_claims():
    """_apply_setting_bridge must run inside _writer_w8_verified, AFTER
    verify_claims — matching the pre-0628a5d1 call site and this file's
    own established "stamp/repair after verify_claims, else it gets
    undone" convention (see OPS-30/31/32 in graph.json).

    The pass now runs from the declared invariant set rather than a
    hand-written call, so membership of that set (plus a sweep after
    verify_claims) IS the wiring assertion — see
    tests/test_post_verify_invariants.py, which pins the same property for
    every pass at once instead of one incident at a time.
    """
    assert_invariant_runs_after_verify("apply_setting_bridge")


# ---------------------------------------------------------------------------
# #3 — marker regex plural / suffix gaps
# ---------------------------------------------------------------------------


class TestHospitalMarkerPluralsAndSettings:
    """A '### Employer' heading is required by _split_role_blocks (mirrors
    the canonical writer output, cv_renderer.py) — evidence must be
    attributable to a specific Experience entry."""

    def test_medical_wards_plural(self):
        cv = "## Experience\n\n### Anytown Health Service\n*AIN | 2023 – Present*\n- Worked across medical wards.\n"
        assert _cv_has_hospital_experience("", cv)

    def test_surgical_wards_plural(self):
        cv = "## Experience\n\n### Anytown Health Service\n*AIN | 2023 – Present*\n- Rotated through surgical wards.\n"
        assert _cv_has_hospital_experience("", cv)

    def test_acute_settings_plural(self):
        cv = "## Experience\n\n### Anytown Health Service\n*AIN | 2023 – Present*\n- Experience in acute settings.\n"
        assert _cv_has_hospital_experience("", cv)

    def test_acute_wards_plural(self):
        cv = "## Experience\n\n### Anytown Health Service\n*AIN | 2023 – Present*\n- Cared for patients on acute wards.\n"
        assert _cv_has_hospital_experience("", cv)


class TestTheatreMarkerSuffixes:
    def test_anaesthetist(self):
        cv = "## Experience\n\n### Anytown Health Service\n*AIN | 2023 – Present*\n- Assisted the anaesthetist during procedures.\n"
        assert _cv_has_theatre_experience("", cv)

    def test_anaesthetics(self):
        # No standalone "theatre" mention here — must match via the
        # anaesthet* suffix alone, not incidentally via a different marker.
        cv = "## Experience\n\n### Anytown Health Service\n*AIN | 2023 – Present*\n- Supported anaesthetics delivery during procedures.\n"
        assert _cv_has_theatre_experience("", cv)

    def test_theatres_plural(self):
        cv = "## Experience\n\n### Anytown Health Service\n*AIN | 2023 – Present*\n- Worked across multiple operating theatres.\n"
        assert _cv_has_theatre_experience("", cv)


# ---------------------------------------------------------------------------
# #4 — "rn"/"en" are not reliable hospital evidence in any form (see
# TestHospitalGateFalsePositives below for the full round-2/round-3 story —
# a same-line exclusion was tried and abandoned as unreliable against the
# canonical multi-line layout; the qualification markers were removed
# entirely rather than patched further).
# ---------------------------------------------------------------------------


class TestRnAgedCareExclusion:
    def test_bare_rn_excluded_when_only_aged_care_context(self):
        """A nursing-qualification abbreviation alone is never hospital
        evidence — aged-care facilities employ RNs routinely."""
        cv = (
            "## Experience\n\n### Sunset Gardens Aged Care\n"
            "*Registered Nurse (RN) | Jan 2024 – Present*\n"
            "- Providing clinical oversight in residential aged care.\n"
        )
        assert not _cv_has_hospital_experience("", cv)

    def test_rn_still_matches_a_genuine_hospital_mention(self):
        """Sanity: RN's own absence from the marker set doesn't suppress a
        genuinely reliable co-occurring marker in the same bullet."""
        cv = "## Experience\n\n### Anytown Health Service\n*RN | 2023 – Present*\n- Worked as an RN on a surgical ward.\n"
        assert _cv_has_hospital_experience("", cv)


# ---------------------------------------------------------------------------
# #5 — home marker hyphenation gap
# ---------------------------------------------------------------------------


class TestHomeMarkerHyphenation:
    def test_hyphenated_home_based_care(self):
        assert _cv_has_home_care_experience("", "## Experience\nProvided home-based care to clients.")

    def test_whitespace_home_based_care_still_works(self):
        assert _cv_has_home_care_experience("", "## Experience\nProvided home based care to clients.")


# ---------------------------------------------------------------------------
# Blocking issues surfaced by the independent adversarial review of the C82
# fix (bare RN/EN false-positives + no-heading whole-doc fallback both let
# a pure aged-care CV gate-pass the HOSPITAL bridge; the substitution itself
# is non-idempotent and doubles the bridge phrase on a second pass).
# ---------------------------------------------------------------------------


class TestHospitalGateFalsePositives:
    def test_bare_rn_mention_in_pure_aged_care_experience_does_not_gate_pass(self):
        """AINs/PCAs routinely write 'under RN supervision' in aged-care
        bullets — this is NOT evidence the candidate worked in a hospital.
        'aged care' is on a DIFFERENT line than 'RN' (the employer heading,
        not the bullet), so a same-line exclusion can't catch it; bare RN
        must not be treated as hospital evidence at all."""
        cv = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2024 – Present*\n"
            "- Provided medication assistance under RN supervision.\n"
        )
        assert not _cv_has_hospital_experience(cv, "")

    def test_bare_en_mention_in_aged_care_role_does_not_gate_pass(self):
        """Same class of false positive for Enrolled Nurse — the original
        'registered nurse' aged-care exclusion never covered 'enrolled
        nurse' at all, bare or full-phrase."""
        cv = "## Experience\n\nEnrolled Nurse (EN), Sunset Gardens Aged Care.\n"
        assert not _cv_has_hospital_experience(cv, "")

    def test_registered_nurse_title_at_an_aged_care_employer_on_separate_lines_does_not_gate_pass(self):
        """Surfaced by independent review round 2: the aged-care exclusion is
        same-line only, but the canonical writer output (cv_renderer.py)
        always puts the employer heading and the role/title line on
        SEPARATE lines:

            ### Sunset Gardens Aged Care | Sydney, NSW
            *Registered Nurse | Jan 2020 - Present*
            - Led medication rounds for 60 residents.

        This is the STANDARD layout, not an edge case — a same-line
        lookahead can never see the employer name on the line above.
        A nursing qualification title (RN/EN) is evidence of a
        REGISTRATION, not a SETTING; aged-care facilities employ RNs/ENs
        routinely, so this qualification must not be treated as hospital
        evidence at all, regardless of layout."""
        cv = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Registered Nurse | Jan 2020 – Present*\n"
            "- Led medication rounds for 60 residents.\n"
        )
        assert not _cv_has_hospital_experience(cv, "")

    def test_no_experience_heading_does_not_fall_back_to_whole_document_scan(self):
        """When no Experience/Education heading is found, the gate must fail
        CLOSED (no evidence), not silently scan the whole document — a
        Summary/Objective line mentioning 'hospital' is exactly the
        self-confirmation this gate exists to prevent."""
        cv = (
            "Career Objective: seeking a role in a hospital setting.\n\n"
            "Worked at Sunset Gardens residential aged care."
        )
        assert not _cv_has_hospital_experience(cv, "")

    def test_hospital_transfer_coordination_in_an_aged_care_bullet_does_not_gate_pass(self):
        """Round-3 review repro: 'hospital' appearing as an external
        destination an aged-care worker coordinates with is not evidence
        the CANDIDATE worked in a hospital."""
        cv = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2023 – Present*\n"
            "- Escalated deteriorating residents and coordinated hospital "
            "transfers with the RN on duty.\n"
        )
        assert not _cv_has_hospital_experience(cv, "")

    def test_clinical_placement_at_an_aged_care_employer_does_not_gate_pass(self):
        """A nursing student's clinical placement AT an aged-care facility
        is not hospital evidence — 'clinical placement' names the activity,
        not the setting, unless the employer heading itself says so."""
        cv = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Clinical Placement – Diploma of Nursing | 240 hours*\n"
            "- Assisted residents with personal care under supervision.\n"
        )
        assert not _cv_has_hospital_experience(cv, "")

    def test_acute_care_needs_of_residents_does_not_gate_pass(self):
        """'Acute care' describing a RESIDENT's acuity is common aged-care
        vocabulary, not evidence the facility is a hospital."""
        cv = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2023 – Present*\n"
            "- Supported residents with complex and acute care needs in a "
            "90-bed home.\n"
        )
        assert not _cv_has_hospital_experience(cv, "")

    def test_employer_named_hospital_alone_does_not_gate_pass_without_a_ward_marker(self):
        """Round-4 review repro: a heading-name check (even scoped only to
        '### ' lines) is defeated in both directions — a non-clinical job
        AT a hospital ("### Royal Melbourne Hospital \\n *Food Services
        Assistant*") false-positives, and a hospital-NAMED aged-care
        facility ("### St Vincent's Hospital Residential Aged Care") also
        false-positives while self-disambiguating in its own name. Employer
        naming is dropped as a signal entirely; only ward/unit-specific
        vocabulary counts, checked anywhere in the Experience section (same
        plain scan every other bridge gate uses)."""
        cv = (
            "## Experience\n\n"
            "### City Hospital | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2023 – Present*\n"
            "- Supported the nursing team with patient care.\n"
        )
        assert not _cv_has_hospital_experience(cv, "")

    def test_genuine_hospital_ward_experience_still_gate_passes(self):
        """Sanity: unambiguous ward/unit-specific markers stay reliable
        anywhere in the Experience section — the gate isn't over-corrected
        into never firing, and doesn't need a hospital-named employer."""
        cv = (
            "## Experience\n\n"
            "### Anytown Health Service | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2023 – Present*\n"
            "- Supported patients on a surgical ward.\n"
        )
        assert _cv_has_hospital_experience(cv, "")

    def test_non_clinical_role_at_a_hospital_does_not_gate_pass(self):
        """Round-4 review repro: a non-clinical job AT a hospital (food
        services, cleaning, ward clerk — common for this codebase's
        student/migrant aged-care user base) is not evidence of clinical
        hospital experience, even though the employer genuinely is a
        hospital."""
        cv = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Feb 2023 – Present*\n"
            "- Delivered personal care, showering and dressing for 30 "
            "permanent residents.\n\n"
            "### Royal Melbourne Hospital | Melbourne, VIC\n"
            "*Food Services Assistant | Jan 2021 – Dec 2022*\n"
            "- Delivered meal trays to wards and collected completed menu "
            "cards.\n"
        )
        assert not _cv_has_hospital_experience(cv, "")

    def test_certification_heading_outside_experience_does_not_gate_pass(self):
        """Round-4 structural finding: evidence must be attributable to the
        Experience section specifically, not any '### ' heading appearing
        later in the document under an unrelated '## ' section (e.g. a
        Certifications entry named after a course, not a workplace)."""
        cv = (
            "## Experience\n\n"
            "### Sunset Gardens Aged Care | Sydney, NSW\n"
            "*Assistant in Nursing | Jan 2023 – Present*\n"
            "- Provided personal care to residents.\n\n"
            "## Certifications\n\n"
            "### Acute Care Skill Set — TAFE NSW\n"
            "- Completed 2024.\n"
        )
        assert not _cv_has_hospital_experience(cv, "")


class TestSettingBridgeIdempotent:
    def test_does_not_double_the_bridge_phrase_on_a_second_pass(self):
        """The composer prompt itself instructs the model to write the
        bridge phrasing directly (_build_jd_setting_block's HARD RULES for
        the settings that still have one), so S1 commonly already contains
        it before this deterministic pass runs. _S1_RESIDENTIAL_RE matches
        the RESIDENTIAL-framed PREFIX of an already-bridged phrase, so a
        naive substitution doubles the tail. Uses HOME (still an active
        bridge — see TestHospitalBridgeDisabled for why HOSPITAL no longer
        has one), so this genuinely exercises the substitution path rather
        than passing via a no-op."""
        md = (
            "## Career Highlights\n\n"
            "Care worker with experience in residential aged care, delivering "
            "care in home and community settings, dedicated to resident "
            "wellbeing. Recent experience at Org A.\n\n"
            "## Experience\n\n"
            "### Org A | Sydney, NSW\n*Support Worker | Jan 2024 – Present*\n"
            "- Delivered home care visits to clients in the community.\n"
        )
        out = _apply_setting_bridge(md, _SETTING_HOME, cv_text=md)
        assert out.count("home and community settings") == 1, (
            f"bridge phrase was duplicated by a second pass:\n{out}"
        )


# ---------------------------------------------------------------------------
# Round-5 resolution: the HOSPITAL bridge itself is disabled. Five review
# rounds each found a new, realistic pure-residential-aged-care CV phrasing
# that made a vocabulary-based evidence gate fabricate "acute clinical
# settings" — no heuristic survived. HOSPITAL now behaves like LIFESTYLE
# (which never had a bridge phrase): _apply_setting_bridge is unconditionally
# a no-op, and the composition prompt no longer instructs the model to write
# a bridge claim either.
# ---------------------------------------------------------------------------


class TestHospitalBridgeDisabled:
    def test_apply_setting_bridge_is_a_no_op_for_hospital_even_with_strong_evidence(self):
        """Even genuine, unambiguous hospital-ward evidence must not produce
        a bridge — the deterministic pass for HOSPITAL is gone entirely,
        not gated."""
        md = (
            "## Career Highlights\n\n"
            "Care worker with experience in residential aged care settings, "
            "dedicated to resident wellbeing. Recent experience at Org A.\n\n"
            "## Experience\n\n"
            "### City Hospital | Sydney, NSW\n*AIN | Jan 2024 – Present*\n"
            "- Worked on a surgical ward.\n"
        )
        out = _apply_setting_bridge(md, _SETTING_HOSPITAL, cv_text=md)
        assert out == md
        assert "acute clinical settings" not in out

    def test_all_five_review_round_repros_stay_honest_end_to_end(self):
        """Each bullet below is a realistic pure-residential-aged-care
        phrasing that a prior round of this fix made gate-pass and fabricate
        a hospital claim (ED escalation, ICU, coronary care, hospital
        departments, a non-clinical hospital job, an RN title). With the
        bridge disabled, none of them can produce a fabrication regardless
        of what the evidence gate would say."""
        bullets = [
            "- Escalated deteriorating residents to the RN and arranged "
            "ambulance transfer to the emergency department.",
            "- Supported residents returning from ICU with pressure-area care.",
            "- Cared for residents post coronary care rehabilitation.",
            "- Liaised with hospital departments and GPs to coordinate "
            "resident appointments.",
        ]
        for bullet in bullets:
            md = (
                "## Career Highlights\n\n"
                "Care worker with experience in residential aged care settings, "
                "dedicated to resident wellbeing. Recent experience at Org A.\n\n"
                "## Experience\n\n"
                "### Sunset Gardens Aged Care | Sydney, NSW\n"
                "*Assistant in Nursing | Jan 2023 – Present*\n"
                f"{bullet}\n"
            )
            out = _apply_setting_bridge(md, _SETTING_HOSPITAL, cv_text=md)
            assert out == md, f"unexpected S1 rewrite for bullet: {bullet!r}\n{out}"
            assert "acute clinical settings" not in out

    def test_prompt_no_longer_instructs_the_model_to_write_a_bridge_claim(self):
        """The deterministic disable only closes half the risk — the
        composition prompt itself used to hard-instruct the model to write
        'aged care and acute clinical settings' regardless of CV evidence.
        That instruction must be gone too, or the model can fabricate the
        same claim on its own without any deterministic pass to blame."""
        block = _build_jd_setting_block(_SETTING_HOSPITAL)
        assert "acute clinical settings" not in block
        assert "use a bridge" not in block.lower()
