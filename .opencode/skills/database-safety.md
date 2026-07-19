---
name: database-safety
description: "Work with the Supabase database safely. Covers migrations, RLS policies, table creation rules, Supabase client usage, and data access patterns. Use when creating tables, modifying schema, or writing database queries."
trigger: always
---

# Database Safety

## Golden Rule

**Additive changes only.** Never ALTER, DROP, or rename existing tables or columns. Only:
- INSERT new tables
- INSERT new columns (nullable or with defaults)
- INSERT new RLS policies
- INSERT new database functions (SQL RPCs)
- Extend enum value sets

This rule exists because production JobTrackr shares the same database — destructive changes break the live app.

## Migration File Convention

Location: `shared/supabase/migrations/`

Naming: `NNN_description.sql` where NNN is a zero-padded sequence number.

```sql
-- 082_add_my_feature.sql
CREATE TABLE IF NOT EXISTS my_feature (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE my_feature ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own data"
  ON my_feature FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own data"
  ON my_feature FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Indexes
CREATE INDEX idx_my_feature_user_id ON my_feature(user_id);
```

## Supabase Client Patterns

### Three clients, different purposes

| Client | File | RLS | Use for |
|--------|------|-----|---------|
| Server (cookie-bound) | `lib/supabase/server.ts` | Enforced | Server components, API routes (user context) |
| Browser | `lib/supabase/client.ts` | Enforced | Client components (Realtime subscriptions only) |
| Admin (service-role) | `lib/supabase/admin.ts` | **Bypassed** | Server-side writes where RLS lacks update policies |

### Server client (user context reads)

```typescript
import { createClient } from "@/lib/supabase/server";

const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();
const { data } = await supabase.from("jobs").select("*").eq("user_id", user.id);
```

### Admin client (server-side writes)

```typescript
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();
// Bypasses RLS — must manually verify ownership
const { data: profile } = await admin
  .from("search_profiles")
  .select("user_id")
  .eq("id", profileId)
  .single();

if (profile?.user_id !== user.id) {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// Now safe to write
await admin.from("jobs").update({ status: "applied" }).eq("id", jobId);
```

### Ownership verification pattern (required with admin client)

```typescript
// 1. Authenticate
const { user, error: authErr } = await requireUser();
if (authErr) return authErr;

// 2. Get target resource
const admin = createAdminClient();
const { data: job } = await admin
  .from("jobs").select("id, profile_id").eq("id", jobId).maybeSingle();

// 3. Verify ownership through join
const { data: profile } = await admin
  .from("search_profiles").select("user_id").eq("id", job?.profile_id).maybeSingle();

if (profile?.user_id !== user.id) {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// 4. Safe to mutate
```

## RLS Policy Patterns

### Own-data-only (most tables)

```sql
CREATE POLICY "Users can view own X"
  ON my_table FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own X"
  ON my_table FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own X"
  ON my_table FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own X"
  ON my_table FOR DELETE USING (auth.uid() = user_id);
```

### Admin bypass (for admin pages)

```sql
CREATE POLICY "Admins can view all"
  ON my_table FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role IN ('founder', 'admin')
    )
  );
```

## Common Queries

### Using Supabase Python client (backend/api)

```python
from app.database import get_supabase

supabase = get_supabase()  # Service-role singleton

# SELECT
result = supabase.table("jobs").select("id, title, jd_quality").eq("id", job_id).single().execute()

# INSERT
supabase.table("analysis_runs").insert({"run_id": run_id, "user_id": user_id}).execute()

# UPDATE
supabase.table("jobs").update({"jd_quality": "rich"}).eq("id", job_id).execute()

# RPC (database function)
result = supabase.rpc("consume_usage", {"p_user_id": user_id, "p_action": "run"}).execute()
```

### Using Supabase TypeScript client (frontend)

```typescript
// Server-side (cookie-bound)
const supabase = await createClient();
const { data, error } = await supabase
  .from("search_profiles")
  .select("id, name, is_active")
  .eq("user_id", user.id)
  .order("created_at", { ascending: false });

// Browser-side (Realtime only)
const supabase = createClient();
const channel = supabase
  .channel("changes")
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "analysis_runs" }, handler)
  .subscribe();
```

## Cache Invalidation

After writes, always invalidate the relevant cache:

```typescript
import { revalidatePath } from "next/cache";
import { revalidateTag } from "next/cache";

// Path-based (most common)
revalidatePath("/dashboard");
revalidatePath("/profiles");
revalidatePath("/", "layout");  // Revalidate entire layout

// Tag-based (for unstable_cache)
revalidateTag(`profiles-${userId}`);
revalidateTag(`preferences-${userId}`);
```

## The `unstable_cache` Pattern

Used for stable data that changes only on explicit user action:

```typescript
import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";

// Must use admin client (not cookie-bound) — cached function must be serializable
export function getCachedProfiles(userId: string) {
  return unstable_cache(
    async () => {
      const admin = createAdminClient();
      const { data } = await admin.from("search_profiles").select("*").eq("user_id", userId);
      return data ?? [];
    },
    [`profiles`, userId],
    { revalidate: 30, tags: [`profiles-${userId}`] },
  )();
}
```

## Database Functions (RPCs)

Common RPCs used in the codebase:

| Function | Purpose |
|----------|---------|
| `touch_user_engagement()` | Record user activity for engagement tracking |
| `consume_usage(p_user_id, p_action)` | Atomic metered billing deduction |
| `check_user_auth_methods(p_email)` | Detect SSO-only users (SECURITY DEFINER) |

## Anti-Patterns

- **Never** ALTER existing tables — add new tables/columns only
- **Never** use the browser Supabase client for data writes
- **Never** skip ownership verification when using the admin client
- **Never** store AI API keys in the database (encrypted in-memory only)
- **Never** use `SELECT *` in production queries — specify columns
- **Never** forget RLS policies on new tables — every table must have them
- **Never** use database triggers for business logic — keep it in application code
- **Never** create foreign keys to `auth.users(id)` without `ON DELETE CASCADE` (or appropriate action)
