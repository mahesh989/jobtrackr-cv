---
name: type-system
description: "Work with the JobTrackr-CV type system. Covers canonical types, constants, avoiding duplicates, and the correct import sources. Use when creating new types, importing existing ones, or refactoring type definitions."
trigger: always
---

# Type System

## Canonical Sources

Every type and constant has ONE canonical location. Always import from there.

| Category | File | Types/Exports |
|----------|------|---------------|
| Shared types | `lib/types.ts` | `ContactDetails`, `SkillCategory`, `CategorisedSkills`, `ProfileCredentials`, `ToneTarget`, `StoryNumber`, `RoleFamily`, `FAMILY_LABELS`, `Project`, `AVAILABILITY_OPTIONS` |
| Enums/constants | `lib/constants.ts` | `RunStatus`, `StepState`, `ADMIN_ROLES`, `VisaStatus`, `EmploymentType`, `JOB_SOURCES`, `TIER_DEFAULTS`, `SourceTier`, `AdzunaMethod`, `SeekMethod`, `TierConfig` |
| AI providers | `lib/ai/models.ts` | `AiProvider`, `PROVIDER_ORDER`, `PROVIDER_META`, `DEFAULT_MODELS`, `ProviderModelMeta` |
| Eligibility | `lib/eligibility.ts` | `Eligibility`, `UserVisaStatus`, `computeEligibility`, `hoursCapConflict` |
| Voice types | `features/cv/voice/types.ts` | `SourceTag` |
| Setup status | `lib/setupStatus.ts` | `SetupStatus`, `SetupStepKey` |
| Billing | `lib/billing/plans.ts` | `PlanId`, `SubStatus`, `PUBLIC_PLANS`, `TRIAL_DAYS`, `formatAud` |
| ATS thresholds | `lib/atsThresholds.ts` | `MIN_INITIAL_ATS`, `MIN_FINAL_ATS`, `AtsThresholds`, `resolveThresholds` |

## Rules

1. **Never define duplicate types** — always check if a type already exists in a canonical source before defining it
2. **Never define duplicate constants** — check `lib/constants.ts` first
3. **Re-export from canonical** — if a feature needs a shared type, import from `@/lib/types` and re-export if needed
4. **Feature-local types** go in `features/<domain>/types.ts` — only for types specific to that feature
5. **Types used across features** MUST be in `lib/types.ts`

## Pattern: Adding a New Shared Type

```typescript
// 1. Add to lib/types.ts
export interface NewThing {
  id: string;
  name: string;
  status: "active" | "inactive";
}

// 2. Import wherever needed
import type { NewThing } from "@/lib/types";
```

## Pattern: Adding a New Constant/Enum

```typescript
// 1. Add to lib/constants.ts using `as const` (not TypeScript enum)
export const NewStatus = {
  PENDING: "pending",
  ACTIVE: "active",
  FAILED: "failed",
} as const;

export type NewStatus = (typeof NewStatus)[keyof typeof NewStatus];

// 2. Import wherever needed
import { NewStatus } from "@/lib/constants";
```

**Always use `as const` objects, never TypeScript `enum`.** This matches the codebase convention.

## Pattern: Adding a New AI Provider

```typescript
// 1. Add to lib/ai/models.ts
type AiProvider = "anthropic" | "openai" | "deepseek" | "new_provider";

const PROVIDER_META: Record<AiProvider, ProviderModelMeta> = {
  // ...existing...
  new_provider: {
    label: "New Provider",
    color: "#hex",
    models: ["model-1", "model-2"],
    defaultModel: "model-1",
    helpUrl: "https://...",
  },
};
```

## Import Conventions

### Correct imports

```typescript
// Types from canonical source
import type { ContactDetails, SkillCategory } from "@/lib/types";
import { RunStatus, StepState } from "@/lib/constants";
import { AiProvider, PROVIDER_META } from "@/lib/ai/models";
import { computeEligibility } from "@/lib/eligibility";

// UI components from barrel
import { Button, Card, Badge, Modal } from "@/components/ui";

// Supabase clients
import { createClient } from "@/lib/supabase/server";      // Server
import { createClient } from "@/lib/supabase/client";      // Browser
import { createAdminClient } from "@/lib/supabase/admin";  // Admin

// Auth guards
import { requireUser } from "@/lib/api-utils";             // API routes
import { requireAdmin } from "@/lib/admin/guard";          // Server components

// Server actions
import { markJobApplied } from "@/lib/actions";
```

### Wrong imports (anti-patterns)

```typescript
// NEVER — duplicate type definition
interface ContactDetails { name: string; phone: string; }  // Already in lib/types.ts

// NEVER — import from wrong location
import { RunStatus } from "@/features/some-feature/types";  // Use @/lib/constants

// NEVER — import server-only in client code
import { createClient } from "@/lib/supabase/server";  // In a "use client" file

// NEVER — import admin client in client code
import { createAdminClient } from "@/lib/supabase/admin";  // In a "use client" file
```

## Backend Type Conventions

Python types use Pydantic models in `backend/api/app/schemas/`:

```python
from pydantic import BaseModel, Field

class MyRequest(BaseModel):
    user_id: str
    input_text: str = Field(min_length=1)
    max_tokens: int = 4096

class MyResponse(BaseModel):
    result: str
    confidence: float
```

Backend enums in `backend/api/app/enums.py`:

```python
from enum import Enum

class Provider(str, Enum):
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    DEEPSEEK = "deepseek"
```

## Anti-Patterns

- **Never** define a type that already exists in a canonical source
- **Never** use TypeScript `enum` — use `as const` objects
- **Never** import from barrel files that re-export everything (`export *`) without checking what's actually exported
- **Never** create circular imports between `lib/` files
- **Never** put shared types in feature-specific files
- **Never** use `any` type — use `unknown` and narrow
- **Never** duplicate backend types in frontend code — they evolve independently
