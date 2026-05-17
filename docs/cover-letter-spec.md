# Cover Letter Generation System — Specification

## Executive Framing

The cover letter is the highest-leverage, lowest-effort feature in JobTrackr. CVs are tailored mechanically; cover letters require judgement. That is where AI tools fail today and where defensibility lives.

This spec assumes a target of producing letters that are statistically indistinguishable from genuine human writing, grounded in real user history and real company facts, and that scale to hundreds of thousands of users without degrading per-user uniqueness.

**Defining principle:** the user's data must outweigh the system prompt in shaping output. Generic prompts produce generic letters. Heavy per-user grounding produces letters that vary across users even when the same model runs the same pipeline.

---

## Part 1 — Data Model

### Per-user, captured once at onboarding

**Voice profile** — extracted from a writing sample, stored permanently, refined over time.

```json
{
  "user_id": "string",
  "voice_sample_raw": "text",
  "voice_sample_source": "enum [pre_ai_essay, journal, linkedin_about, in_app_capture, audio_transcript]",
  "voice_sample_trust_score": "float",

  "fingerprint": {
    "avg_sentence_length": "float",
    "sentence_length_stddev": "float",
    "uses_contractions": "bool",
    "uses_em_dashes": "bool",
    "uses_semicolons": "bool",
    "uses_parentheticals": "bool",
    "formality_score": "float (0.0 casual → 1.0 formal)",
    "vocabulary_complexity": "enum [simple, moderate, elevated]",
    "avg_syllables_per_word": "float",
    "paragraph_opener_patterns": ["So", "Looking back", "The thing is"],
    "intensifier_words": ["pretty", "quite", "really"],
    "sentence_starter_variety": "float (unique first words / total sentences)",
    "rhetorical_devices": ["em-dash asides", "short fragments", "rhetorical questions"],
    "tells": ["3-5 specific quirks in natural language"]
  },

  "why_statement": "text (one sentence: 'Why are you in this field?')",

  "story_library": [
    {
      "title": "string",
      "domain": "string",
      "year": "int",
      "one_line": "string",
      "detailed": "text (100-200 words)",
      "numbers": [{ "metric": "string", "value": "string" }],
      "tags": ["leadership", "technical", "client_facing", "crisis_management"]
    }
  ],

  "master_cv_extracted": {
    "roles": "...",
    "skills": "...",
    "achievements": "...",
    "education": "...",
    "side_projects": "..."
  }
}
```

### Per-company, cached across all users

**Company research** — researched once when the first user applies, reused forever with periodic refresh.

```json
{
  "company_id": "string (canonical, deduped e.g. 'lendlease_au')",
  "name": "string",
  "domain": "string",
  "last_researched_at": "timestamp",
  "research_ttl_days": "int (default 90)",

  "facts": {
    "description_short": "string",
    "industry": "string",
    "size": "enum [startup, small, mid, large, enterprise]",
    "headquarters": "string",
    "recent_events": [
      { "date": "...", "event": "...", "source_url": "...", "relevance_to_applicants": "..." }
    ],
    "products_or_services": ["string"],
    "mission_statement": "string (exact quote from their site)",
    "distinguishing_facts": ["3-5 specifics that are not generic"]
  },

  "voice_signals": {
    "tone": "enum [formal_corporate, professional_warm, casual_startup, technical, mission_driven]",
    "sample_text": "text (200 words pulled from their About / blog)",
    "common_vocabulary": ["string"],
    "avoids": ["string"]
  },

  "hiring_intel": {
    "hiring_manager_likely": "string",
    "team_blog_posts": ["url"],
    "recent_hires_titles": ["string"]
  }
}
```

This caching is critical at scale. If 500 users apply to JLL, JLL is researched once. The user-specific layer (which story to tell, which voice to mimic) is what differs per letter.

### Per-letter, generated and stored

```json
{
  "letter_id": "string",
  "user_id": "string",
  "company_id": "string",
  "job_id": "string",
  "job_description": "text",

  "generation": {
    "company_hook_chosen": "string (the specific company fact referenced)",
    "story_chosen_id": "string (which story from library)",
    "tone_target": "enum",
    "word_count_target": "int",

    "pass_1_skeleton": "text",
    "pass_2_voice_transferred": "text",
    "pass_3_final": "text",

    "naturalness_score": "float",
    "specificity_score": "float",
    "coherence_with_cv_score": "float"
  },

  "user_edits": "text (what they changed before sending)",
  "edit_diff": "object (structured diff for learning)",

  "outcome": "enum [draft, sent, replied, interview, rejected, hired]"
}
```

The `user_edits` field is the long-term goldmine — it is how the voice profile evolves.

---

## Part 2 — Voice Capture Flow

The most important onboarding step in the entire app. Get this right and every letter for the rest of the user's lifetime is better.

### Framing presented to the user

> **Your writing voice — captured once, used forever**
>
> Every cover letter we generate will sound exactly as human as the writing sample you give us next. If the sample sounds like ChatGPT, every letter will too. If it sounds like you, every letter will.
>
> This is the highest-leverage 3 minutes you'll spend in this app.

### Three capture options, in order of preference

**Option 1 — Upload pre-2022 writing**

Essays, theses, blog posts, journal entries. Accepts PDF, DOCX, TXT, MD. 150 word minimum. Scan for AI patterns; warn if the sample fails the smell test.

**Option 2 — Write 150 words now**

Prompt: *"Tell me about a project, job, or moment from your life that you're proud of. Don't polish it. Write like you're telling a friend over coffee. No AI, no Googling — this only works if it's genuinely you."*

Constraints in the textarea:
- Paste is disabled
- Keystroke timing captured (as a signal, not a block)
- Minimum 150 words to submit
- Inline counter: words, time elapsed, typing rhythm

**Option 3 — Record yourself talking for 90 seconds**

Same prompt as Option 2, but spoken. Transcribe. Spoken language has natural burstiness baked in.

### Trust scoring

After capture, the sample is scored before fingerprint extraction:

```
trust_score = weighted_sum(
  source_credibility,        // pre-2022 file > audio > in-app type > paste
  ai_pattern_score,          // does it have AI tells?
  typing_rhythm_score,       // did they type or paste?
  length_appropriateness,    // 150-300 words ideal
  sentence_variance          // bursty = trustworthy
)
```

If trust score is low, show soft warning:

> "This sample looks like it might have been AI-assisted. That's okay — but your cover letters will reflect this. Want to try again with something else?"

Never block. Always show the cost of the choice.

### Fingerprint extraction call

One model call, structured output. Use Claude Opus or GPT-5.2 — taste-heavy task, worth the quality.

Prompt structure:
```
Analyse this writing sample for voice fingerprint extraction.

Sample: [text]

Return a structured JSON profile:
1. Quantitative metrics (avg sentence length, stddev, syllables/word, etc.)
2. Stylistic flags (contractions, em-dashes, semicolons, parentheticals)
3. Formality score 0-1
4. Three to five specific "tells" — quirks unique to this writer that a 
   skilled mimic could replicate. Examples: "tends to start paragraphs 
   with concrete examples before stating the point", "uses 'thing' as 
   a placeholder noun", "rarely uses adjectives".
5. Common intensifier words this person uses
6. Paragraph opener patterns
7. Three example sentences from the sample that best capture their voice

Be specific. "Casual tone" is useless. "Uses contractions in 80% of 
auxiliary verbs and prefers em-dashes over commas for asides" is useful.
```

---

## Part 3 — Company Research Pipeline

Researched once per company, cached, refreshed every 90 days or on-demand.

### Trigger

First user applies to a company → research job queues → completes in background within 60 seconds → cached → all subsequent users for that company get cached version instantly.

### What gets fetched

- Their own website — About, Mission, Careers, recent blog posts
- Recent news (last 6 months) — via web search, filtered for substance over PR fluff
- LinkedIn company page — size, recent hires, industry positioning
- The hiring manager if discoverable — name, title, brief bio
- Sample of their public writing — 200 words from their blog or About, to capture tone

### What gets distilled

A model pass that turns raw research into the structured `facts`, `voice_signals`, and `hiring_intel` objects. Critically, this pass is instructed to prefer concrete over praise:

```
Extract company facts that would be useful in a cover letter opener.

Bad facts (do not return): "innovative leader in their field", 
"committed to excellence", "industry pioneer"

Good facts (return): "Launched IoT sensor integration across their 
Sydney portfolio in March 2026", "Recently moved their engineering 
team to a four-day week", "CEO previously founded TechCo before joining 
in 2023"

Return 5-7 concrete facts ranked by specificity.
```

### Fact selection step (per-letter)

When generating a letter, pull the cached company facts and let a model select the best one to anchor on, given the user's CV:

```
Given:
- This user's master CV: [extracted]
- The job description: [text]
- These 7 company facts: [list]

Pick the ONE fact most likely to land as a cover letter opener for this 
specific user. Consider: does the user have experience that would make 
this fact feel relevant to mention? Does referencing it create a natural 
bridge to their qualifications?
```

So the same company has 7 facts cached, but different users naturally anchor on different facts based on their background. Generic at the storage layer, personalised at the selection layer.

---

## Part 4 — Generation Pipeline

> **Note on model names:** Model identifiers in this section (Haiku 4.5, Opus 4.7, GPT-5.2, GPT-5.2-mini) are illustrative. Resolve against the live ProviderPicker model list and current provider catalogue before implementation. See graph.json BUG-2 for context on why this matters.

Three passes. Each has a specific job. Do not try to do everything in one prompt.

### Pass 1 — Skeleton draft

Cheap model (Haiku 4.5 or GPT-5.2-mini). Output is intentionally bland.

```
Generate a 170-word cover letter skeleton.

Role: [title]
Company: [name]
Company hook: [the one selected fact]
JD top priorities: [extracted from JD]
User's relevant story: [selected from story library]
User's tailored CV summary: [3-line summary]

Structure required:
- Paragraph 1: 2 sentences. Open with the company hook. Bridge to user.
- Paragraph 2: 4-5 sentences. The selected story with concrete numbers.
- Paragraph 3: 1-2 sentences. Brief close. No "I look forward to hearing".

Output plain prose. No flourishes. Just bones.
Word count: 160-180.
```

### Pass 2 — Voice transfer

Expensive model (Claude Opus 4.7 or GPT-5.2). This is where the money is spent because this is where the magic happens.

```
Here is a writing sample from the candidate. Study it carefully:
[150-200 word sample, verbatim]

Here is their voice fingerprint:
- Average sentence length: [X] words, stddev [Y]
- Uses contractions: [yes/no]
- Uses em-dashes: [yes/no]
- Formality score: [0-1]
- Specific tells: [list]
- Paragraph opener patterns: [list]

Here is a draft cover letter:
[Pass 1 output]

Rewrite this draft so it sounds like the same person who wrote the sample.

Critical requirements:
1. Keep every fact identical. Invent nothing.
2. Match their sentence length distribution.
3. Use their tells where natural — but don't force them in unnaturally.
4. Match their formality register.
5. If they use contractions, use contractions. If not, don't.
6. Adjust vocabulary complexity to match theirs.
7. Replace any AI-typical phrasing with how this person would actually say it.

Output the rewritten letter only.
```

### Pass 3 — Burstiness and imperfection injection

Cheap model. Cleanup and humanisation pass.

```
Here is a cover letter:
[Pass 2 output]

Make these specific edits to make it feel more human:

1. Sentence variance check: ensure at least one sentence is under 8 words 
   and at least one is over 20 words. No three consecutive sentences within 
   5 words of each other in length.

2. Include exactly one of these (the most natural fit):
   - A sentence fragment for emphasis
   - An em-dash aside
   - A parenthetical remark
   - A paragraph that starts with a conjunction (And, But, So)

3. Banned phrase check. Replace if present:
   "I am writing to express", "I am excited", "passionate", "synergy",
   "leverage", "track record", "results-driven", "proven", "dynamic", 
   "robust", "I look forward to hearing", "in today's", "fast-paced",
   "Furthermore", "Additionally", "Moreover"

4. Specificity check: the letter must contain at least one concrete number, 
   name, or place from the candidate's experience. If missing, add one.

5. Opener check: must not start with "I am writing", "I'm reaching out", 
   "Dear Hiring Manager, I am", or any variation.

Output the final letter only. No commentary.
```

### Why three passes and not one

Single-prompt generation forces the model to juggle dozens of constraints simultaneously, which is exactly when LLMs produce mediocre output. Decomposing the work into three focused passes — content, voice, polish — produces measurably better results and lets you mix model tiers (cheap-expensive-cheap) to control cost.

---

## Part 5 — Quality Gates

Three automated checks before showing the user anything.

### Gate 1 — Honesty check

Every claim in the letter must trace to the master CV. Separate model call:

```
Letter: [final output]
Master CV: [full text]

For each factual claim in the letter (numbers, achievements, dates, roles, 
skills), verify it appears in the master CV or is a reasonable summary of 
something that does. Return: pass/fail with list of unsupported claims.
```

If fail, regenerate Pass 1 with stricter grounding.

### Gate 2 — Coherence check

The letter's vocabulary and complexity must roughly match the user's CV. A massive vocabulary gap between CV and letter is a red flag.

### Gate 3 — Statistical signature check

Compute burstiness and sentence variance on the output. If too uniform, send back to Pass 3 with stricter instructions. Deterministic check, not a model call.

```python
sentence_lengths = [len(s) for s in sentences]
burstiness = stddev(sentence_lengths) / mean(sentence_lengths)
if burstiness < 0.4: fail  # too uniform, sounds AI
if burstiness > 1.2: fail  # too erratic
```

Human writing in cover letters tends to land between 0.5 and 1.0. Tune with real data.

---

## Part 6 — Delivery to the User

### What the user sees

Not a generated letter dropped on them. A structured reveal:

1. **The company hook** — shown first, with its source link. *"We anchored your letter on this fact about JLL. [verify]"*
2. **The story chosen** — *"We picked your operations role at Next Phase. Want to use a different story?"*
3. **The letter itself** — single column, clean typography, editable inline
4. **A naturalness indicator** — small badge showing the burstiness score relative to human writing. Not a "score out of 10". A simple "Reads as natural" / "Reads as a bit AI-ish" with an explanation if clicked.

### The one optional choice

A single dropdown: tone (Professional / Warm / Direct). Default to whatever the company `voice_signals` suggest. Changing it triggers regeneration of Pass 2 only.

Everything else is single-draft. No "generate 5 variants and pick".

### The edit experience

When the user edits, capture the diff. Every edit is a signal. After 5+ letters with edits, the system has data on:

- Which words this user consistently replaces
- Which structures they prefer
- Whether they tend to make letters shorter or longer

This feeds back into their voice profile. Their fingerprint refines over time.

---

## Part 7 — Scale Architecture

### Caching strategy

| Asset | Cache scope | TTL | Reason |
|-------|-------------|-----|--------|
| User voice profile | Per user | Forever | Computed once, refines via edits |
| Company research | Global | 90 days | Companies do not change weekly |
| Company fact selection | Per user-company pair | 30 days | Personalises cached research |
| Pass 1 skeleton | Per job description hash | 7 days | Same JD = same skeleton |
| Final letter | Per user-job pair | Forever | Idempotent generation |

This caching is why the unit economics work at 100k users. The expensive work (research, fingerprinting) is amortised. Per-letter cost falls dramatically with scale.

### Cost model per letter

Rough estimates assuming current pricing:

- Pass 1: ~$0.001 (cheap model, short context)
- Pass 2: ~$0.015 (expensive model, this is the magic)
- Pass 3: ~$0.001 (cheap model)
- Quality gates: ~$0.003 (cheap model, three checks)
- **Per-letter cost: ~$0.020**

Company research is amortised across all applicants. At 500 applicants per company, research cost is negligible per letter.

Voice fingerprint is a one-time ~$0.05 cost amortised over the lifetime of the user.

### Database

Postgres for user data, voice profiles, letters. Redis for hot caches (company facts, recent fingerprints). Object storage for raw writing samples (encrypted at rest).

**Critical:** per-user isolation must be airtight. One user's writing sample must never appear in another user's generation context. Enforced at the application layer with explicit `user_id` checks, not just at the database level.

### Model routing

Build a router that picks based on:
- User's plan tier
- Current API availability and latency
- Cost ceiling per user per month

Do not hardcode a model per pass. Insulate the product from any single provider's pricing or availability.

---

## Part 8 — Feedback Loop

Every interaction generates signal. Capture it.

| Event | Signal captured | How it feeds back |
|-------|----------------|-------------------|
| User edits letter before sending | Edit diff | Refines voice fingerprint |
| User regenerates with different tone | Tone preference | Updates default tone |
| User marks letter as "sent" | Outcome tracking begins | Foundation for response-rate analytics |
| User reports interview from letter | Positive outcome | Letter pattern marked as effective |
| User reports rejection | Negative outcome | Letter pattern downweighted |
| User picks a different story | Story relevance signal | Refines story-to-JD matching |

After 6 months and tens of thousands of letters with outcomes, you have something nobody else does: empirical data on which letter patterns produce interviews. That becomes the moat.

---

## Part 9 — Responsible Launch

Three non-negotiables before going live:

1. **Honesty enforcement is bulletproof.** A letter that invents a credential could end someone's job application or worse. The honesty gate must be tested adversarially before launch. No claim can appear in a letter that is not traceable to the master CV.

2. **Privacy on writing samples is explicit.** Users uploading journal entries are sharing intimate writing. Encryption at rest, never used for model training, explicit user consent, easy deletion.

3. **The "this is AI-assisted" disclosure question is settled.** Some industries auto-reject suspected AI letters. The app should detect when a user is applying in a high-risk industry (legal, defence, finance) and surface this — not block, just inform. Let the user decide.

---

## Part 10 — Build Order

Six phases. Each phase ships independently. Phase 1 is a standalone deliverable that ships in one session.

### Phase 1 — Voice fingerprint module
- Voice sample capture flow (the three options)
- Fingerprint extraction model call + structured output
- Storage in `voice_profiles` table
- Onboarding UI

### Phase 2 — Story library
- Master CV extraction into structured story objects
- Story tagging and indexing
- Story-to-JD matching algorithm

### Phase 3 — Company research pipeline
- Web search + scraping per company
- Distillation into structured facts + `voice_signals`
- Caching layer with TTL refresh
- Fact selection per-letter

### Phase 4 — Generation pipeline
- Three-pass generation orchestration
- Model routing layer
- Per-pass prompt files (under `cv-backend/app/services/ai/prompts/cover_letter/`)

### Phase 5 — Quality gates
- Honesty check (claims traceable to master CV)
- Coherence check (vocabulary match)
- Statistical signature check (burstiness, sentence variance)

### Phase 6 — Delivery UI
- Structured reveal flow (hook → story → letter → naturalness)
- Tone dropdown
- Inline editing with diff capture
- Naturalness indicator

Each phase has its own `/plan` → execute → `/audit` → `/ship` cycle. Cross-phase work (e.g. `cover_letters` table migration) lands with the first phase that needs it.

---

## Framing Principle

The product framing — internal and external — is: **we help you write a better cover letter than you would have written yourself, using your own voice and your own facts.**

Not: we help you fool recruiters with AI.

The first framing scales. The second is fragile. Build it as the first.
