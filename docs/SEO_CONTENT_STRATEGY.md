# JobTrackr — SEO Content Strategy

> Read-only strategy doc. No page copy, no articles, no code. Grounded in
> `frontend/web/src/app/page.tsx`, `frontend/web/src/app/pricing/page.tsx`,
> `frontend/web/src/lib/billing/plans.ts`, and `docs/ARCHITECTURE_MAP.md` as
> they stood on 2026-07-08. Keyword volumes/difficulty are NOT validated here —
> take every proposed term to Keyword Planner (or equivalent) before writing.

## 0. The two facts that shape this whole doc

**1. There is no real free tier.** The landing page FAQ says "free plan you
can use indefinitely," but `plans.ts` only ships a 3-day trial (3 tailored
CVs, 3 cover letters, then read-only) before Weekly A$9.99, Monthly A$19.99,
or Unlimited A$29.99. Whoever reads your content has ~72 hours from signup to
decide the tool is worth paying for. That means content that attracts someone
"someday curious about Australia" is close to worthless — content needs to
reach people who are *already in a job search this month*, ideally this week.

**2. Aged care isn't a marketing angle you're inventing — it's already built.**
`backend/worker` has a direct aged-care-employer source (separate from
SEEK/Adzuna/Careerjet), the landing page names "aged-care employers" as one of
six featured sources, and your own memory of the healthcare ATS-gate fix
confirms there's a *dedicated* healthcare/nursing scoring path distinct from
the generic vertical. This is the rarest thing a solo-founder SEO strategy can
have: a content angle that is literally truer of your product than of any
competitor's, because the competitor has no equivalent data pipeline. Every
other segment below is judged against how close it gets to this same property
— "is there a product fact backing this claim, or is it just copy."

---

## 1. Segment prioritization

Your instinct is right, but it's one click too broad. The wedge isn't
"migrants" — it's **visa-sponsored aged care / nursing workers** as the tip of
the spear, with "skilled visa job seekers generally" as the wider ring behind
it.

| Rank | Segment | Attackability | Converts? | Verdict |
|---|---|---|---|---|
| 1 | **Aged care / nursing / personal care workers on or seeking 482 sponsorship** | Very high — near-zero content competition, and you have a live data source no competitor has | Very high — urgent, time-boxed (visa/employer deadlines), exactly matches the CV+cover-letter+ATS feature set | **Primary wedge** |
| 2 | **Skilled-visa job seekers generally (482/186/189), non-healthcare** | High — migration agents own visa-mechanics content, but nobody owns "CV + job discovery + sponsorship-signal detection" together | High — same urgency profile, slightly diluted by occupation spread | **Secondary wedge** |
| 3 | **Australia-based domestic job seekers wanting SEEK automation** (no visa angle) | Medium — SEEK-specific framing is defensible, but the *problem* ("I'm tired of refreshing SEEK") isn't uniquely Australian in a way global tools can't also claim | Medium — real pain point, but no urgency trigger comparable to a visa clock | **Supporting, not primary** |
| 4 | Already-sponsored 482 holders needing a *new* employer before visa lapses | Low volume, but folds naturally into segment 1/2 content as a long-tail angle, not a standalone pillar | Extremely high intent | Treat as a content *angle within* 1 and 2, not its own segment |
| 5 | New graduates (domestic) | Low — this is the most contested part of the CV space globally, and there's no Australia-specific edge a new grad can't get from Zety/Indeed | Low-medium — no urgency, long consideration, low willingness to pay $10-30 for a tool this week | **Deprioritize** |
| 6 | Generic "improve my CV" / resume builder seekers | Effectively zero | N/A | **Do not build for this segment** (see §6) |

Why aged care beats "migrants" as the sharpest wedge: "migrant job seeker in
Australia" is still contested by migration-agent content mills, Boundless-style
sites, and large expat forums with a decade of backlinks. "Aged care worker
needing a 482-sponsoring employer and a CV that passes an Australian ATS" has
almost none of that — the audience is narrower, but a brand-new domain can
actually rank for it inside a realistic timeframe, and the healthcare vertical
in your product means the CV guidance you'd publish is *true*, not templated
filler.

---

## 2. Defensible content angles (top 2-3 segments)

### Segment A — Aged care / nursing visa sponsorship

- **"Aged care jobs in Australia with visa sponsorship" (live data angle).**
  Global giants have no job inventory — Zety/Teal/Kickresume are CV tools with
  blog content, not job aggregators. Indeed/SEEK have volume but zero visa-signal
  curation. You have both a direct aged-care source and an AI visa-extraction
  layer (`src/ai` visa/setting classifiers) already running. Nobody else can
  publish "these specific listings mention 482 sponsorship" as a *maintained,
  refreshed* asset — it requires infrastructure, not just writing.
- **"Tailoring a nursing/aged-care CV for Australian ATS + employer norms."**
  Generic resume sites publish one generic "nursing resume" template with US
  formatting conventions. None of them know AHPRA registration conventions,
  NDIS-sector phrasing, or that your product runs a *separate, stricter* ATS
  gate for healthcare (per your own graph.json history — the 40/60 healthcare
  threshold exists because generic scoring under-served this vertical). That's
  a claim only you can make truthfully.
- **"482 vs employer-sponsored PR pathway, specifically for aged care/nursing
  roles."** Migration law firms cover the visa mechanics well but never touch
  CV/ATS/job-discovery. You're the only party positioned to bridge "which visa"
  and "how do I actually get the interview" in one place — as long as you stay
  out of formal legal advice (see §6).

### Segment B — Skilled-visa job seekers generally (482/186/189)

- **"How to actually find sponsorship-tagged jobs on SEEK"** (search operators,
  what sponsorship language looks like in a JD, common false positives like
  "visa considered" vs "visa sponsored"). This is a genuine information gap —
  SEEK itself doesn't explain this, and no CV-tool competitor operates a
  scraper that reads JD text for this signal the way yours does.
- **"Australian CV format for people applying from outside Australia"** (2-page
  norm, no photo, no age/marital status, referee conventions, credential
  translation). Generic "Australian resume format" content exists, but almost
  none of it is written *for someone whose resume currently follows their home
  country's convention* — that reframing is the differentiator, not the topic
  itself.
- **"Reading Australian job ads for sponsorship signal"** — a broadened,
  non-healthcare version of the aged-care angle above, using the same
  AI-extraction feature as the proof point.

Why global giants can't easily win segment B either: their content operations
are optimized for search volume at a global scale — "resume tips," "cover
letter examples" — and an Australia+visa niche page doesn't move the needle
for a site that size. It's not that they couldn't; it's that it's economically
irrational for them, which is exactly the gap a solo founder can occupy.

### Segment C — Australian SEEK-automation (domestic, no visa angle)

- **"SEEK job alerts vs a real automation layer"** and **"how many times is
  the same job reposted across SEEK/Adzuna/Careerjet"** — defensible because
  it's SEEK-specific (a global site's content team has no reason to write
  about an Australian job board by name), but weaker than A/B because the
  underlying pain point ("I'm tired of manually checking job boards") is not
  unique to Australia, so it competes indirectly with every "job search
  automation" article globally, not just Australian ones.

---

## 3. Content types & search intent

| Angle | Best content type | Search intent | Proximity to "would pay" |
|---|---|---|---|
| Aged care sponsored jobs (live feed) | Location/industry landing page backed by real, refreshed listings | Ready-to-act (bottom funnel) | **Highest** — this page *is* a preview of the product's core value |
| Nursing/aged-care CV + ATS guide | Long-form informational guide, soft CTA into tailoring feature | Researching → about to act (drafting an application now) | High |
| 482 vs PR pathway for aged care | Informational / light comparison | Researching (upper-mid funnel) | Medium — builds trust, not immediate conversion |
| SEEK sponsorship search guide | Informational how-to | Researching → action | High |
| Australian CV format for overseas applicants | Informational guide | Researching | Medium |
| "Is this job really sponsoring?" / reading JD signals | Informational, proprietary-insight framing | Researching → validates need for the tool | Medium-high |
| Free ATS score checker | **Interactive tool** (teaser of the real feature) | Ready-to-act / evaluating tools | **Highest** — a tool page converts visitors into product users directly, not just readers |
| SEEK-automation comparison content | Comparison / listicle | Solution-aware, comparing options | Medium |

The single highest-leverage content *type* here is the interactive tool page
(§4, item 4) — everything else is writing that earns a click; a tool page
*is* the product experience, so the conversion step disappears entirely.
Prioritize getting one built even if it's simpler than the full in-app version.

---

## 4. Prioritized build list (first 5-10 pieces)

Ranked by winnable × converts × effort — do these roughly in order, not all
at once.

1. **"Aged Care & Nursing Jobs in Australia with Visa Sponsorship"** —
   segment A, live-data landing page. Winnable: very high (no one else has
   this data). Converts: very high (it's the product itself). Effort: medium
   — mostly plumbing (surface existing worker data on a public page), not new
   research. *Validate:* "aged care jobs visa sponsorship australia", "nursing
   jobs 482 visa australia", "carer jobs sponsorship australia".

2. **"How to Tailor Your Nursing / Aged Care CV for Australian Employers (ATS
   Guide)"** — segment A, informational guide. Winnable: high. Converts: high.
   Effort: medium (needs real sector knowledge — AHPRA, NDIS phrasing — not
   generic filler). *Validate:* "nursing resume australia", "aged care resume
   format australia", "personal care worker resume ATS".

3. **"SEEK Visa Sponsorship Search Guide: Finding 482/186 Sponsored Jobs"** —
   segment B, informational + tool teaser. Winnable: high (nobody explains
   SEEK's own UI/filters this specifically). Converts: high. Effort: medium.
   *Validate:* "seek jobs visa sponsorship", "482 visa jobs seek australia".

4. **Free ATS Resume Score Checker (Australia)** — cuts across A/B, interactive
   tool. Winnable: medium-high (Jobscan et al. exist, but "Australia-specific"
   + a real scoring engine behind it is a genuine wedge, not just copy).
   Converts: very high — direct funnel into the trial. Effort: higher (needs
   a safe, rate-limited public surface of the real scorer). *Validate:* "ats
   resume checker australia free", "resume score checker australia".

5. **"482 Visa Job Search: A Practical Guide for Skilled Migrants in
   Australia"** — segment B pillar page other pieces link into. Winnable:
   medium (migration-agent content is more established here). Converts:
   medium-high. Effort: medium-high — accuracy matters, this is closer to
   legal-adjacent territory than anything else on this list (see §6 caution).
   *Validate:* "482 visa job search australia", "skilled migration jobs
   australia guide".

6. **"Australian CV Format Guide for Visa & Skilled Migration Applicants"** —
   segment B. Winnable: medium-high (the "written for someone reformatting
   from a different country's CV norms" framing is the differentiator).
   Converts: medium. Effort: low-medium. *Validate:* "australian resume
   format for immigrants", "cv format australia international applicants".

7. **"Is This Job Really Sponsoring a Visa? How to Read Australian Job Ads"**
   — segment B, proprietary-insight piece tied to the AI visa-extraction
   feature. Winnable: high (genuinely novel angle). Converts: medium-high.
   Effort: low. *Validate:* "how to tell if a job sponsors visa australia".

8. **"SEEK vs Indeed vs Adzuna: Where Sponsored Jobs Actually Get Posted in
   Australia"** — segment C, comparison. Winnable: medium. Converts: medium.
   Effort: low. *Validate:* "best job sites australia sponsorship", "seek vs
   indeed australia".

9. **"Industries Most Likely to Sponsor 482 Visas in Australia (2026)"** —
   segment B, broadens beyond aged care toward IT/engineering/trades, sets up
   future vertical pages. Winnable: medium. Converts: medium. Effort: medium
   (needs periodic refreshing to stay credible). *Validate:* "industries
   that sponsor 482 visa australia".

10. *(Bonus, lower priority)* **"What Two Hours a Day of Manually Refreshing
    SEEK Actually Costs You"** — segment C, reuses your existing landing-page
    before/after framing as standalone content. Low search volume (branded,
    thought-piece framing), so treat as a shareability/backlink piece rather
    than a core SEO bet — good for socials and forum posts, not a page you
    should expect rankings from.

---

## 5. Honest timeline and dependencies

- **Realistic horizon:** even in a deliberately narrow niche, expect near-zero
  organic traffic for the first 2-4 months (indexing + trust accumulation),
  meaningful traffic starting months 4-6 on the narrowest terms (aged care
  angle), and months 9-12+ before the broader 482/skilled-visa terms move —
  those sit adjacent to migration-agent content with real domain authority.
  There is no version of this where month-2 traffic funds month-3 growth.
- **What has to be true for this to work:**
  - *Consistent publishing*, not a burst. A new domain's trust curve rewards
    steady cadence (e.g. one solid page every 1-2 weeks) far more than 10
    pages dropped at once then silence.
  - *Real depth over thin content.* Every page above only works if it contains
    something a generic resume site genuinely could not write — sector
    specifics, live data, or a feature-backed claim. A thin 400-word version
    of any of these ranks nowhere and wastes the slot.
  - *A distribution channel besides Google in year one.* A brand-new domain
    with no backlink profile will be slow to rank no matter how good the
    content is. Plan to seed the aged-care and visa content into places that
    already have this audience — r/AusFinance / r/移民 style migration forums,
    Facebook 482-visa groups, LinkedIn posts tagged to nursing/aged-care
    recruiters — both for direct traffic now and as a natural backlink source
    later.
  - *Freshness for the live-data pages.* Item 1's advantage (a real job feed)
    decays if the page goes stale — Google and users both penalize a "live
    jobs" page that hasn't updated in weeks. This needs to be wired to the
    actual worker pipeline, not hand-maintained.
  - *A working trial-to-paid path.* Given the 3-day trial window, content
    that brings someone in with no urgency will churn before ever seeing value.
    The build list above is ordered to front-load urgent-intent segments
    precisely because of this constraint.

---

## 6. What NOT to write

Do not spend effort on any of the following — they are the most saturated
territory in the entire content marketing industry, owned by sites with years
of backlinks and dedicated content teams:

- "Resume builder" / "CV builder" (naked term)
- "Free resume templates" / "CV template download"
- "How to write a resume" / "resume writing tips" (generic, no AU/visa angle)
- "Resume examples" / "CV examples" by generic job title with no Australian or
  visa framing
- "Cover letter examples" (generic)
- "AI resume builder" (the single most crowded AI-startup category that
  exists right now — hundreds of funded competitors)
- "Best resume format 2026" / "ATS resume tips" with no Australia qualifier
- "How to find a job" / "job search tips" (fully generic, zero differentiation)
- Generic "new graduate resume/CV" content — no Australian or visa edge
  separates you from the incumbents here; this segment is explicitly
  deprioritized in §1

The rule of thumb: **if a page's title would read identically whether or not
Australia and visa/sector context existed, don't write it.** Every piece on
the build list in §4 fails that test if you strip the Australia/visa/aged-care
framing out — that's the tell that it's defensible. Anything above passes the
opposite test (it reads identically with or without that framing), which is
exactly why it isn't winnable for a new site.

One additional caution specific to item 5 (482 visa guide) and the visa-vs-PR
piece in segment A: stay in the job-search/CV lane. The moment content starts
asserting specific visa eligibility criteria, processing times, or legal
outcomes, it drifts into migration-agent territory — both a credibility risk
(you're not a registered migration agent) and a legal one. Cite official
Home Affairs sources for anything visa-mechanics-specific rather than
asserting it directly.
