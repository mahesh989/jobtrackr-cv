---
name: server-actions
description: "Create and modify Next.js server actions in JobTrackr-CV. Covers the use server pattern, form handling, revalidation, and the barrel re-export system. Use when adding mutation logic (create, update, delete) that runs on the server."
trigger: always
---

# Server Actions

## File Structure

```
lib/actions.ts              Barrel re-export (imports all action files)
lib/actions/
  _helpers.ts               Shared helpers (NOT "use server" — exports sync functions)
  profiles.ts               Profile CRUD actions
  jobs.ts                   Job mutation actions (star, archive, apply, dismiss)
  runs.ts                   Pipeline run actions (cancel)
  invites.ts                Admin invite code actions
  applications.ts           Application review actions
lib/admin/actions.ts        Admin-specific actions (separate from user actions)
```

## Creating a Server Action

### 1. Add to the appropriate domain file

```typescript
// lib/actions/jobs.ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function markJobApplied(jobId: string) {
  // 1. Authenticate
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // 2. Ownership check (via admin client if needed)
  const admin = createAdminClient();
  const { data: job } = await admin
    .from("jobs").select("id, profile_id").eq("id", jobId).maybeSingle();
  if (!job) return;

  const { data: profile } = await admin
    .from("search_profiles").select("user_id").eq("id", job.profile_id).maybeSingle();
  if (profile?.user_id !== user.id) return;

  // 3. Mutate
  await admin.from("jobs").update({ applied_at: new Date().toISOString() }).eq("id", jobId);

  // 4. Revalidate
  revalidatePath("/dashboard");
  revalidatePath("/applications");
  revalidatePath("/profiles");
}
```

### 2. Re-export from barrel (if new file)

Only needed if creating a new action domain file:

```typescript
// lib/actions.ts
export * from "./actions/profiles";
export * from "./actions/jobs";
export * from "./actions/runs";
export * from "./actions/invites";
export * from "./actions/applications";
// Add new domain export here
```

## Action Patterns

### FormData actions (for form submissions)

```typescript
"use server";

export async function createProfile(formData: FormData) {
  const name = formData.get("name") as string;
  const location = formData.get("location") as string;

  // Validate
  if (!name?.trim()) throw new Error("Name is required");

  // Auth + mutate
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // ... insert logic ...

  revalidatePath("/profiles");
  redirect("/profiles");
}
```

### Actions with billing gates

```typescript
"use server";

import { assertCanCreateProfile, consumeRun } from "@/lib/billing/entitlements";

export async function createProfile(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // Billing gate — throws with user-friendly message if denied
  await assertCanCreateProfile(user.id);

  // ... create profile ...

  revalidatePath("/profiles");
  redirect("/profiles");
}
```

### Actions calling the Python backend

```typescript
"use server";

import { startAnalysis } from "@/lib/cvBackend";

export async function analyzeJob(runId: string, cvVersionId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  // Get AI credentials
  const { provider, apiKey, model } = await getActiveAiCredentials();

  // Call Python backend (HMAC-signed)
  await startAnalysis({
    run_id: runId,
    user_id: user.id,
    cv_version_id: cvVersionId,
    ai_provider: provider,
    ai_api_key: apiKey,
    ai_model: model,
  });

  revalidatePath("/dashboard");
}
```

## Client-Side Usage

### With useTransition (preferred)

```tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { markJobApplied } from "@/lib/actions";
import { Button } from "@/components/ui";

export function ApplyButton({ jobId }: { jobId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      isLoading={pending}
      onClick={() => startTransition(async () => {
        await markJobApplied(jobId);
        router.refresh();
      })}
    >
      Mark Applied
    </Button>
  );
}
```

### With form action

```tsx
"use client";
import { useTransition } from "react";
import { createProfile } from "@/lib/actions";

export function ProfileForm() {
  const [pending, startTransition] = useTransition();

  return (
    <form action={(formData) => startTransition(() => createProfile(formData))}>
      <input name="name" />
      <button type="submit" disabled={pending}>
        {pending ? "Creating..." : "Create Profile"}
      </button>
    </form>
  );
}
```

## Helper Functions (`_helpers.ts`)

The `_helpers.ts` file is NOT marked `"use server"` — it exports sync and async helpers used by action files:

```typescript
// lib/actions/_helpers.ts
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";

export async function authedClient() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");
  return { supabase, user };
}
```

**Never put `"use server"` in `_helpers.ts`** — it exports sync functions that would break.

## Revalidation Rules

| Action | Revalidate |
|--------|------------|
| Profile CRUD | `/profiles`, `/dashboard` |
| Job star/archive/apply/dismiss | `/dashboard`, `/applications`, `/profiles`, `/profiles/[id]/jobs` |
| Run cancel | `/dashboard`, `/profiles/[id]/runs` |
| Invite generate/revoke | `/admin` |
| Application review | `/applications` |
| CV upload/activate | `/cv` |
| Preferences update | Tag: `preferences-${userId}` |

## Anti-Patterns

- **Never** use `"use server"` in `_helpers.ts` (sync exports break)
- **Never** forget `revalidatePath` after a mutation — stale data is worse than no data
- **Never** return sensitive data from server actions (API keys, tokens)
- **Never** skip authentication — every action must verify the user
- **Never** skip ownership verification when using the admin client
- **Never** use `redirect()` inside a `try/catch` — it throws a special error that gets caught
- **Never** call server actions from other server actions directly — call the underlying function instead
