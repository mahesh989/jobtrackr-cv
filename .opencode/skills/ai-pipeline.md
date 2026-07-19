---
name: ai-pipeline
description: "Work with the 7-step CV analysis pipeline in backend/api. Covers pipeline orchestration, step implementation, AI client usage, scoring, and cover letter generation. Use when modifying the analysis pipeline, adding steps, or working with AI-powered features."
trigger: backend
---

# AI Pipeline

## Architecture

The pipeline lives in `backend/api/app/services/pipeline/` and runs as a BackgroundTask triggered by `POST /internal/analyze`.

```
Frontend → POST /api/jobs/[id]/analyze → HMAC → POST /internal/analyze
                                                  ↓
                                          BackgroundTask (202 Accepted)
                                                  ↓
                                          orchestrator.run_analysis()
                                                  ↓
                                          7 steps (semaphore-bounded, concurrency 4)
```

## The 7 Steps

| # | Step | Type | What it does |
|---|------|------|-------------|
| 1 | JD Analysis | AI call | Analyse job description: skills, requirements, seniority, visa |
| 2 | CV↔JD Matching | AI call | Match CV against JD, identify gaps and strengths |
| 3 | ATS Scoring | Deterministic | Applicant Tracking System compatibility score (0-100) |
| 4 | Input Recommendations | Deterministic | Quick wins and suggestions based on matching |
| 5 | Keyword Feasibility | AI call | Determine which missed keywords can be legitimately surfaced |
| 6 | AI Recommendations | AI call | Detailed tailoring recommendations |
| 7 | Tailored CV | AI + enforce | Generate tailored CV with deterministic enforcement |

**Post-pipeline:**
- Step 6.5: Tailored rescoring (deterministic)
- Step 6.6: Structural validation
- Auto cover letter trigger when final score >= 70

## Gate System

- **Initial ATS gate** (default 60): If step 3 score < 50, pipeline stops before tailoring (saves ~3 AI calls)
- **Final ATS gate** (default 70): Determines if tailored CV is "passed"
- **Per-vertical overrides**: Healthcare/nursing uses lower thresholds (40 initial, 60 final)

## Pipeline Orchestrator

`backend/api/app/services/pipeline/orchestrator.py` (668 lines)

Key patterns:
- **Semaphore-bounded concurrency** (default 4) for parallel AI calls
- **Cancellation polling**: Checks DB for user-initiated stop before each expensive step
- **Resume support**: Reuses cached early-step outputs when resuming failed runs
- **Step state management**: Each step writes progress to `analysis_runs.step_states`

```python
# Simplified orchestrator flow
async def run_analysis(run_id: str, ...):
    async with asyncio.Semaphore(4):
        # Step 1: JD Analysis
        jd_analysis = await step_jd_analysis(jd_text, ai_client)

        # Step 2: CV-JD Matching
        matching = await step_cv_jd_matching(cv_text, jd_analysis, ai_client)

        # Step 3: ATS Scoring (deterministic)
        ats_score = step_ats_scoring(jd_analysis, matching)

        # Gate check
        if ats_score < settings.min_initial_ats:
            return  # Stop early

        # Steps 4-7...
```

## Adding a New Pipeline Step

### 1. Create step file

```python
# backend/api/app/services/pipeline/steps/my_step.py
from app.services.ai.client import AIClient

async def step_my_feature(
    input_data: dict,
    ai_client: AIClient,
) -> MyStepResult:
    """Step description."""
    result = await ai_client.complete_json(
        system="Prompt template here...",
        user=f"Process this: {input_data}",
        max_tokens=4096,
    )
    return MyStepResult(**result)
```

### 2. Register in orchestrator

```python
# In orchestrator.py
from app.services.pipeline.steps.my_step import step_my_feature

# Add to run_analysis() at the appropriate position
my_result = await step_my_feature(prev_step_data, ai_client)
```

### 3. Add step state tracking

```python
# Update step state in analysis_runs
await update_step_state(run_id, "my_step", StepState.RUNNING)
# ... run step ...
await update_step_state(run_id, "my_step", StepState.COMPLETED)
```

## AI Client

`backend/api/app/services/ai/client.py` (755 lines)

### Creating a client

```python
from app.services.ai.client import make_ai_client

client = make_ai_client(
    provider="anthropic",  # or "openai", "deepseek"
    api_key="sk-...",
    model="claude-sonnet-4-6",  # optional, uses default if None
)
```

### Text completion

```python
result = await client.complete(
    system="You are a CV analyst.",
    user=f"Analyse this CV: {cv_text}",
    max_tokens=4096,
    temperature=0.3,
)
```

### JSON completion (with auto-retry)

```python
data = await client.complete_json(
    system="Extract skills from this CV as JSON.",
    user=cv_text,
    response_model=SkillList,  # Optional Pydantic validation
    max_tokens=4096,
)
```

JSON completion handles:
- Markdown fence stripping
- Strict JSON parsing
- Balanced `{...}` extraction
- `json_repair` tolerant repair
- Up to 3 auto-retries

### Error handling

```python
from app.services.ai.client import (
    AIClientError,      # General AI error → 422
    AIBillingError,     # Billing issue (has top-up URL)
    AIRateLimitError,   # Rate limited (retry later)
    AIJSONParseError,   # JSON parse failed (auto-retries)
)
```

## Cover Letter Pipeline

`backend/api/app/services/cover_letter/generator.py`

3-pass pipeline:
1. **Skeleton**: Generate structured cover letter from JD + CV + voice
2. **Voice rewrite**: Apply user's writing voice fingerprint
3. **Burstiness**: Add natural sentence length variation

Triggered automatically when final ATS score >= 70.

## Deterministic Enforcement

`backend/api/app/services/eval/` contains writers that enforce rules without AI:

- `enforce.py` / `enforce_w3.py` / `enforce_w8.py` — Rule enforcement
- `grounding.py` — Evidence verification
- `verify.py` — Entailment verification
- `honesty_guard.py` — Prevent overclaiming
- `injection.py` — Detect prompt injection

## Prompt Templates

All AI prompts live in `backend/api/app/services/ai/prompts/`:

```
prompts/
  cv_jd_matching.py
  cv_skill_categorisation.py
  cv_structurization.py
  jd_analysis.py
  keyword_feasibility.py
  tailored_cv.py
  ai_recommendations.py
  cover_letter/           # Cover letter generation prompts
  variants/               # Opening variant prompts
```

**Pattern:** Prompts are Python functions that return system/user message strings:

```python
def jd_analysis_prompt(jd_text: str) -> tuple[str, str]:
    system = """You are a job description analyst..."""
    user = f"""Analyse this job description:
    
{jd_text}

Return JSON with the following structure: ..."""
    return system, user
```

## Anti-Patterns

- **Never** hardcode AI provider/model in step files — use `make_ai_client()` with passed credentials
- **Never** log `voice_sample_text` — it's sensitive user content
- **Never** persist AI API keys — held in memory for pipeline lifetime only
- **Never** skip the semaphore — unbounded concurrency will hit AI rate limits
- **Never** skip cancellation checks — users must be able to stop long-running analyses
- **Never** use synchronous AI calls — all must be `async`
- **Never** catch `AIJSONParseError` and give up — the client auto-retries 3 times
- **Never** modify the pipeline orchestrator without understanding the step dependency chain
