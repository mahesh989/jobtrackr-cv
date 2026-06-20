# Greenfield Architecture: Ontology-Based Skill Extraction

> **Status:** Design only — no code deployed.  
> **Purpose:** Migration target for the JD categorization pipeline beyond Phase 3.  
> **Audience:** Engineering team planning the V1–V5 evolution.

---

## 1. Executive Summary

The current pipeline (Phases 0-3) extracts job skills via:
1. JD text pre-filtering (`jd_cleaner.py`)
2. Lexicon-based candidate retrieval (`retrieval.py`)
3. LLM validator prompt (`_run_validator`) with evidence grounding
4. Deterministic post-processing (subsumption, section clamp, setting demotion)

This works well for the three curated verticals (nursing, tech, cleaning). Its limits are:

| Limitation | Root Cause |
|---|---|
| Paraphrase gaps (0.88 difflib cutoff misses semantic equivalents) | String similarity ≠ meaning similarity |
| Flat JSON lexicons require manual variant maintenance | No structural knowledge of skill relationships |
| "master" vertical has no retrieval candidates | Single-vertical retrieval, no cross-domain fallback |
| 987-entry noise list grows unbounded | String-match noise filter has no structural awareness |
| No feedback loop from user corrections | Pipeline is stateless between runs |

The greenfield architecture replaces the flat-JSON lexicon + difflib retrieval with an **ontology graph + vector retrieval** layer, while keeping the LLM validator prompt and the downstream post-processing chain unchanged.

---

## 2. Target Architecture Overview

```
Raw JD text
     │
     ▼
┌─────────────────────┐
│  JD Preprocessor    │  (already: jd_cleaner.py)
│  section segmenter  │  → cleaned_jd, section_map
└─────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  Candidate Retrieval Layer                          │
│                                                     │
│  ┌──────────────────────┐  ┌──────────────────────┐ │
│  │  N-gram Exact Lookup │  │  Vector Retrieval    │ │
│  │  (Phase 3, current)  │  │  (V2, greenfield)    │ │
│  └──────────────────────┘  └──────────────────────┘ │
│               │                        │             │
│               └──────────┬─────────────┘             │
│                          ▼                           │
│              Union of candidates (deduped)           │
└─────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────┐
│  LLM Validator      │  (Phase 3: JD_ANALYSIS_VALIDATOR_SYSTEM)
│  accepted / rejected│  → accepted, new_discoveries
│  / new_discoveries  │
└─────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────┐
│  Structural Filter  │  (V3, greenfield)              │
│  SpaCy dep-parse    │  remove negated / parenthetical│
└─────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────┐
│  Domain Scorer      │  (V4, greenfield)
│  section × match    │  → confidence 0-1 per skill
│  × position weight  │
└─────────────────────┘
     │
     ▼
┌─────────────────────┐
│  Post-processing    │  (existing, unchanged)
│  subsumption, clamp │
│  setting demotion   │
└─────────────────────┘
     │
     ▼
Final output (same contract as today)
     │
     ▼
┌─────────────────────┐
│  Feedback Loop      │  (V4, greenfield)
│  skill_feedback     │  → graph edge weights updated
│  table → batch job  │
└─────────────────────┘
```

---

## 3. Component Specifications

### 3.1 JD Preprocessor — Already Implemented

File: `app/services/preprocessing/jd_cleaner.py`

Segments raw JD into sections (skill, boilerplate, unknown). Strips About-Us, benefits, EEO, salary, reporting structure. Returns `(cleaned_text, section_map)`. Transparent fallback: if fewer than 1 skill section detected, returns raw text unchanged.

No changes needed at V1-V5; the preprocessor already handles the noise reduction problem.

---

### 3.2 Skill Ontology Graph

**Purpose:** Replace the flat-JSON lexicons with a typed graph of skill nodes and edges. The graph encodes relationships (subsumption, co-occurrence, conflict) that the flat list cannot express.

**Node Schema:**

```sql
CREATE TABLE skill_nodes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical     TEXT NOT NULL UNIQUE,
    aliases       TEXT[]  NOT NULL DEFAULT '{}',
    category      TEXT NOT NULL CHECK (category IN ('technical', 'soft_skills', 'domain_knowledge')),
    vertical      TEXT[] NOT NULL DEFAULT '{}',  -- ['nursing'], ['tech', 'cleaning'], etc.
    embedding     vector(384),                   -- all-MiniLM-L6-v2
    parent_id     UUID REFERENCES skill_nodes(id),
    created_at    TIMESTAMPTZ DEFAULT now(),
    updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON skill_nodes USING ivfflat (embedding vector_cosine_ops);
```

**Edge Schema:**

```sql
CREATE TABLE skill_edges (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id       UUID NOT NULL REFERENCES skill_nodes(id),
    to_id         UUID NOT NULL REFERENCES skill_nodes(id),
    edge_type     TEXT NOT NULL CHECK (edge_type IN ('IS_A', 'RELATED_TO', 'CONFLICTS_WITH')),
    weight        FLOAT NOT NULL DEFAULT 1.0,  -- co-occurrence weight, updated by feedback
    created_at    TIMESTAMPTZ DEFAULT now()
);
```

**Edge Types:**

| Type | Meaning | Example |
|---|---|---|
| `IS_A` | Subsumption — child is more specific than parent | "residential aged care" IS_A "aged care" |
| `RELATED_TO` | Co-occurrence — these skills appear together | "wound care" RELATED_TO "infection control" |
| `CONFLICTS_WITH` | Mutual exclusion — assigning both is wrong | "python" CONFLICTS_WITH "java" (same-tech alternatives) |

**Initialization:** One-time migration from the three flat JSON lexicons. Each `canonical` in `nursing.json`, `tech.json`, `cleaning.json` becomes a node. Existing `subsumes` edges become `IS_A` edges.

---

### 3.3 N-gram Candidate Retriever — Already Implemented (Phase 3)

File: `app/services/skills/retrieval.py`

Splits cleaned JD into overlapping 1-5 word n-grams; performs exact/normalised dictionary lookup against `_VERTICAL_LOOKUPS` (loaded from JSON at import). Returns up to 40 candidates.

**Limitation:** Misses semantic paraphrases (e.g., "client-facing communication" is not in the lexicon but is semantically equivalent to "stakeholder management"). The vector retrieval layer (§3.4) addresses this.

---

### 3.4 Vector Retrieval Layer

**Purpose:** Catch semantic paraphrases that n-gram exact matching misses.

**Model:** `all-MiniLM-L6-v2` (Sentence-BERT, 384-dim)
- Runs on CPU; ~22ms per sentence encode
- ~80MB model weight; can be bundled as a package dependency
- Available via `sentence-transformers` or `fastembed` (lighter alternative)

**Algorithm:**

```python
def vector_retrieve(jd_text: str, vertical: str, *, top_k_per_sentence: int = 10) -> List[Dict]:
    sentences = sentencizer(jd_text)          # SpaCy sentencizer
    candidates = {}
    for sent in sentences:
        emb = model.encode(sent)              # 384-dim float32
        hits = pgvector_cosine_search(        # SELECT ... ORDER BY embedding <=> $1 LIMIT k
            emb, vertical=vertical, threshold=0.75, k=top_k_per_sentence
        )
        for node in hits:
            key = node["canonical"].lower()
            if key not in candidates or candidates[key]["score"] < node["score"]:
                candidates[key] = node
    return sorted(candidates.values(), key=lambda x: -x["score"])[:top_k_per_sentence * 3]
```

**Threshold:** Cosine similarity ≥ 0.75. Below this, semantic overlap is too noisy for reliable skill extraction.

**Merged Candidates:** Union of n-gram exact hits (Phase 3) + vector hits, deduplicated by canonical, capped at 50 total. N-gram hits are preferred when both match the same canonical (higher precision).

**Infrastructure:** Requires `pgvector` extension on Supabase (available as `vector` type since Supabase 1.5). One `CREATE INDEX USING ivfflat` on `skill_nodes.embedding`.

---

### 3.5 LLM Validator Prompt — Already Implemented (Phase 3)

File: `app/services/ai/prompts/jd_analysis.py` → `JD_ANALYSIS_VALIDATOR_SYSTEM`

The validator receives the merged candidate list and returns:
```json
{
  "accepted": [{"skill", "category", "requirement_level", "evidence"}],
  "rejected": ["skill_name"],
  "new_discoveries": [{"skill", "category", "requirement_level", "evidence"}]
}
```

Plus job metadata (title, seniority, summary, responsibilities, years).

This prompt is the stable interface between retrieval and output. It does not change when retrieval improves from n-gram to vector — the same prompt handles both.

---

### 3.6 Structural Noise Filter

**Purpose:** Replace the 987-entry `_universal_noise.json` with a structural, dep-parse-based filter. Noise phrases are not noise because of their string content — they are noise because of their syntactic context in the JD (e.g., they appear as the object of a negation, or inside a parenthetical about company benefits).

**Library:** SpaCy `en_core_web_sm` (40MB; already small enough to bundle)

**Patterns to filter:**

```python
# 1. Negated context: "no experience in X", "not required to have X"
#    → find skill-candidate ngrams in objects of NEG-marked verbs → exclude

# 2. Parenthetical/aside context: "(not required)", "(a bonus)"
#    → skill in a paren clause labeled as non-essential → downgrade to preferred

# 3. Reporting structure: "reporting to the [job title]"
#    → ROOT verb is "report", object is a title noun → exclude

# 4. Company portfolio: "we support people with [X]"  
#    → subject is "we/our company", verb is "support/serve/provide", 
#       object is the service domain → mark as boilerplate, exclude
```

**Replacement path:** Filter runs BEFORE the LLM validator call on the cleaned candidates list. Candidates flagged as structurally-noisy are removed from the `accepted` list pre-emptively. `_universal_noise.json` can then be gradually reduced to credentials + eligibility only (its legitimate use case).

---

### 3.7 Domain Scorer

**Purpose:** Assign a confidence score (0-1) to each extracted skill based on where and how strongly it appears in the JD. Replaces the binary required/preferred decision with a graded signal.

**Inputs per skill:**
- `evidence_section_type`: which section the evidence quote appears in
- `match_quality`: how the candidate was retrieved (exact > normalised > fuzzy > vector)
- `position_in_jd`: word offset of evidence quote ÷ total JD length (earlier = more prominent)

**Scoring formula:**

```python
SECTION_WEIGHT = {
    "requirements": 1.0,
    "essential criteria": 1.0,
    "key responsibilities": 0.85,
    "responsibilities": 0.80,
    "about the role": 0.70,
    "summary": 0.65,
    "preferred": 0.50,
    "desirable": 0.45,
    "_preamble": 0.60,   # unheaded content
    "_unknown": 0.55,
}

MATCH_WEIGHT = {
    "exact": 1.0,
    "normalised": 0.95,
    "fuzzy": 0.85,
    "vector": 0.75,
}

POSITION_BONUS = 0.10  # bonus for appearing in first 30% of JD

def domain_score(skill) -> float:
    s = SECTION_WEIGHT.get(skill.evidence_section, 0.55)
    m = MATCH_WEIGHT.get(skill.match_kind, 0.75)
    p = POSITION_BONUS if skill.position_ratio < 0.30 else 0.0
    return min(1.0, s * m + p)
```

**Thresholds:**

| Score | Decision |
|---|---|
| ≥ 0.70 | required |
| 0.45 – 0.69 | preferred |
| < 0.45 | reject (do not include) |

**Current state:** The LLM makes the required/preferred decision directly. The domain scorer adds a post-hoc validation pass — if the LLM marks something "required" but the score is < 0.45, it is demoted or dropped. This reduces the single-LLM-call failure mode.

---

### 3.8 Feedback Loop

**Purpose:** Close the loop between what the system extracts and what the user actually needs. User edits to the skills section of their tailored CV are the highest-quality signal for extraction quality.

**Data Model:**

```sql
CREATE TABLE skill_feedback (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL,
    analysis_run_id UUID NOT NULL REFERENCES analysis_runs(id),
    skill_canonical TEXT NOT NULL,
    action          TEXT NOT NULL CHECK (action IN ('accepted', 'rejected', 'corrected')),
    corrected_to    TEXT,        -- when action = 'corrected', the user's preferred form
    jd_vertical     TEXT,
    jd_summary      TEXT,        -- first 200 chars of JD summary for context
    created_at      TIMESTAMPTZ DEFAULT now()
);
```

**Nightly batch job (`scripts/feedback_aggregator.py`):**

```python
# 1. Aggregate rejections per (skill_canonical, vertical) over last 30 days
# 2. For skills with >= 5 rejections in a vertical:
#    - Demote from required-capable → preferred-only in skill_nodes
#    - Or remove from lexicon entirely if rejection rate > 80%
# 3. For skills with >= 5 user corrections (corrected_to is populated):
#    - Add corrected_to as an alias of the canonical in skill_nodes
#    - Re-embed the updated aliases list
# 4. Update skill_edges.weight for co-occurring accepted skills
#    (weight += 0.1 per co-acceptance, decays 5% per week)
```

**Frontend hook:** When user saves the skills section after editing, diff the accepted skills against the extracted set → emit `skill_feedback` rows for additions (action=accepted) and removals (action=rejected).

---

## 4. Data Schemas

### 4.1 Validator Request

Sent by `_run_validator()` in `steps/jd_analysis.py`:

```json
{
  "candidates": [
    {"canonical": "wound care", "category": "domain_knowledge", "vertical": "nursing"},
    {"canonical": "medication administration", "category": "domain_knowledge", "vertical": "nursing"},
    ...
  ],
  "jd_text": "..."
}
```

### 4.2 Validator Response

```json
{
  "job_title": "Aged Care Worker",
  "seniority_level": "entry",
  "summary": "...",
  "responsibilities": ["..."],
  "experience_years_required": 1,
  "accepted": [
    {"skill": "wound care", "category": "domain_knowledge",
     "requirement_level": "required", "evidence": "provide wound care to all residents"}
  ],
  "rejected": ["medication administration"],
  "new_discoveries": [
    {"skill": "compassion", "category": "soft_skills",
     "requirement_level": "required", "evidence": "caring and compassionate nature essential"}
  ]
}
```

### 4.3 Pipeline Output Contract (unchanged)

All components produce the same final schema consumed by `cv_jd_matching.py`:

```json
{
  "job_title": "string",
  "seniority_level": "entry|mid|senior|lead|principal|unknown",
  "summary": "string",
  "responsibilities": ["string"],
  "experience_years_required": null,
  "required_skills":  {"technical": [], "soft_skills": [], "domain_knowledge": []},
  "preferred_skills": {"technical": [], "soft_skills": [], "domain_knowledge": []},
  "skill_evidence":   {"<skill_lower>": "<verbatim JD quote>"},
  "role_family":      "tech|nursing|manual|master",
  "category_labels":  {"category-1": "Care Skills"},
  "category_order":   ["category-1"],
  "lexicon_meta": {
    "required":  {"credential":[], "eligibility":[], "noise":[], "moved":[], "unknown":[]},
    "preferred": {"credential":[], "eligibility":[], "noise":[], "moved":[], "unknown":[]},
    "ungrounded": [],
    "subsumed": [],
    "section_clamp": [],
    "off_setting_demoted": {},
    "vertical": "nursing|tech|cleaning|null"
  }
}
```

---

## 5. Migration Path

### Current State (Post-Phase 3)

```
clean_jd_text()
  → retrieve_skill_candidates() [n-gram exact]
  → _run_validator() [LLM validates candidates]
  → _normalise_validator_output()
  → post_process chain
```

### V1 — pgvector Foundation

**Goal:** Add the graph-backed vector retrieval layer without changing any prompt or post-processing logic.

**Steps:**
1. Run Supabase migration: `CREATE EXTENSION IF NOT EXISTS vector; CREATE TABLE skill_nodes (...)`
2. Write `scripts/seed_ontology.py` — reads `nursing.json`, `tech.json`, `cleaning.json`, inserts nodes, computes embeddings with `all-MiniLM-L6-v2`, inserts rows
3. Write `app/services/skills/vector_retrieval.py` — `vector_retrieve(jd_text, vertical)` using `httpx` to call Supabase REST with `pgvector` cosine operator
4. Update `retrieval.py` to merge n-gram + vector results (union, dedup, cap 50)
5. Test: same golden JDs, same or better candidate recall

**Risk:** LOW — retrieval is upstream of the LLM; the contract to the validator prompt is unchanged.

### V2 — Replace difflib with Vector Matching

**Goal:** Retire the `allow_fuzzy=True` difflib path in `classifier.py`; use vector similarity as the fuzzy fallback.

**Steps:**
1. In `classify()`, replace the `difflib.get_close_matches()` block with a vector similarity lookup against `skill_nodes`
2. Update `VALIDATOR_MIN_CANDIDATES` threshold if vector retrieval changes candidate counts
3. Keep `allow_fuzzy` parameter for backward compatibility; set default to `False`

**Risk:** LOW — classifier is pure function; tested by 300+ existing classifier tests.

### V3 — Structural Noise Filter

**Goal:** Shrink `_universal_noise.json` from 987 entries (credentials + eligibility + noise) to ~200 entries (credentials + eligibility only); replace noise section with SpaCy dep-parse.

**Steps:**
1. Add `spacy` + `en_core_web_sm` to requirements
2. Write `app/services/preprocessing/structural_filter.py`
3. Run filter on candidate list before LLM validator call (in `_run_validator`)
4. Keep `_universal_noise.json` for credentials + eligibility (needed for `is_noise()` contract)
5. Remove noise entries one batch at a time; confirm test suite still passes

**Risk:** MEDIUM — touching noise list risks regression in existing tests. Run `pytest tests/test_skills_classifier.py tests/test_skills_hygiene.py` after each batch.

### V4 — Domain Scorer + Feedback Table

**Goal:** Add post-validator confidence scoring and user-feedback collection.

**Steps:**
1. Add `skill_feedback` table migration
2. Write `app/services/skills/domain_scorer.py`
3. Call domain scorer inside `_normalise_validator_output` after building required/preferred lists; demote below-threshold items
4. Add frontend hook: on save → POST `/internal/skill-feedback` batch
5. Write `scripts/feedback_aggregator.py` (nightly cron on Fly.io)

**Risk:** MEDIUM — domain scorer changes required/preferred split; needs A/B shadow run on a sample of JDs before full rollout.

### V5 — Unknown-Only Discovery

**Goal:** Remove the `new_discoveries` slot from the validator prompt; the LLM only validates retrieval candidates, no open-ended discovery. All skill expansion comes from graph + feedback.

**When:** After the ontology graph covers ≥ 95% of skills seen in the last 90 days of production JDs (measurable from `lexicon_meta.required.unknown` and `lexicon_meta.preferred.unknown`).

**Steps:**
1. Update `JD_ANALYSIS_VALIDATOR_SYSTEM` to remove `new_discoveries` instruction
2. Update `_normalise_validator_output` to skip the `new_discoveries` list
3. Route truly-unknown discoveries through the `skill_feedback` table instead (action=`corrected`)

---

## 6. Infrastructure Requirements

| Component | V1 | V2 | V3 | V4 | V5 |
|---|---|---|---|---|---|
| pgvector on Supabase | Required | — | — | — | — |
| `sentence-transformers` (or `fastembed`) | Required | — | — | — | — |
| SpaCy `en_core_web_sm` | — | — | Required | — | — |
| `skill_feedback` table | — | — | — | Required | — |
| Fly.io cron (nightly batch) | — | — | — | Required | — |

**No new external services are required.** All components use the existing Supabase instance (pgvector is an extension, not a separate service) and the existing Fly.io deployment.

---

## 7. Evaluation Criteria

A migration step is ready to merge when:

1. **Recall:** All skills in the four golden JD expected-skill sets are present in the output (0 regressions)
2. **Precision:** `lexicon_meta.required.unknown` count decreases (fewer hallucinations reach output)
3. **Noise reduction:** `_universal_noise.json` shrinks (V3 only)
4. **Test suite:** `pytest tests/ --ignore=tests/test_loophole_fixes.py` — all green
5. **Token cost:** Average tokens per JD analysis call does not increase by more than 15% vs baseline (validator prompt is shorter than extraction prompt)

Golden JD files (test fixtures): `tests/golden/jds/*.md`
- `nursing-residential-ain.md`
- `nursing-home-care-pcw.md`
- `tech-backend-engineer.md`
- `cleaning-commercial.md`
