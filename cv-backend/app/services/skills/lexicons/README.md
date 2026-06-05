# Skill Lexicons

Deterministic skill taxonomy that drives categorisation and CV-JD matching.
**The lexicon decides a skill's category — the LLM never does.** The same
lexicon classifies both the CV and the JD, so a given skill lands in the same
bucket on both sides (which is what makes the matching table trustworthy).

## Why this exists

Earlier the LLM categorised each skill ad-hoc (sector-blind), and a regex
deny-list tried to strip junk afterwards. That can't converge — every new JD
invents vocabulary the deny-list never saw. The lexicon flips it to an
**allow-list**: the Skills section can only contain things in the table, and the
failure mode becomes "a rare real skill is dropped + logged" (safe, self-healing)
instead of "junk leaks in" (dangerous, endless).

## Files

| File | Scope |
|------|-------|
| `_universal_noise.json` | Cross-vertical NON-skills: credentials, eligibility, framework/value/availability noise. Applies to every vertical. |
| `nursing.json` | Health / nursing vertical skill taxonomy. |
| `cleaning.json` | Cleaning / manual vertical (TODO — Phase 0 next). |
| `tech.json` | Tech vertical head terms (TODO — Phase 0 next). |

## Schema — vertical lexicon (e.g. `nursing.json`)

```json
{
  "domain_knowledge": [
    { "canonical": "wound care",
      "variants": ["wound management", "wound dressing"] }
  ],
  "soft_skills":  [ { "canonical": "...", "variants": [...] } ],
  "technical":    [ { "canonical": "...", "variants": [...] } ]
}
```

- `canonical` — the display form that lands in the CV.
- `category` — the JSON key it sits under (`technical` / `soft_skills` /
  `domain_knowledge`). Internal keys are stable; per-vertical **display labels**
  (e.g. domain → "Care Skills" for nursing) come from `role_families.py`.
- `variants` — alternate surface forms that all resolve to `canonical`. **This
  list is the synonym map** used by deterministic matching: JD "wound management"
  ↔ CV "wound care" → both resolve to `wound care` → MATCH.

## Schema — `_universal_noise.json`

Three typed lists. A phrase here is **never** a skill:

- `credential` — licence / check / cert / vaccination → routes to
  *Registration & Licences*; matched against the user **profile**, not CV text.
- `eligibility` — work-rights / residency / visa → matches profile work-rights
  flag, then dropped from skill buckets.
- `noise` — framework concept / responsibility phrasing / value / environment
  descriptor / availability → dropped entirely.

## Matching / lookup rules (Phase 1 module — not built yet)

1. Normalise the phrase (lowercase, collapse punctuation/whitespace).
2. `_universal_noise` check first → if hit, route by `type`, never a skill.
3. Vertical lexicon: exact canonical/variant → normalised → fuzzy (threshold).
4. No hit → unknown: kept for matching/reporting, dropped from the auto-built
   Skills section, and **logged** so the term can be added here.

## Adding terms

Just edit the JSON. Keep `canonical` in display form (proper case for product
names like `BESTMed`; lowercase for generic skills like `wound care` — the
renderer title-cases). Put every alternate spelling/phrasing in `variants`.
No code change needed to add a term.
