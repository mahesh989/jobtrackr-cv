"""Phase 3 — subsumption dedup tests.

When the LLM extracts a generic parent canonical (e.g. ``communication``)
alongside ≥1 specific child it already implies (e.g. ``verbal communication``
+ ``written communication``), the parent is pure redundancy. The
``_dedupe_by_subsumption`` pass drops the parent in that case, but only
within the SAME bucket and the SAME side (required vs preferred). The
lexicon declares the relationship via the optional ``subsumes`` field on
each canonical entry.

These tests exercise the rule shape, not the specific lexicon content —
nursing's ``communication ⊃ {verbal communication, written communication}``
is the canonical example and is used as the fixture.
"""
from __future__ import annotations

from app.services.skills.classifier import _SUBSUMES
from app.services.skills.post_process import (
    _dedupe_by_subsumption,
    post_process_jd_analysis,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _jd(required=None, preferred=None):
    """Build a minimal JD-analysis dict — only the buckets that matter."""
    def _b(d):
        d = d or {}
        return {
            "technical": list(d.get("technical") or []),
            "soft_skills": list(d.get("soft_skills") or []),
            "domain_knowledge": list(d.get("domain_knowledge") or []),
        }
    return {
        "job_title": "test",
        "required_skills": _b(required),
        "preferred_skills": _b(preferred),
    }


# ---------------------------------------------------------------------------
# Lexicon-loading guard — fails loudly if the JSON's `subsumes` fields drift.
# ---------------------------------------------------------------------------

class TestSubsumesLexiconShape:
    def test_nursing_communication_parent_present(self):
        nursing = _SUBSUMES.get("nursing") or {}
        assert "communication" in nursing
        assert "verbal communication" in nursing["communication"]
        assert "written communication" in nursing["communication"]

    def test_nursing_personal_care_parent_present(self):
        nursing = _SUBSUMES.get("nursing") or {}
        assert "personal care" in nursing
        # Sanity — at least the textbook three
        for child in ("showering and bathing", "dressing and grooming",
                       "toileting assistance"):
            assert child in nursing["personal care"], child

    def test_tech_cloud_computing_subsumes_concrete_providers(self):
        tech = _SUBSUMES.get("tech") or {}
        assert "cloud computing" in tech
        # canonicals are stored lowercased — match the JSON spec exactly
        for child in ("aws", "azure", "google cloud"):
            assert child in tech["cloud computing"]

    def test_cleaning_floor_care_subsumes_actions(self):
        cleaning = _SUBSUMES.get("cleaning") or {}
        assert "floor care" in cleaning
        for child in ("vacuuming", "mopping", "sweeping", "scrubbing"):
            assert child in cleaning["floor care"]


# ---------------------------------------------------------------------------
# Core rule shape — parent + ≥1 child in same bucket drops parent.
# ---------------------------------------------------------------------------

class TestSubsumptionRule:
    def test_parent_and_child_same_bucket_drops_parent(self):
        jd = _jd(required={
            "soft_skills": ["communication", "verbal communication"],
        })
        out, removed = _dedupe_by_subsumption(jd, "nursing")
        soft = out["required_skills"]["soft_skills"]
        assert "communication" not in [s.lower() for s in soft]
        assert "verbal communication" in [s.lower() for s in soft]
        assert any(
            r["parent"].lower() == "communication"
            and "verbal communication" in r["children_present"]
            for r in removed
        )

    def test_parent_alone_is_kept(self):
        """A generic parent survives when no specific is there — that's the
        only signal available. Don't drop the only thing in the bucket."""
        jd = _jd(required={"soft_skills": ["communication"]})
        out, removed = _dedupe_by_subsumption(jd, "nursing")
        assert "communication" in [
            s.lower() for s in out["required_skills"]["soft_skills"]
        ]
        assert removed == []

    def test_cross_bucket_does_not_drop(self):
        """Parent in required + child in preferred is a DIFFERENT urgency
        statement, not a redundancy. Do not collapse."""
        jd = _jd(
            required={"soft_skills": ["communication"]},
            preferred={"soft_skills": ["verbal communication"]},
        )
        out, removed = _dedupe_by_subsumption(jd, "nursing")
        assert "communication" in [
            s.lower() for s in out["required_skills"]["soft_skills"]
        ]
        assert "verbal communication" in [
            s.lower() for s in out["preferred_skills"]["soft_skills"]
        ]
        assert removed == []

    def test_multiple_children_still_drops_parent_once(self):
        jd = _jd(required={
            "soft_skills": [
                "communication", "verbal communication", "written communication",
            ],
        })
        out, removed = _dedupe_by_subsumption(jd, "nursing")
        soft_lower = [s.lower() for s in out["required_skills"]["soft_skills"]]
        assert "communication" not in soft_lower
        assert "verbal communication" in soft_lower
        assert "written communication" in soft_lower
        # Parent listed exactly once in removed (no duplicate-drop bug)
        parents = [r for r in removed if r["parent"].lower() == "communication"]
        assert len(parents) == 1

    def test_unknown_parent_is_noop(self):
        """Phrase that isn't a subsumption parent — pass through unchanged."""
        jd = _jd(required={"soft_skills": ["bingo wings", "verbal communication"]})
        out, removed = _dedupe_by_subsumption(jd, "nursing")
        # Both kept
        soft_lower = [s.lower() for s in out["required_skills"]["soft_skills"]]
        assert "bingo wings" in soft_lower
        assert "verbal communication" in soft_lower
        assert removed == []

    def test_no_subsumption_when_vertical_is_none(self):
        """master / unknown family → no subsumption map → no-op."""
        jd = _jd(required={
            "soft_skills": ["communication", "verbal communication"],
        })
        out, removed = _dedupe_by_subsumption(jd, None)
        # Identity: both items survive
        soft_lower = [s.lower() for s in out["required_skills"]["soft_skills"]]
        assert "communication" in soft_lower
        assert "verbal communication" in soft_lower
        assert removed == []

    def test_no_subsumption_for_vertical_with_no_map(self):
        """A vertical whose lexicon has no subsumes anywhere — no-op
        even when phrases happen to overlap by name."""
        # cleaning has only `floor care` as a subsumption parent today, so
        # an unrelated parent name is treated as plain text.
        jd = _jd(required={"soft_skills": ["communication", "verbal communication"]})
        out, _ = _dedupe_by_subsumption(jd, "cleaning")
        soft_lower = [s.lower() for s in out["required_skills"]["soft_skills"]]
        assert "communication" in soft_lower
        assert "verbal communication" in soft_lower


# ---------------------------------------------------------------------------
# End-to-end via post_process_jd_analysis — confirms subsumed is recorded
# under lexicon_meta and the integration pipeline does the right thing.
# ---------------------------------------------------------------------------

class TestSubsumptionIntegration:
    def test_post_process_records_subsumed_under_lexicon_meta(self):
        jd = _jd(required={
            "soft_skills": ["communication", "verbal communication"],
        })
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        soft = [s.lower() for s in out["required_skills"]["soft_skills"]]
        # Generic parent removed; specific child kept.
        assert "communication" not in soft
        assert "verbal communication" in soft
        meta = out["lexicon_meta"]
        # Subsumed list non-empty and well-formed
        subsumed = meta.get("subsumed") or []
        assert subsumed, "lexicon_meta.subsumed must record drops"
        assert any(r["parent"].lower() == "communication" for r in subsumed)

    def test_post_process_personal_care_subsumes_specific_activities(self):
        """End-to-end on a nursing JD with personal-care + specifics —
        the generic parent drops in favour of the specifics."""
        jd = _jd(required={
            "domain_knowledge": [
                "personal care", "showering and bathing", "feeding assistance",
            ],
        })
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        dom = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
        assert "personal care" not in dom
        assert "showering and bathing" in dom
        assert "feeding assistance" in dom

    def test_post_process_aged_care_stripped_as_sector_label(self):
        """`aged care` is now a sector/setting label (Phase C strip-everywhere
        policy) — it must be routed to the setting_label sidecar, not kept in
        domain_knowledge, even when no child skills are present."""
        jd = _jd(required={
            "domain_knowledge": ["aged care"],
        })
        out = post_process_jd_analysis(jd, role_family_id="nursing")
        dom = [s.lower() for s in out["required_skills"]["domain_knowledge"]]
        assert "aged care" not in dom
