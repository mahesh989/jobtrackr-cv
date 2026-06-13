"""Phase 1 — lexicon-based skill classifier.

Locks in the deterministic resolver: phrase → canonical taxonomy entry.

Failure of any of these = a regression in the categorisation layer. The
"real cases" section asserts the exact symptoms from the Hardi/Nepean/
Rashmi nursing runs that triggered this rewrite — they MUST stay green.

This module is pure functions + bundled JSON, no DB / AI / network — so
the conftest's Supabase env stubs are sufficient.
"""
from __future__ import annotations

import pytest

from app.services.skills import (
    Classification,
    classify,
    classify_many,
    is_noise,
    lexicon_stats,
    normalise,
)


# ---------------------------------------------------------------------------
# Smoke / structural
# ---------------------------------------------------------------------------


class TestStructural:

    def test_lexicons_loaded(self):
        stats = lexicon_stats()
        # Sanity floors — if any lexicon is empty something is structurally wrong.
        assert stats["noise_keys"] >= 100
        assert stats["nursing_keys"] >= 200
        assert stats["cleaning_keys"] >= 200
        assert stats["tech_keys"] >= 400

    def test_unknown_returns_none(self):
        assert classify("completely-made-up term xyz", "nursing") is None
        assert classify("frobnicate the widget", "tech") is None

    def test_empty_input(self):
        assert classify("", "nursing") is None
        assert classify("   ", "nursing") is None
        assert classify(None, "nursing") is None  # type: ignore[arg-type]
        assert is_noise("") is None
        assert is_noise(None) is None  # type: ignore[arg-type]

    def test_invalid_vertical_returns_none(self):
        # Noise still matches (universal); skill lookup yields nothing
        # because no vertical lexicon is named "narnia".
        assert classify("wound care", "narnia") is None  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------


class TestNormalise:

    def test_lowercase(self):
        assert normalise("BESTMed") == "bestmed"

    def test_collapse_whitespace(self):
        assert normalise("  wound   care\n") == "wound care"

    def test_strips_qualifier_prefix(self):
        assert normalise("current First Aid") == "first aid"
        assert normalise("valid driver licence") == "driver licence"
        assert normalise("knowledge of infection control") == "infection control"
        assert normalise("ability to work autonomously") == "work autonomously"
        assert normalise("strong communication") == "communication"

    def test_strips_multiple_prefixes(self):
        # "current valid first aid certificate" — both prefixes peeled
        assert normalise("current valid first aid") == "first aid"

    def test_preserves_internal_hyphen(self):
        assert normalise("person-centred care") == "person-centred care"

    def test_preserves_tech_punctuation(self):
        # C++ / C# / .NET / CI/CD must survive normalisation
        assert "+" in normalise("C++")
        assert "#" in normalise("C#")
        assert "." in normalise(".NET")
        assert "/" in normalise("CI/CD")


# ---------------------------------------------------------------------------
# Real cases — Hardi / Nepean / Rashmi nursing runs.
# These were the actual leaks. They MUST stay green.
# ---------------------------------------------------------------------------


class TestRealNursingLeaks:

    def test_australian_permanent_residency_is_eligibility(self):
        """The Hardi JD leaked this into Care Skills."""
        c = classify("Australian permanent residency or citizenship", "nursing")
        assert c is not None
        assert c.is_noise
        assert c.noise_type == "eligibility"

    def test_personal_safety_and_risk_management_is_noise(self):
        """The Hardi JD leaked this into Other Skills."""
        c = classify("Personal safety and risk management", "nursing")
        assert c is not None
        assert c.is_noise
        assert c.noise_type == "noise"

    def test_infection_prevention_and_control_requirements_resolves(self):
        """The Nepean JD leaked this into Other Skills as JD-phrasing."""
        c = classify("infection prevention and control requirements", "nursing")
        assert c is not None
        # Either it's blocked as noise (the `requirements` suffix) OR it
        # resolves to the canonical clinical skill. Both are correct
        # outcomes; what's wrong is the previous behaviour of dumping it
        # verbatim into Other Skills.
        assert c.is_skill or c.is_noise
        if c.is_skill:
            assert c.canonical == "infection control"
            assert c.category == "domain_knowledge"

    def test_wound_management_resolves_to_domain(self):
        """The LLM put this in `technical` (Other Skills). Must be domain."""
        c = classify("wound management", "nursing")
        assert c is not None and c.is_skill
        assert c.category == "domain_knowledge"
        assert c.canonical == "wound care"

    def test_continence_management_resolves_to_domain(self):
        c = classify("continence management", "nursing")
        assert c is not None and c.is_skill
        assert c.category == "domain_knowledge"
        assert c.canonical == "continence care"

    def test_clinical_assessments_resolves_to_domain(self):
        c = classify("clinical assessments", "nursing")
        assert c is not None and c.is_skill
        assert c.category == "domain_knowledge"

    def test_resident_charting_resolves_to_domain(self):
        c = classify("resident charting", "nursing")
        assert c is not None and c.is_skill
        assert c.category == "domain_knowledge"

    def test_only_named_tools_are_technical_for_nursing(self):
        """For nursing, the technical bucket holds tool/software only."""
        for tool in ("BESTMed", "MedMobile", "Leecare", "Manad Plus"):
            c = classify(tool, "nursing")
            assert c is not None and c.is_skill, f"{tool} should be a skill"
            assert c.category == "technical", f"{tool} should be technical"

    def test_compliance_state_legislation_is_noise(self):
        c = classify("compliance with state healthcare legislation", "nursing")
        assert c is not None and c.is_noise
        assert c.noise_type == "noise"

    def test_credentials_are_credential_type_not_skills(self):
        for kw in ("police check", "first aid", "HLTAID011", "WWCC", "covid vaccination"):
            c = classify(kw, "nursing")
            assert c is not None, f"{kw} should resolve"
            assert c.is_noise, f"{kw} should be noise, not skill"
            assert c.noise_type == "credential", f"{kw} should be credential"


# ---------------------------------------------------------------------------
# CV ↔ JD agreement — the whole point of a shared lexicon.
# ---------------------------------------------------------------------------


class TestCvJdAgreement:

    @pytest.mark.parametrize("a,b", [
        ("wound care", "wound management"),
        ("medication administration", "administering medication"),
        ("person-centred care", "individualised care"),
        ("activities of daily living", "ADLs"),
        ("teamwork", "ability to work in a team"),
    ])
    def test_variants_resolve_to_same_canonical(self, a, b):
        """A skill written differently on CV vs JD must still match."""
        ca = classify(a, "nursing")
        cb = classify(b, "nursing")
        assert ca is not None and cb is not None
        assert ca.canonical == cb.canonical
        assert ca.category == cb.category


# ---------------------------------------------------------------------------
# Tech vertical sanity
# ---------------------------------------------------------------------------


class TestTechVertical:

    @pytest.mark.parametrize("phrase,canonical,category", [
        ("python", "Python", "technical"),
        ("Py", "Python", "technical"),
        ("postgres", "PostgreSQL", "technical"),
        ("PostgreSQL", "PostgreSQL", "technical"),
        ("MySQL", "MySQL", "technical"),
        ("react", "React", "technical"),
        ("ReactJS", "React", "technical"),
        ("typescript", "TypeScript", "technical"),
        ("ts", "TypeScript", "technical"),
        ("AWS", "AWS", "technical"),
        ("Amazon Web Services", "AWS", "technical"),
        ("docker", "Docker", "technical"),
        ("k8s", "Kubernetes", "technical"),
        ("agile", "agile", "domain_knowledge"),
        ("ci/cd", "CI/CD", "domain_knowledge"),
        ("continuous integration", "CI/CD", "domain_knowledge"),
        ("microservices", "microservices", "domain_knowledge"),
        ("rest api", "REST API", "technical"),
        ("graphql", "GraphQL", "technical"),
    ])
    def test_tech_head_terms(self, phrase, canonical, category):
        c = classify(phrase, "tech")
        assert c is not None, f"{phrase!r} should resolve in tech"
        assert c.is_skill
        assert c.canonical == canonical, (phrase, c.canonical, canonical)
        assert c.category == category


# ---------------------------------------------------------------------------
# Cleaning vertical sanity
# ---------------------------------------------------------------------------


class TestCleaningVertical:

    @pytest.mark.parametrize("phrase,canonical", [
        ("vacuuming", "vacuuming"),
        ("vacuum", "vacuuming"),
        ("bond clean", "end of lease cleaning"),
        ("vacate clean", "end of lease cleaning"),
        ("pressure washing", "high-pressure cleaning"),
        ("toilet cleaning", "bathroom cleaning"),
        ("ms office", "Microsoft Office"),
        ("manual handling", "manual handling"),
    ])
    def test_cleaning_head_terms(self, phrase, canonical):
        c = classify(phrase, "cleaning")
        assert c is not None, f"{phrase!r} should resolve in cleaning"
        assert c.canonical == canonical


# ---------------------------------------------------------------------------
# Fuzzy match — typo tolerance only, NOT semantic guessing.
# ---------------------------------------------------------------------------


class TestFuzzyMatch:

    def test_minor_typo_catches(self):
        """`wound managment` (missing e) → wound care via fuzzy."""
        c = classify("wound managment", "nursing")
        assert c is not None and c.is_skill
        assert c.canonical == "wound care"
        assert c.match_kind == "fuzzy"

    def test_fuzzy_rejects_unrelated(self):
        """A semantically distant phrase must NOT fuzzy-match into any
        bucket — the cutoff (0.88) is tight enough that 'organisational
        leadership' doesn't bleed into 'organisation'."""
        c = classify("organisational leadership", "nursing", fuzzy_cutoff=0.88)
        # No exact "organisational leadership" in the lexicon; the fuzzy
        # cutoff should reject 'organisation' as too distant.
        assert c is None or c.match_kind != "fuzzy" or c.canonical != "organisation"

    def test_fuzzy_can_be_disabled(self):
        c = classify("wound managment", "nursing", allow_fuzzy=False)
        assert c is None  # without fuzzy, the typo has no exact match


# ---------------------------------------------------------------------------
# Universal noise dominates verticals
# ---------------------------------------------------------------------------


class TestNoiseDominatesVertical:

    def test_noise_blocks_even_if_phrase_also_in_vertical(self):
        """Universal noise check runs FIRST. Even if a term appeared in
        a vertical lexicon (it shouldn't), the noise classification
        would win. Currently we use this to keep eligibility/credential
        statements out of skill buckets regardless of how the JD phrased
        them."""
        # `work rights` is in noise (eligibility) and nowhere in any
        # vertical's skill lists — so it must always come back as noise.
        for v in ("nursing", "cleaning", "tech"):
            c = classify("work rights", v)  # type: ignore[arg-type]
            assert c is not None and c.is_noise
            assert c.noise_type == "eligibility"


# ---------------------------------------------------------------------------
# Batch API
# ---------------------------------------------------------------------------


class TestBatch:

    def test_classify_many_preserves_input_keys(self):
        phrases = ["wound management", "BESTMed", "frobnicate"]
        out = classify_many(phrases, "nursing")
        assert set(out.keys()) == set(phrases)
        assert out["wound management"].canonical == "wound care"  # type: ignore[union-attr]
        assert out["BESTMed"].category == "technical"  # type: ignore[union-attr]
        assert out["frobnicate"] is None


# ---------------------------------------------------------------------------
# Phase 0.5 — AU-market coverage. AHPRA + visa subclasses are the highest-
# leverage additions (every clinical AU JD asks for AHPRA; every JD that
# mentions sponsorship uses visa subclass numbers literally).
# ---------------------------------------------------------------------------


class TestAuCredentialCoverage:

    @pytest.mark.parametrize("kw", [
        "AHPRA",
        "AHPRA registered",
        "AHPRA registration",
        "NMBA",
        "nursing and midwifery board",
        "RN registration",
        "BLS",
        "basic life support",
        "manual handling certificate",
        "dementia training",
        "NDIS worker orientation",
        "food safety certificate",
        "WWVP",
        "work with vulnerable people",
        "annual flu shot",
    ])
    def test_au_credential_in_noise(self, kw):
        c = classify(kw, "nursing")
        assert c is not None and c.is_noise
        assert c.noise_type == "credential"


class TestAuEligibilityCoverage:

    @pytest.mark.parametrize("kw", [
        "482 visa",
        "subclass 482",
        "186 visa",
        "189 visa",
        "417 visa",
        "WHV",
        "working holiday visa",
        "NZ citizen",
        "Special Category Visa",
        "SCV",
        "full work rights",
        "no sponsorship required",
        "does not require sponsorship",
        "australian citizen or PR",
    ])
    def test_au_eligibility_in_noise(self, kw):
        c = classify(kw, "nursing")
        assert c is not None and c.is_noise
        assert c.noise_type == "eligibility"


class TestAuFluffNoise:

    @pytest.mark.parametrize("kw", [
        "self-starter",
        "hit the ground running",
        "passionate about care",
        "culture fit",
        "competitive salary",
    ])
    def test_jd_fluff_dropped_as_noise(self, kw):
        c = classify(kw, "nursing")
        assert c is not None and c.is_noise
        assert c.noise_type == "noise"


class TestWeekdayAvailabilityNoise:
    """Regression: 'availability for weekday shifts' and friends were leaking
    into Soft Skills on AIN/aged-care JDs. Every other shift-availability
    phrasing was in the noise list; weekday variants were missed."""

    @pytest.mark.parametrize("kw", [
        "availability for weekday shifts",
        "availability for weekday afternoon and night shifts",
        "availability for multiple weekday shifts",
        "weekday shifts",
        "weekday availability",
        "afternoon and night shifts",
    ])
    def test_weekday_availability_is_noise(self, kw):
        c = classify(kw, "nursing")
        assert c is not None and c.is_noise
        assert c.noise_type == "noise"


class TestYearPrefixedCredentials:
    """Regression: AI sometimes emits a year prefix on vaccination/cert
    phrases (e.g. '2016 influenza vaccination'). The leading 4-digit year
    is now stripped by normalise() so the existing credential-noise entries
    catch these."""

    @pytest.mark.parametrize("kw,expected_noise_type", [
        ("2016 influenza vaccination", "credential"),
        ("2018 cpr certificate",       "credential"),
        ("2024 first aid",             "credential"),
        ("2020 police check",          "credential"),
    ])
    def test_year_prefixed_credential_is_noise(self, kw, expected_noise_type):
        c = classify(kw, "nursing")
        assert c is not None and c.is_noise
        assert c.noise_type == expected_noise_type

    def test_year_inside_phrase_is_preserved(self):
        # ISO 27001 / section 8 / similar — internal numerics MUST survive
        from app.services.skills.classifier import normalise
        assert normalise("iso 27001") == "iso 27001"
        assert normalise("section 8 compliance") == "section 8 compliance"
        # Edge: bare year shouldn't be stripped if there's nothing after it
        assert normalise("2016") == "2016"


class TestNursingClinicalExpansion:

    @pytest.mark.parametrize("phrase,canonical", [
        ("trachy care", "tracheostomy care"),
        ("bowel management", "bowel care"),
        ("epilepsy management", "seizure management"),
        ("oxygen administration", "oxygen therapy"),
        ("o2 therapy", "oxygen therapy"),
        ("CPAP", "respiratory support"),
        ("BiPAP", "respiratory support"),
        ("thickened fluids", "dysphagia management"),
        ("subcut injection", "subcutaneous medication"),
        ("early warning score", "deteriorating patient recognition"),
        ("chemical restraint", "restraint minimisation"),
        # midwife
        ("CTG", "fetal monitoring"),
        ("postpartum care", "postnatal care"),
        ("active labour", "labour and birth"),
    ])
    def test_clinical_resolves_to_canonical(self, phrase, canonical):
        c = classify(phrase, "nursing")
        assert c is not None and c.is_skill, f"{phrase!r} did not resolve"
        assert c.canonical == canonical
        assert c.category == "domain_knowledge"


class TestAuAgedCareSoftware:

    @pytest.mark.parametrize("phrase,canonical", [
        ("eCase", "eCase"),
        ("ecase", "eCase"),
        ("e-case", "eCase"),
        ("SupportAbility", "SupportAbility"),
        ("Sandstone", "Sandstone"),
        ("VCare", "VCare"),
        ("HealthMetrics", "HealthMetrics"),
        ("Nexus", "Nexus"),
        ("PeoplePoint", "PeoplePoint"),
    ])
    def test_au_care_software_in_technical(self, phrase, canonical):
        c = classify(phrase, "nursing")
        assert c is not None and c.is_skill
        assert c.canonical == canonical
        assert c.category == "technical"


class TestTechModernStack:

    @pytest.mark.parametrize("phrase,canonical,category", [
        ("Bun", "Bun", "technical"),
        ("Deno", "Deno", "technical"),
        ("astro", "Astro", "technical"),
        ("SolidJS", "SolidJS", "technical"),
        ("vLLM", "vLLM", "technical"),
        ("Ollama", "Ollama", "technical"),
        ("llama index", "LlamaIndex", "technical"),
        ("DVC", "DVC", "technical"),
        ("wandb", "Weights & Biases", "technical"),
        ("zero trust architecture", "zero trust", "domain_knowledge"),
        ("SRE", "site reliability engineering", "domain_knowledge"),
        ("feature toggles", "feature flags", "domain_knowledge"),
        ("observability", "observability", "domain_knowledge"),
    ])
    def test_modern_tech_stack_resolves(self, phrase, canonical, category):
        c = classify(phrase, "tech")
        assert c is not None and c.is_skill
        assert c.canonical == canonical
        assert c.category == category


class TestCleaningAuExpansion:

    @pytest.mark.parametrize("phrase,canonical", [
        ("oven degreasing", "oven cleaning"),
        ("venetian blind cleaning", "blind cleaning"),
        ("sofa cleaning", "upholstery cleaning"),
        ("chewing gum removal", "gum removal"),
        ("tag removal", "graffiti removal"),
        ("high-touch cleaning", "touchpoint cleaning"),
        ("acm cleaning", "asbestos aware cleaning"),
        ("kindergarten cleaning", "childcare centre cleaning"),
        ("change room cleaning", "gym cleaning"),
        ("tab cleaning", "pub cleaning"),
        ("Tennant", "Tennant"),
        ("nilfisk vacuum", "Nilfisk"),
        ("imop", "i-mop"),
    ])
    def test_cleaning_expansion_resolves(self, phrase, canonical):
        c = classify(phrase, "cleaning")
        assert c is not None and c.is_skill
        assert c.canonical == canonical


class TestTeamPlayerNotNoise:
    """Sanity check: team player MUST remain a soft skill (not added to
    noise), since the user explicitly flagged this conflict."""

    def test_team_player_resolves_to_teamwork(self):
        c = classify("team player", "nursing")
        assert c is not None and c.is_skill
        assert c.category == "soft_skills"
        assert c.canonical == "teamwork"


class TestFixDRegressions:
    """Fix D — two environment/eligibility phrases that leaked through in
    the Nepean and Hardi runs (2026-06-05)."""

    @pytest.mark.parametrize("phrase", [
        "acute hospital environment",
        "acute hospital setting",
        "acute care environment",
        "acute care setting",
        "acute clinical environment",
    ])
    def test_acute_environment_is_noise(self, phrase):
        c = classify(phrase, "nursing")
        assert c is not None and c.is_noise
        assert c.noise_type == "noise"

    @pytest.mark.parametrize("phrase", [
        "australian aged care work rights and compliance",
        "aged care work rights and compliance",
        "work rights and compliance",
    ])
    def test_aged_care_work_rights_compliance_is_eligibility(self, phrase):
        c = classify(phrase, "nursing")
        assert c is not None and c.is_noise
        assert c.noise_type == "eligibility"

    @pytest.mark.parametrize("phrase", [
        "permanent residency or citizenship",
        "citizenship or permanent residency",
        "australian full working rights",
        "full working rights",
    ])
    def test_residency_and_working_rights_variants_are_eligibility(self, phrase):
        """Exact-match variants that were below the fuzzy threshold (0.88)
        and leaked into JD skill buckets in the Hardi run (2026-06-05)."""
        c = classify(phrase, "nursing")
        assert c is not None and c.is_noise
        assert c.noise_type == "eligibility"


# ---------------------------------------------------------------------------
# Cross-vertical noise fixes (v223, 2026-06-06)
# Passion phrases, filler attitudes, credential variants that were missing
# from _universal_noise.json and would survive reroute_skills_by_lexicon
# unchanged (because None → stay on src line).
# ---------------------------------------------------------------------------


class TestCrossVerticalNoiseFixes:

    @pytest.mark.parametrize("phrase", [
        "passion for technology",
        "passion for tech",
        "passion for coding",
        "passion for software development",
        "passion for data",
        "passion for innovation",
        "passion for cleaning",
    ])
    def test_passion_phrases_are_noise(self, phrase):
        c = classify(phrase, "tech")
        assert c is not None and c.is_noise
        assert c.noise_type == "noise"

    @pytest.mark.parametrize("phrase", [
        "fast learner",
        "quick learner",
        "eager to learn",
        "love of learning",
    ])
    def test_learner_filler_is_noise(self, phrase):
        for v in ("tech", "cleaning"):
            c = classify(phrase, v)  # type: ignore[arg-type]
            assert c is not None and c.is_noise, f"{phrase!r} should be noise for {v}"

    @pytest.mark.parametrize("phrase", [
        "results-driven",
        "results driven",
        "hardworking",
        "hard working",
        "strong work ethic",
        "self-motivated",
        "self motivated",
        "motivated individual",
        "works well under pressure",
        "presentable appearance",
    ])
    def test_filler_attitude_phrases_are_noise(self, phrase):
        c = classify(phrase, "tech")
        assert c is not None and c.is_noise
        assert c.noise_type == "noise"

    @pytest.mark.parametrize("phrase,noise_type", [
        ("own transport", "credential"),
        ("own vehicle", "credential"),
        ("full drivers licence", "credential"),
        ("drivers license", "credential"),  # US spelling
        ("must have own car", "credential"),
        ("australian permanent resident", "eligibility"),
        ("police clearance required", "noise"),
        ("ability to obtain police clearance", "noise"),
        ("ability to pass background check", "noise"),
    ])
    def test_new_credential_eligibility_noise_entries(self, phrase, noise_type):
        c = classify(phrase, "cleaning")
        assert c is not None and c.is_noise, f"{phrase!r} should be noise"
        assert c.noise_type == noise_type, f"{phrase!r}: expected {noise_type}, got {c.noise_type}"


# ---------------------------------------------------------------------------
# Tech domain_knowledge coverage (v223, 2026-06-06)
# High-frequency tech CV phrases that returned None and would stay on
# their current Skills line without rerouting.
# ---------------------------------------------------------------------------


class TestTechDomainKnowledgeCoverage:

    @pytest.mark.parametrize("phrase,canonical", [
        ("object-oriented programming", "object-oriented programming"),
        ("oop", "object-oriented programming"),
        ("functional programming", "functional programming"),
        ("full stack development", "full-stack development"),
        ("fullstack", "full-stack development"),
        ("full-stack", "full-stack development"),
        ("backend development", "backend development"),
        ("back-end development", "backend development"),
        ("frontend development", "frontend development"),
        ("front-end development", "frontend development"),
        ("test automation", "test automation"),
        ("automated testing", "test automation"),
        ("unit testing", "unit testing"),
        ("unit tests", "unit testing"),
        ("integration testing", "integration testing"),
        ("api testing", "integration testing"),
        ("version control", "version control"),
        ("source control", "version control"),
        ("cybersecurity", "cybersecurity"),
        ("cyber security", "cybersecurity"),
        ("information security", "cybersecurity"),
        ("data analysis", "data analysis"),
        ("data analytics", "data analysis"),
        ("data science", "data science"),
        ("business intelligence", "business intelligence"),
        ("bi", "business intelligence"),
        ("api development", "API development"),
        ("api integration", "API development"),
        ("cloud computing", "cloud computing"),
        ("cloud platforms", "cloud computing"),
        ("rpa", "robotic process automation"),
        ("robotic process automation", "robotic process automation"),
        ("process automation", "robotic process automation"),
        ("software engineering", "software engineering"),
        ("software development", "software engineering"),
        ("penetration testing", "penetration testing"),
        ("ethical hacking", "penetration testing"),
        ("pen testing", "penetration testing"),
    ])
    def test_tech_domain_knowledge_resolves(self, phrase, canonical):
        c = classify(phrase, "tech")
        assert c is not None, f"{phrase!r} returned None — should resolve in tech lexicon"
        assert c.is_skill
        assert c.canonical == canonical, f"{phrase!r}: expected {canonical!r}, got {c.canonical!r}"
        assert c.category == "domain_knowledge"
