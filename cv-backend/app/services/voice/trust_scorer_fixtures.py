"""
Hand-written fixtures for trust_scorer.py.

Serves as living documentation of intended scorer behaviour and a
manual smoke-test path. No test framework required — run score() against
each fixture's `text` and verify the result falls within the stated ranges.

The auditor (Task 4) must run each fixture through score() and confirm:
  1. overall_score is within [expected_overall_min, expected_overall_max]
  2. length_appropriateness_score matches expected_length_score exactly
  3. len(matched_ai_phrases) == expected_matched_count

To manually smoke-test from the cv-backend directory:
    python -c "
    from app.services.voice.trust_scorer import score
    from app.services.voice.trust_scorer_fixtures import FIXTURES
    for f in FIXTURES:
        r = score(f['text'])
        ok_overall = f['expected_overall_min'] <= r.overall_score <= f['expected_overall_max']
        ok_len = r.length_appropriateness_score == f['expected_length_score']
        ok_count = len(r.matched_ai_phrases) == f['expected_matched_count']
        status = 'PASS' if (ok_overall and ok_len and ok_count) else 'FAIL'
        print(f\"{status} [{f['name']}] overall={r.overall_score:.3f} \
(expected {f['expected_overall_min']:.2f}–{f['expected_overall_max']:.2f}), \
length_score={r.length_appropriateness_score}, matched={r.matched_ai_phrases}\")
    "
"""

# ---------------------------------------------------------------------------
# Fixture 1 — OBVIOUS_HUMAN
# Natural, bursty writing. No AI tells. Word count in ideal range (150–300).
#
# Expected:
#   ai_pattern_score         ≈ 1.0  (zero AI tells)
#   sentence_variance_score  ≈ 0.60–0.75  (wide spread: "No fans." vs 24-word sentence)
#   length_appropriateness   = 1.0  (163 words — inside 150–300)
#   overall                  ≥ 0.75
# ---------------------------------------------------------------------------
OBVIOUS_HUMAN = {
    "name": "OBVIOUS_HUMAN",
    "text": (
        "The server room was never quiet, but that night it was wrong-quiet. "
        "No fans. I noticed it before I smelled the smoke — a particular absence, "
        "like when tinnitus stops and you realise you had it. Walked in at 2am to "
        "find two rack units dark and a third blinking orange.\n\n"
        "I had no idea what I was doing. Six weeks on the job, nobody else on call, "
        "and a rack half-dead. So I did the only sensible thing: took photos of "
        "everything before touching anything.\n\n"
        "That turned out to matter. Later, when the vendor blamed our power setup, "
        "I had timestamped photos showing their unit was dark before ours failed. "
        "They replaced it at no charge.\n\n"
        "Thing is, I didn't know why I was taking photos. I just didn't want to "
        "forget what I was looking at. Turned out to be the most useful instinct "
        "of the whole incident."
    ),
    "expected_overall_min": 0.75,
    "expected_overall_max": 1.00,
    "expected_length_score": 1.0,
    "expected_matched_count": 0,
    "notes": (
        "Pure human writing. Short punchy sentences ('No fans.', 'They replaced it "
        "at no charge.') alongside long narrative sentences create high variance. "
        "Zero AI tells. Should score well above the 0.5 amber threshold."
    ),
}

# ---------------------------------------------------------------------------
# Fixture 2 — OBVIOUS_AI
# Dense AI-tell saturation. Uniform sentence length. Word count in 100–500 band.
#
# Expected:
#   ai_pattern_score         = 0.0  (≥5 unique AI tells → floor)
#   sentence_variance_score  ≈ 0.08–0.20  (uniform 12–18 word sentences)
#   length_appropriateness   = 0.7  (~136 words — in 100–500 intermediate band)
#   overall                  ≤ 0.25
# ---------------------------------------------------------------------------
OBVIOUS_AI = {
    "name": "OBVIOUS_AI",
    "text": (
        "I am writing to express my enthusiastic interest in this position. "
        "Furthermore, my proven track record of delivering results in fast-paced "
        "environments demonstrates my ability to leverage cross-functional synergies "
        "effectively. I am passionate about innovation and driving impactful solutions. "
        "Moreover, my results-driven approach has consistently exceeded expectations "
        "throughout my career. Additionally, I would like to express my commitment to "
        "excellence in all that I undertake. It is worth noting that I have led multiple "
        "high-performing teams across diverse industry verticals. In conclusion, I am "
        "confident that my extensive skills and experience make me the ideal candidate "
        "for this opportunity. My background encompasses comprehensive experience in "
        "stakeholder management, process optimisation, and strategic planning. I am "
        "excited to bring my expertise to your esteemed organisation. I look forward "
        "to discussing how my qualifications comprehensively align with your requirements."
    ),
    "expected_overall_min": 0.00,
    "expected_overall_max": 0.25,
    "expected_length_score": 0.7,
    "expected_matched_count": 15,  # 15 distinct _AI_TELLS phrases fire
    "notes": (
        "Maximum AI-tell saturation (15 distinct phrases): 'i am writing to', "
        "'furthermore', 'track record', 'fast-paced', 'leverage', "
        "'i am passionate about', 'moreover', 'results-driven', 'additionally', "
        "'i would like to express', 'it is worth noting', 'in conclusion', "
        "'i am confident that', 'i am excited to', 'i look forward to'. "
        "Note: 'synergies' does NOT match the '_AI_TELLS' entry 'synergy' (substring "
        "mismatch — 'y' vs 'i'). ai_pattern_score floors at 0.0 (5+ unique hits). "
        "Sentence lengths are 12–18 words throughout — low variance. "
        "Text is ~136 words (100–500 intermediate band) → length_score=0.7, not 1.0. "
        "The low ai_pattern_score still dominates: overall ≤ 0.25 even with 0.7 length."
    ),
}

# ---------------------------------------------------------------------------
# Fixture 3 — BORDERLINE
# Two AI tells. Low sentence variance (uniform-ish sentences). In-range length.
#
# Expected:
#   ai_pattern_score         = 0.60  (2 tells × 0.2 penalty = 1.0 − 0.4)
#   sentence_variance_score  ≈ 0.10–0.22  (sentences all roughly 10–17 words)
#   length_appropriateness   = 1.0  (~185 words)
#   overall                  ≈ 0.45–0.60  (amber warning zone)
# ---------------------------------------------------------------------------
BORDERLINE = {
    "name": "BORDERLINE",
    "text": (
        "I moved into project management after three years as a developer. "
        "The transition was challenging but ultimately rewarding. "
        "I learned to communicate technical concepts to non-technical stakeholders. "
        "Furthermore, the skills I had developed as a developer gave me a solid "
        "foundation for the move. I managed projects ranging from small internal "
        "tools to large enterprise migrations. The teams I worked with included "
        "people from different countries and time zones. I found that regular "
        "check-ins helped keep everyone aligned on goals. Communication was always "
        "my primary focus during these projects. I look forward to bringing this "
        "experience to new challenges. The most important skill I developed was "
        "the ability to translate between technical and business language. Written "
        "communication became as important as verbal communication in my work. "
        "I also learned to manage competing priorities across multiple stakeholders "
        "simultaneously. Each project taught me something new about leadership and "
        "team dynamics. This experience has fundamentally shaped how I approach "
        "managing complex technical initiatives."
    ),
    "expected_overall_min": 0.45,
    "expected_overall_max": 0.60,
    "expected_length_score": 1.0,
    "expected_matched_count": 2,  # "furthermore", "i look forward to"
    "notes": (
        "Two AI tells drag ai_pattern_score to 0.6. Sentences are consistently "
        "10–17 words — no short punchy lines, no very long ones — so variance is low. "
        "Should score in the amber warning band (0.45–0.60). Demonstrates that even "
        "a lightly AI-influenced passage reads as borderline."
    ),
}

# ---------------------------------------------------------------------------
# Fixture 4 — TOO_SHORT
# Genuine human writing but only ~47 words. Tests the length penalty.
#
# Expected:
#   ai_pattern_score         = 1.0  (no AI tells)
#   sentence_variance_score  ≈ 0.25–0.40  (few sentences, some length variation)
#   length_appropriateness   = 0.3  (< 100 words → extreme penalty)
#   overall                  ≈ 0.55–0.70
#
# Key assertion: length_appropriateness_score == 0.3
# The overall is decent despite length because the writing is genuinely human.
# ---------------------------------------------------------------------------
TOO_SHORT = {
    "name": "TOO_SHORT",
    "text": (
        "I built a scraper for job listings as a side project. "
        "It ran on a Raspberry Pi in my bedroom for two years. "
        "Nobody asked for it. I just wanted to see what was out there. "
        "Ended up learning more about HTTP than any course ever taught me."
    ),
    "expected_overall_min": 0.55,
    "expected_overall_max": 0.70,
    "expected_length_score": 0.3,
    "expected_matched_count": 0,
    "notes": (
        "Genuine human writing, zero AI tells, good burstiness — but only ~47 words. "
        "length_appropriateness_score must be exactly 0.3 (< 100 word floor). "
        "The overall stays reasonably high because the other components are strong, "
        "but it is materially lower than an equivalent in-range sample would be. "
        "UI should indicate: 'Sample too short — add more detail for better results.'"
    ),
}

# ---------------------------------------------------------------------------
# Fixture 5 — TOO_LONG
# Genuine human writing, ~340 words. Tests the 301–500 word intermediate penalty.
#
# Expected:
#   ai_pattern_score         = 1.0  (no AI tells)
#   sentence_variance_score  ≈ 0.35–0.55  (varied narrative sentences)
#   length_appropriateness   = 0.7  (301–500 words → intermediate penalty)
#   overall                  ≈ 0.65–0.80
#
# Key assertion: length_appropriateness_score == 0.7 (not 1.0)
# ---------------------------------------------------------------------------
TOO_LONG = {
    "name": "TOO_LONG",
    "text": (
        "Three years into my first engineering job I realised I had built something "
        "I didn't understand. Not in a dramatic way — the system worked, the metrics "
        "looked fine, and my manager seemed happy. But I couldn't explain why it "
        "worked. I had inherited a codebase from someone who left before I arrived, "
        "patched it enough to stop the bleeding, and called that success.\n\n"
        "The moment it became clear was during an incident review. We had a slow "
        "memory leak that showed up every seventy-two hours, like clockwork. I had "
        "been restarting the service on a cron job to mask it. Someone asked in the "
        "review why we hadn't fixed the underlying issue. I said we had. That wasn't "
        "true.\n\n"
        "I spent the next three weeks actually reading the code. Not skimming it, "
        "not using grep to find the specific function I needed — reading it. Tracing "
        "data through the system from ingestion to output, writing down what I didn't "
        "understand and looking it up. It took about a hundred hours of focused reading "
        "to get to the point where I could reason about the system without guessing.\n\n"
        "What I found was not a memory leak in the traditional sense. It was a cascading "
        "reference problem in a part of the codebase that nobody had touched in four "
        "years. Fixing it took about fifteen lines of code. Understanding it enough to "
        "write those fifteen lines took the three weeks.\n\n"
        "That experience changed how I approach inherited systems. I don't patch first "
        "anymore. I read first, even when the patch is obvious and the reading is slow. "
        "The cost of a week of reading is almost always lower than the cost of six "
        "months of patches that accumulate around something nobody understands.\n\n"
        "The other thing it taught me is that admitting you don't understand something "
        "is not a weakness in engineering. It's the starting point for doing good work. "
        "The engineers I've respected most since then are the ones who say 'I don't know' "
        "quickly and mean it."
    ),
    "expected_overall_min": 0.65,
    "expected_overall_max": 0.82,
    "expected_length_score": 0.7,
    "expected_matched_count": 0,
    "notes": (
        "Excellent human writing (~340 words) but exceeds the 300-word ideal ceiling. "
        "length_appropriateness_score must be exactly 0.7 (301–500 word band). "
        "The text has strong burstiness (short sentences like 'I said we had. That "
        "wasn't true.' alongside long narrative ones) so variance_score is high. "
        "Overall is good but the length penalty is visible: compare to OBVIOUS_HUMAN "
        "which would score ~0.85–0.90 on the same text cut to 175 words."
    ),
}

# ---------------------------------------------------------------------------
# Fixture 6 — THRESHOLD_BOUNDARY
# Three AI tells, uniform sentence lengths, in-range word count.
# Calibrated to land near the 0.50 amber warning boundary.
#
# Expected:
#   ai_pattern_score         = 0.40  (3 tells × 0.2 = 1.0 − 0.6)
#   sentence_variance_score  ≈ 0.18–0.28  (sentences 10–21 words, moderate uniformity)
#   length_appropriateness   = 1.0  (~160 words)
#   overall                  ≈ 0.43–0.53  (straddles the 0.5 amber threshold)
#
# Key assertion: overall is very close to 0.5. Small changes to the text
# (adding/removing an AI tell, or adding a very short sentence) will push it
# above or below. This fixture documents the boundary behaviour.
# ---------------------------------------------------------------------------
THRESHOLD_BOUNDARY = {
    "name": "THRESHOLD_BOUNDARY",
    "text": (
        "I made the move from analytics to data engineering about three years ago. "
        "The decision took longer than it should have, mainly because I underestimated "
        "how much I still had to learn. My SQL skills were strong, but infrastructure "
        "thinking was genuinely new territory for me. Furthermore, the team I joined "
        "was patient and willing to pair on things I didn't fully understand yet. "
        "I spent the first two months mostly reading documentation and fixing small bugs. "
        "It is worth noting that the ramp-up in this kind of role is slower than most "
        "people expect coming from analytics. You have to rebuild your intuition from "
        "the ground up. The things that felt easy before suddenly feel uncertain again. "
        "Moreover, I found that the transition made me a significantly better engineer "
        "overall. The two disciplines reinforce each other in ways that aren't obvious "
        "until you've done both. I would recommend the move to anyone with patience "
        "for the learning curve."
    ),
    "expected_overall_min": 0.43,
    "expected_overall_max": 0.53,
    "expected_length_score": 1.0,
    "expected_matched_count": 3,  # "furthermore", "it is worth noting", "moreover"
    "notes": (
        "Three AI tells push ai_pattern_score to 0.4. Sentence lengths range 10–21 "
        "words without any very short punchy lines, keeping variance low (~0.22). "
        "Together these drag the overall to ~0.47, just below the 0.5 amber threshold. "
        "This fixture proves the amber warning fires at the right level: real human "
        "content but AI-tell contamination is enough to trigger it. "
        "Adding a fourth AI tell would push overall below 0.43. Removing all tells "
        "and adding one short sentence would push overall above 0.6."
    ),
}

# ---------------------------------------------------------------------------
# Canonical list — used by the smoke-test runner in the module docstring
# ---------------------------------------------------------------------------
FIXTURES: list[dict] = [
    OBVIOUS_HUMAN,
    OBVIOUS_AI,
    BORDERLINE,
    TOO_SHORT,
    TOO_LONG,
    THRESHOLD_BOUNDARY,
]
