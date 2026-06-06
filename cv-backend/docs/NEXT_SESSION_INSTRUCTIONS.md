# Next Session Instructions — JobTrackr CV Backend

## Read first

- `project_jobtrackr_cv_eval.md` in Claude memory — full architecture, invariants, deploy notes
- This file — specific tasks for this session

---

## Current production state

**Branch:** `main`  
**Latest commit:** `09bca88`  
**Production:** Fly.io `jobtrackr-cv-api`, 494 tests passing  
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
git commit -m "fix(lexicon): <description>

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

## Verification after deploy

After deploy, run the classifier check to confirm entries resolve correctly:

```bash
cd cv-backend
python3 -c "
from app.services.skills.classifier import classify, is_noise
# spot-check a few new entries
print(classify('transport to appointments', 'nursing'))
print(is_noise('health and safety guidelines'))
print(is_noise('kindness'))
"
```

Always show the user the test count and spot-check output before declaring done.

---

## Primary task: fix 3 tailored CV leaks + add missing lexicon entries

### A. Tailored CV leaks (writers.py — highest priority)

These appear in the `all_skills` of fresh tailored CVs but shouldn't be there:

| Item | Job | Where it appears | Fix |
|------|-----|-----------------|-----|
| `"Workplace Health And Safety In Healthcare"` | Queensland Gov AIN | Care Skills | Add to `_NON_SKILL_EXACT` in writers.py |
| `"Health And Safety Guidelines"` | Australian Unity Home Care | Other Skills | Add to `_NON_SKILL_EXACT` in writers.py |
| `"Transport To Appointments"` | Dovida Aged Care | Other Skills | Add to `_NON_SKILL_EXACT` in writers.py |

File: `cv-backend/app/services/eval/writers.py`  
Location: `_NON_SKILL_EXACT` set (~line 1987)  
Add these three strings to that set.

### B. nursing.json variants (2 entries)

File: `cv-backend/app/services/skills/lexicons/nursing.json`

1. `person-centred care` ← add variant `"patient-centred care models"`
2. `empathy` ← add variant `"kindness"`

### C. _universal_noise.json additions (21 entries)

File: `cv-backend/app/services/skills/lexicons/_universal_noise.json`

**Credential section** (add near other driver licence entries ~line 45):
```
"driver's license",
"current australian driver's license",
"current australian drivers license",
"valid australian open driver licence",
"valid australian open driver license",
"access to reliable car",
"comprehensive car insurance",
"ownership of a reliable comprehensively insured vehicle",
```

**Eligibility section** (add near other work rights entries):
```
"eligibility to work in australia",
```

**Noise section** (add near end of noise list):
```
"ability to use laptop or tablet",
"ability to promote independence and choice",
"availability for day shifts 8am-4pm monday tuesday and friday",
"willingness to travel between clients within local area",
"professional experience in aged care",
"professional experience in disability support",
"personal experience in aged care",
"personal experience in disability support",
"driving and transport of clients",
"health and safety guidelines",
"patient-centred care models",
"knowledge of queensland public health system",
"awareness of inclusion and diversity principles in public sector",
```

Also add the long credential phrase to credential section:
```
"assistant in nursing certificate iii acute care or equivalent student nurse status",
```

---

## Verification classifier check (paste output to user)

After making all changes, run this and show the user the results:

```bash
cd cv-backend
python3 -c "
from app.services.skills.classifier import classify, is_noise

checks = [
    # Tailored CV strips (tested via writers.py — just confirm noise logic)
    ('health and safety guidelines', None, 'noise'),
    ('patient-centred care models', None, 'noise'),
    ('driving and transport of clients', None, 'noise'),
    # Variants
    ('patient-centred care models', 'nursing', 'person-centred care'),
    ('kindness', 'nursing', 'empathy'),
    # Credentials / noise
    (\"driver's license\", None, 'noise'),
    ('eligibility to work in australia', None, 'noise'),
    ('ability to use laptop or tablet', None, 'noise'),
    ('professional experience in aged care', None, 'noise'),
]
for phrase, vert, exp in checks:
    if vert:
        c = classify(phrase, vert)
        ok = c and c.canonical == exp
        print(('OK  ' if ok else 'FAIL') + f' {phrase!r} -> {c.canonical if c else None}')
    else:
        n = is_noise(phrase)
        print(('OK  ' if n else 'FAIL') + f' {phrase!r} -> noise:{n}')
"
```

---

## After lexicon work: primary next feature — Sprint L (credential matching)

Once lexicon changes are committed and deployed, move to Sprint L.

**Goal:** Profile-stamped credentials (police check, work rights, first aid, certificate IV) currently show as "Missing Keywords" in the CV-JD matching panel. Sprint L promotes them from missed → matched.

**Design (from earlier session):**

1. In `cv-backend/app/services/pipeline/orchestrator.py`:
   - Pass `contact_details` to `run_cv_jd_matching()` (it's already fetched at orchestrator startup)

2. In `cv-backend/app/services/pipeline/steps/cv_jd_matching.py`:
   - Add `_promote_profile_credentials(matching_result, contact_details)` function
   - After the LLM matching call, scan `contact_details` for credential markers (police check, work rights, NDIS screening, first aid, cert IV) 
   - Move matching JD keywords from `missing` → `matched` when the profile confirms them

**Key files:**
- `cv-backend/app/services/pipeline/orchestrator.py` — pass contact_details
- `cv-backend/app/services/pipeline/steps/cv_jd_matching.py` — add promoter function
- `cv-backend/app/services/pipeline/steps/keyword_feasibility.py` — already uses contact_details for honest gaps, same pattern

---

## Architecture invariants (never break these)

1. **Lexicon wins over deny-list**: if phrase is in lexicon as domain_knowledge, remove it from `_NON_SKILL_EXACT`
2. **`reroute_skills_by_lexicon`** must be wired into all 3 writer paths (w8_integrated + both post-verify blocks)
3. **`_inject_approved_skills` ordering**: `enforce_skills_section` FIRST → inject AFTER → no enforce after inject
4. **`run_tailored_cv_w8_verified`** must pass `vertical` derived from `jd_analysis["role_family"]` — never `vertical=None`
5. **494 tests must pass** before every commit (run with `--ignore=tests/test_pdf_adaptive.py`)
