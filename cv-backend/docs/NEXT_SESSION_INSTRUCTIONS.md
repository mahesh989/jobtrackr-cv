# Next Session Instructions — JobTrackr CV Backend

## Read first

- `project_jobtrackr_cv_eval.md` in Claude memory — full architecture, invariants, deploy notes
- This file — specific tasks for this session

---

## Current production state

**Branch:** `main`  
**Latest commit:** `02b267e`  
**Production:** Fly.io `jobtrackr-cv-api` v222, 494 tests passing  
**Uncommitted changes:** none

---

## Commit and deploy workflow

Always follow this order:

```bash
# 1. Run tests BEFORE committing — must pass
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py
# Must show: 494 passed (or more), 0 failed

# 2. Commit (from repo root)
cd /Users/mahesh/Documents/Github/jobtrackr-cv
git add <specific files — never git add -A>
git commit -m "fix(scope): <description>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

# 3. Deploy backend
cd cv-backend
fly deploy -a jobtrackr-cv-api
# Wait for "Machine is now in a good state"

# 4. Push
cd ..
git push origin main
```

**After every deploy — tell the user:**
- New Fly version number from deploy output
- What changed
- Which jobs to re-analyse for verification

---

## What was completed this session

### Lexicon fixes (committed e30403f, deployed v212)
- `_NON_SKILL_EXACT` in writers.py: added "workplace health and safety in healthcare",
  "health and safety guidelines", "transport to appointments"
- `nursing.json`: added `"patient-centred care models"` → person-centred care,
  `"kindness"` → empathy
- `_universal_noise.json`: 20 new credential/eligibility/noise entries

### Sprint L — credential matching (pre-existing, already shipped)
- `_promote_profile_credentials()` in `cv_jd_matching.py` already implemented and tested
- 8 tests in `tests/test_sprint_l_credential_matching.py` — all pass
- `contact_details` already passed from orchestrator at line 166
- **Nothing to do here — fully shipped**

### Career Highlights quality (commits b06d21b → 02b267e, deployed v213–v222)

The problem: all tailored CV Career Highlights summaries were ~80–93% token-identical
regardless of JD type, all saying "residential aged care settings, medication assistance,
dementia care" even for home care, hospital, and NDIS roles.

**What was added to `tailored_cv.py` prompt:**
- SPECIALISATION UNIQUENESS RULE — forces S1 specialisations to come from
  `jd_analysis.summary` and `responsibilities`, not generic skill lists
- S2 PIVOT RULE — S2 must respond to `responsibilities[0]`, not default to same achievement
- SETTING ADAPTATION RULE + ROLE-TYPE AWARENESS RULE — bridge phrases and
  role-specific specialisation rules
- KEYWORD SUBSTITUTION RULE — transferable skills substitution + hard bans on
  fabricated metrics/credentials/patient counts
- MANDATORY PRE-CHECK — setting classification before writing (partially effective;
  model still defaulted to CV setting)

**What was added to `writers.py` (the deterministic layer — actually worked):**
- `_classify_jd_setting(jd_text, jd_analysis)` — Python keyword classifier returning
  one of: home_community, hospital_acute, ndis_disability, lifestyle_coordinator,
  theatre_cssd, residential
- `_build_jd_setting_block(setting)` — hard-constraint block prepended to user message
- `_strip_canned_summary_phrase(md)` — global regex strips "Currently delivering care
  at X using BESTMed and MedMobile" from Career Highlights
- `_S1_RESIDENTIAL_RE` + `_apply_setting_bridge(md, setting)` — deterministic S1
  setting replacement after verify_claims runs
- HOME before NDIS in classifier precedence
- Residual "in residential settings" cleanup after bridge replacement

**Confirmed working in production (v222):**
- Anglicare (home care): S1 = "residential aged care, delivering care in home and
  community settings" ✓
- NDIS (Sanctuary): S1 = "aged care and disability support settings" ✓
- Hospital (Nepean): S1 = "residential aged care and acute clinical settings" ✓
- Canned phrase gone from all summaries ✓
- Similarity scores: 39–61% (down from 66–93%)

**Known remaining limitations (acceptable, leave as-is):**
- Lifestyle Coordinator (Kyogle NSW Health): still says "residential aged care settings,
  providing daily living assistance" — candidate has NO activities coordination experience
  in CV, so "daily living and wellbeing" is the honest closest transferable skill.
  39% similarity, below warning threshold. Not worth fabricating activities experience.
- Australian Unity (domestic assistance): no bridge phrase (model wrote "aged care
  experience delivering..." — non-standard word order regex can't catch). Content is
  reasonable, no "residential settings" claim. 61% similarity borderline but acceptable.

**Beta page: `/dashboard/beta/summary-audit`**
- Fetches all recent tailored CVs, extracts Career Highlights
- Classifies each JD setting in TypeScript (mirrors Python classifier)
- Default view: "Problematic" — shows only non-residential JDs
- Badges: Home/Community (blue), Hospital (purple), NDIS (orange), Lifestyle (green),
  Theatre (red)
- "Re-analyse problematic" button targets only the non-residential jobs
- "Copy (paste to Claude)" exports formatted report

---

## Primary next tasks

### 1. Cross-vertical validation — tech and cleaning roles

The lexicon infrastructure (classifier, rerouter, noise filter) was built and
battle-tested on nursing. Tech and cleaning verticals were added but never
systematically validated at scale.

**What to do:**
- Open `/dashboard/beta/skills-audit` and switch to `tech` and `cleaning` filters
- Check "Other Skills" items for each vertical:
  - Tech: are there obvious noise items leaking into Other Skills?
  - Cleaning: does the cleaning vertical have enough lexicon coverage?
- Run the classifier spot-check for a few tech/cleaning phrases:
  ```python
  from app.services.skills.classifier import classify
  print(classify('azure devops', 'tech'))
  print(classify('steam cleaning', 'cleaning'))
  print(classify('customer service', 'cleaning'))
  ```
- If gaps found: add entries to `tech.json` / `cleaning.json` in
  `cv-backend/app/services/skills/lexicons/`

### 2. Phase 3A real-run validation — full 35-job eval harness

Run the full eval suite against production (w8_verified writer) and check for
regressions vs the last stable baseline.

```bash
cd /Users/mahesh/Documents/Github/jobtrackr-cv/cv-backend
# Run eval on all 35 test jobs (requires BYOK keys)
python3 -m pytest tests/ -q --ignore=tests/test_pdf_adaptive.py -k "eval"
```

**What to look for:**
- ATS score regressions (tailored score should be ≥ original for all jobs)
- Skills section: no Other Skills leakage for nursing vertical
- Career Highlights: bridge phrases applying correctly for non-residential JDs
- No fabricated credentials in any output

### 3. Update MEMORY.md session summary

After completing 1 or 2 above, update the session highlights in
`/Users/mahesh/.claude/projects/-Users-mahesh-Documents-Github-cv-new/memory/MEMORY.md`

---

## Architecture invariants (never break these)

1. **Lexicon wins over deny-list**: if phrase is in lexicon as domain_knowledge,
   remove it from `_NON_SKILL_EXACT`
2. **`reroute_skills_by_lexicon`** must be wired into all 3 writer paths
   (w8_integrated + both post-verify blocks)
3. **`_inject_approved_skills` ordering**: `enforce_skills_section` FIRST →
   inject AFTER → no enforce after inject
4. **`run_tailored_cv_w8_verified`** must pass `vertical` derived from
   `jd_analysis["role_family"]` — never `vertical=None`
5. **494 tests must pass** before every commit (`--ignore=tests/test_pdf_adaptive.py`)
6. **Career Highlights deterministic passes run order** (in `_writer_w8_verified`):
   verify_claims → many deterministic passes → `_strip_canned_summary_phrase` →
   `_apply_setting_bridge` → `enforce_summary_concreteness` → final skills passes
   **Never reorder these — each depends on the previous being complete**
7. **`_classify_jd_setting` precedence**: Theatre → Lifestyle → HOME → NDIS →
   Hospital → Residential. HOME before NDIS is intentional — home-care JDs
   incidentally mention 'disability' as client type.

---

## Key files reference

| File | Purpose |
|------|---------|
| `cv-backend/app/services/eval/writers.py` | W8 writer, all deterministic gates, JD setting classifier + bridge |
| `cv-backend/app/services/ai/prompts/tailored_cv.py` | TAILORED_CV_SYSTEM prompt + Career Highlights rules |
| `cv-backend/app/services/ai/prompts/variants/composition.py` | COMPOSITION_USER_TEMPLATE (W8 user prompt) |
| `cv-backend/app/services/skills/lexicons/nursing.json` | Nursing skill canonicals + variants |
| `cv-backend/app/services/skills/lexicons/_universal_noise.json` | Cross-vertical noise/credential/eligibility |
| `cv-backend/app/services/pipeline/steps/cv_jd_matching.py` | CV-JD matcher + credential promotion (Sprint L) |
| `web/src/app/(dashboard)/dashboard/beta/summary-audit/` | Career Highlights audit beta page |
| `web/src/app/(dashboard)/dashboard/beta/skills-audit/` | Skills Other-Skills audit beta page |
