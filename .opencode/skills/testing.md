---
name: testing
description: "Write and run tests in JobTrackr-CV. Covers pytest (Python backend), vitest (Node worker), golden regression harnesses, mocking patterns, and when to write tests. Use at the START of every task to plan test coverage, and before commits to verify."
trigger: always
---

# Testing & Verification

## Core Principle

**Every task that changes behavior should include tests.** Tests are not optional polish — they are part of the deliverable. Write tests at the start of the task (TDD-lite), not as an afterthought.

## Test Inventory

| Service | Framework | Files | Test Count | Lines |
|---------|-----------|-------|-----------|-------|
| Backend API | pytest | 47 | ~974 `def test_*` | ~13,900 |
| Worker | vitest | 15 | ~117 `it()` | ~1,360 |
| Frontend | **None** | 0 | 0 | 0 |
| **Total** | | **62** | **~1,091** | **~15,260** |

**No CI pipeline exists.** Tests run locally only.

## Test Design Philosophy

This codebase follows three distinctive principles:

### 1. Regression-driven (every test cites its origin)

Every Python test file's docstring names the specific production incident, user, date, or LLM run that motivated it. This is documentation, not ceremony.

```python
"""Pinned from a live CV where the structurizer collapsed the 'Education' and
'Professional Development' sections into one, losing the degree listing.

Regression: CV from user X, 2025-03-14, run Y.
"""
```

### 2. Pure-function focus (no live DB, no live AI, no network)

Both Python and TypeScript tests test deterministic, side-effect-free functions. External dependencies (Supabase, Redis, AI providers) are always mocked.

### 3. Self-contained test files (no shared fixtures)

Every test file is standalone. No shared factory library, no shared fixture files (except the golden corpus). The `NormalisedJob` factory is copy-pasted across 6 worker test files with local `job()` helpers.

## Python Tests (backend/api)

### Running

```bash
cd backend/api && python -m pytest                    # All tests
cd backend/api && python -m pytest tests/test_foo.py  # Single file
cd backend/api && python -m pytest -x                 # Stop on first failure
cd backend/api && python -m pytest -v                 # Verbose output
```

### conftest.py

Every test session loads `backend/api/tests/conftest.py` which sets dummy env vars:

```python
import os
os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_ANON_KEY", "test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
os.environ.setdefault("JOBTRACKR_HMAC_SECRET", "test-secret")
```

This lets app modules import without real secrets. Tests that need the Supabase client mock it.

### Pattern: Inline fixtures as constants

```python
"""Regression: CV structurizer collapsed Education and Professional Development
sections into one, losing the degree listing.
Regression: user X, 2025-03-14, run Y.
"""
from app.services.cv.cv_structurizer import structurise_cv

RAW_CV = """John Doe
Education
Bachelor of Nursing, University of Sydney, 2018
Professional Development
ALS Certification, 2022"""

class TestEducationSplit:
    def test_degree_preserved(self):
        result = structurise_cv(RAW_CV)
        assert "Bachelor of Nursing" in str(result.education)

    def test_certification_preserved(self):
        result = structurise_cv(RAW_CV)
        assert "ALS Certification" in str(result.professional_development)
```

**Always use real production data as fixtures.** The fixture IS the regression test.

### Pattern: Class-based grouping

```python
class TestAtsScoring:
    """Suite of ATS scoring edge cases from production runs."""

    def test_empty_jd_scores_zero(self):
        result = score_ats("", "Some CV text")
        assert result == 0

    def test_matching_keyword_boosts_score(self):
        result = score_ats("Python developer", "Experienced Python developer")
        assert result > 50
```

### Pattern: Function-based standalone

```python
def test_format_cost_basic():
    assert format_cost(1500) == "$1.50"

def test_format_cost_zero():
    assert format_cost(0) == "$0.00"
```

### Pattern: Parametrized tests

```python
@pytest.mark.parametrize("input,expected", [
    ("pdf", True),
    ("docx", True),
    ("exe", False),
    ("txt", False),
])
def test_allowed_extensions(input, expected):
    assert is_allowed_extension(input) == expected
```

### Pattern: Mocking AI client

```python
from unittest.mock import AsyncMock, MagicMock

async def test_structurize_with_mock_ai():
    mock_client = MagicMock()
    mock_client.complete_json = AsyncMock(return_value={
        "summary": "...",
        "education": [...],
    })
    result = await structurise_cv(cv_text, mock_client)
    assert result.summary == "..."
```

### Pattern: Route surface test

```python
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

EXPECTED_ROUTES = [
    ("POST", "/internal/analyze"),
    ("POST", "/internal/extract-cv-text"),
    # ... all internal routes
]

def test_all_internal_routes_registered():
    registered = {(m, r.path) for r in app.routes
                  for m in getattr(r, "methods", set()) or set()}
    for method, path in EXPECTED_ROUTES:
        assert (method, path) in registered

def test_every_internal_route_rejects_unsigned_request():
    for method, path in EXPECTED_ROUTES:
        resp = client.request(method, path, json={})
        assert resp.status_code in (401, 403)
```

## TypeScript Tests (worker)

### Running

```bash
cd backend/worker && npx vitest run                    # All tests
cd backend/worker && npx vitest run src/pipeline/dedup.test.ts  # Single file
cd backend/worker && npx vitest run -t "test name"    # By name
```

### Pattern: vi.mock before dynamic import

Always mock dependencies BEFORE importing the module under test:

```typescript
import { describe, it, expect, vi } from "vitest";

// Mock Supabase client (throws at import time without env vars)
vi.mock("../db/client.js", () => ({ db: {} }));

// Dynamic import AFTER mock setup
const { computeHashes } = await import("./dedup.js");
```

### Pattern: Inline factory function

Every test file defines its own `job()` helper:

```typescript
import type { NormalisedJob } from "./types.js";

function job(url: string): NormalisedJob {
  return {
    url,
    url_hash: "",
    content_hash: "",
    title: "Registered Nurse",
    company: "Acme",
    location: "Sydney NSW",
    description: "",
    source: "seek",
    source_tier: 1,
    posted_at: null,
    expires_at: null,
    keywords_matched: [],
    dedup_status: "original",
    duplicate_of: null,
    repost_of: null,
    sponsorship_status: "not_mentioned",
    citizen_pr_only: null,
    visa_extracted_text: null,
    setting_category: null,
    setting_confidence: null,
    setting_evidence: null,
    distance_km: null,
    distance_method: null,
  };
}
```

### Pattern: In-memory store as mock

```typescript
const store = new Map<string, string>();
vi.mock("./connection.js", () => ({
  connection: {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    }),
  },
}));

const { startHeartbeat } = await import("./heartbeat.js");
```

### Pattern: Fake timers

```typescript
beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("refreshes key on timer", async () => {
  const hb = startHeartbeat();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(store.get(key)).not.toBe(firstValue);
});
```

## Golden/Regression Harnesses

### JD precision/recall (`tests/golden/`)

```bash
cd backend/api && python -m pytest tests/test_golden_jd_mock.py -v
```

- Loads Markdown corpus from `tests/golden/jds/*.md` with YAML frontmatter
- Loads recorded LLM outputs from `tests/golden/fixtures/*.json`
- Runs deterministic post-process chain
- Computes precision/recall per category
- Thresholds pinned at 1.00 (zero hallucination tolerance)

### Rendered CV snapshot diff

```bash
cd backend/api && python -m pytest tests/test_golden_rendered_sections.py -v
```

- Loads raw markdown + feasibility JSON from `tests/golden/rendered/`
- Runs `_enforce_structure()` + `_inject_missing_skills()` deterministic chain
- Compares output against committed JSON snapshots
- Use `--record` flag to re-snapshot

## Verification Checklist

### Frontend changes

```bash
cd frontend/web && npx tsc --noEmit    # Types (run after every change)
cd frontend/web && npm run lint        # Lint
cd frontend/web && npm run build       # Build (slower, catches SSR issues)
```

**Zero frontend tests exist.** If you're adding significant frontend logic (filtering, scoring, transforms), consider adding tests.

### Backend API changes

```bash
cd backend/api && python -m pytest -x   # All tests (stop on first failure)
```

If your change:
- Adds a new endpoint → add to `test_internal_route_surface.py` EXPECTED list
- Adds a service function → write unit tests with inline fixtures
- Changes AI prompts → update golden fixtures if precision/recall affected
- Fixes a bug → add regression test with the reproduction case

### Worker changes

```bash
cd backend/worker && npx tsc --noEmit   # Types
cd backend/worker && npx vitest run     # Tests
```

If your change:
- Adds a pipeline step → write unit test with `vi.mock()` for DB
- Modifies a filter → add edge case tests
- Changes timer logic → use `vi.useFakeTimers()`

## When to Write Tests

### At task START (planning phase)

Before writing code, plan test coverage:
1. What functions will you add/modify?
2. What are the edge cases?
3. What existing tests might break?
4. Write the test file structure first

### During implementation

Write tests alongside (or just after) the implementation. The codebase pattern is:
- Implement the function
- Write 2-5 regression tests with real production data
- Run to verify

### Before commit

Always run the full test suite:
```bash
cd backend/api && python -m pytest -x && cd ../worker && npx vitest run && cd ../../frontend/web && npx tsc --noEmit
```

## Adding Tests for New Code

### New Python service function

1. Create `backend/api/tests/test_<module>.py`
2. Add docstring citing regression origin
3. Define inline fixtures (real data from production if possible)
4. Write tests covering: happy path, edge cases, error cases
5. Run `python -m pytest tests/test_<module>.py -v`

### New TypeScript module

1. Create `backend/worker/src/<path>/<module>.test.ts`
2. `vi.mock()` all external dependencies (DB, Redis, etc.)
3. Dynamic `await import()` the module under test
4. Define local `job()` factory if testing pipeline types
5. Write `describe()` / `it()` blocks
6. Run `npx vitest run src/<path>/<module>.test.ts`

### New API endpoint

1. Add `("POST", "/internal/my-endpoint")` to `test_internal_route_surface.py` EXPECTED list
2. Write request/response validation tests
3. Write ownership verification tests
4. Write rate limiting tests

## Anti-Patterns

- **Never** skip writing tests because "it's a small change" — small changes break things
- **Never** write tests that depend on external services (live DB, live AI)
- **Never** use shared fixtures across test files — keep each file self-contained
- **Never** use `asyncio.run()` in Python tests — use the `_run(coro)` pattern or pytest-asyncio
- **Never** import the module under test before `vi.mock()` in TypeScript
- **Never** use `setTimeout` in tests — use `vi.useFakeTimers()`
- **Never** test implementation details — test behavior and outputs
- **Never** leave flaky tests — if it passes sometimes, fix the test
