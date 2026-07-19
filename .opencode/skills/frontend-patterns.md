---
name: frontend-patterns
description: "Add or modify frontend features in JobTrackr-CV. Covers Next.js App Router pages, server/client components, Tailwind 4, theme system, and UI primitives. Use when creating pages, components, or modifying the UI."
trigger: always
---

# Frontend Patterns

## Component Architecture

### Server Components (default)
Every component is a server component unless it has `"use client"` at the top.

**Server components** can:
- `async` functions, `await` data directly
- Import from `next/headers` (cookies, headers)
- Use `cookies()`, `headers()`
- Call database directly via Supabase server client

**Client components** need `"use client"` when they:
- Use React hooks (`useState`, `useEffect`, `useTransition`)
- Handle events (`onClick`, `onSubmit`)
- Use browser APIs

### Pattern: Server fetch → Client render

```tsx
// app/(dashboard)/some-page/page.tsx (SERVER)
import { createClient } from "@/lib/supabase/server";
import { SomeClient } from "@/features/some/SomeClient";

export default async function SomePage() {
  const supabase = await createClient();
  const { data } = await supabase.from("table").select("*");
  return <SomeClient items={data ?? []} />;
}
```

```tsx
// features/some/SomeClient.tsx (CLIENT)
"use client";
export function SomeClient({ items }: { items: Item[] }) {
  // hooks, interactivity here
}
```

### Pattern: Form submission with useTransition

```tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { someAction } from "@/lib/actions/some";

export function SomeForm() {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      await someAction(formData);
      router.refresh();
    });
  }

  return (
    <form action={handleSubmit}>
      {/* inputs */}
      <Button type="submit" isLoading={pending}>Save</Button>
    </form>
  );
}
```

**Never use `useActionState` or `useFormState`** — this codebase uses `useTransition` exclusively.

## Loading States

Two loader components from `components/ui/PageLoader.tsx`:

- **`<PageLoader rows={N} />`** — for table/data-heavy pages (dashboard, admin lists, job boards)
- **`<ContentLoader />`** — for form/content pages (settings, profile edit, CV review)

Create a `loading.tsx` in the route directory:

```tsx
// app/(dashboard)/some-page/loading.tsx
import { PageLoader } from "@/components/ui/PageLoader";
export default function Loading() {
  return <PageLoader rows={6} />;
}
```

## Error Boundaries

Create `error.tsx` in the route directory:

```tsx
"use client";
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="p-6 text-center">
      <h2 className="text-lg font-semibold text-text mb-2">Something went wrong</h2>
      <p className="text-sm text-text-3 mb-4">{error.message}</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
```

## Tailwind 4 (CSS-native config)

**No `tailwind.config.js`.** Theme is CSS-native via `@theme` in `globals.css`.

### Theme system
- 6 themes: `aurora-dark`, `aurora-light` (default), `classic`, `gilded-noir`, `notion`, `clay`
- Applied via `theme-*` class on `<html>` element
- CSS variables under `:root.theme-*` in `globals.css`
- Stored in `localStorage` key `jobtrackr-theme`

### Density system
- 3 levels: `compact` (0.93), `comfortable` (1.0), `spacious` (1.09)
- Applied via `data-density` attribute on `<html>`
- CSS variable: `--ui-scale`

### Color tokens (always use these)
```
text-text           Primary text
text-text-2         Secondary text
text-text-3         Muted/tertiary text
bg-surface          Card/panel background
bg-surface-2        Alternate surface
border-border       Standard borders
text-brand          Brand accent color
bg-brand            Brand background
```

### Auth pages
Auth pages (`/auth/*`) intentionally hardcode Aurora Light palette — no theme class on `<html>` pre-login. Do NOT add theme support to auth pages.

## UI Primitives (`components/ui/`)

| Component | File | Usage |
|-----------|------|-------|
| `Button` | `Button.tsx` | `variant`: default, primary, blue, danger. `size`: sm, md. `isLoading`, `icon`, `asChild` |
| `Card` | `Card.tsx` | Container with border + rounded corners |
| `Badge` | `Badge.tsx` | Status/label chips |
| `Input` | `Input.tsx` | Text input with label + error |
| `Textarea` | `Textarea.tsx` | Multiline input |
| `Select` | `Select.tsx` | Dropdown select |
| `Checkbox` | `Checkbox.tsx` | Checkbox with label |
| `Radio` | `Radio.tsx` | Radio group |
| `Modal` | `Modal.tsx` | Portal, focus trap, escape to close, scroll lock |
| `Tabs` | `Tabs.tsx` | Tab navigation |
| `PageLoader` | `PageLoader.tsx` | Table page skeleton |
| `ContentLoader` | `PageLoader.tsx` | Content page skeleton |
| `ErrorBanner` | `ErrorBanner.tsx` | Error display |

### Modal usage pattern

```tsx
import { Modal } from "@/components/ui";

<Modal open={isOpen} onClose={() => setIsOpen(false)} title="Dialog Title">
  {/* content */}
</Modal>
```

Modal handles: portal rendering, focus trap (Tab key), escape to close, body scroll lock, previous focus restore on unmount.

## Route Groups

| Group | Path | Auth | Layout |
|-------|------|------|--------|
| `(dashboard)` | `/dashboard`, `/admin`, `/cv`, etc. | Required | Sidebar + header + providers |
| `auth` | `/auth/login`, `/auth/signup` | Public | Auth shell (hardcoded Aurora Light) |
| Root | `/`, `/pricing`, `/privacy` | Public | Root layout only |

## Realtime Subscriptions

Three Supabase Realtime subscriptions exist. Pattern:

```tsx
"use client";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function LiveComponent({ id }: { id: string }) {
  const [data, setData] = useState(null);
  const supabase = createClient();
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    const channel = supabase
      .channel(`table:${id}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "target_table",
        filter: `id=eq.${id}`,
      }, (payload) => {
        if (active.current) setData(payload.new);
      })
      .subscribe();

    return () => {
      active.current = false;
      supabase.removeChannel(channel);
    };
  }, [id, supabase]);

  return <div>{/* render data */}</div>;
}
```

Always:
- Use `active.current` guard to prevent state updates after unmount
- Clean up with `supabase.removeChannel(channel)` in useEffect return
- Include a backstop poll (3-20s) for dropped Realtime events

## File Naming Conventions

- **Feature components**: `PascalCase.tsx` in `features/<domain>/components/`
- **Feature hooks**: `camelCase.ts` in `features/<domain>/hooks/`
- **Lib utilities**: `camelCase.ts` in `lib/`
- **API routes**: `route.ts` in `app/api/<domain>/`
- **Server components**: `page.tsx` in `app/<route>/`
- **Loading**: `loading.tsx` in `app/<route>/`
- **Error**: `error.tsx` in `app/<route>/`

## Anti-Patterns

- **Never** create a `tailwind.config.js` — this project uses Tailwind 4 CSS-native config
- **Never** use `sonner` or toast libraries — the project uses a custom `RunNotifier` toast system
- **Never** use `useActionState` — use `useTransition` for form submissions
- **Never** fetch Supabase directly from client components for writes — use server actions
- **Never** put `"use server"` in a helper file that exports sync functions
- **Never** add new themes without updating `globals.css`, `lib/themes.ts`, and the FOUC guard script in `app/layout.tsx`
- **Never** hardcode colors — always use CSS variable tokens (`text-text`, `bg-surface`, etc.)
